const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { adminAuth } = require('../middleware/auth');
const { hashSecret } = require('../services/crypto');

const router = express.Router();
router.use(adminAuth);

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.display_name, c.status, c.created_at,
              COALESCE(w.balance, 0) AS balance,
              COUNT(DISTINCT k.id) AS access_key_count
       FROM customers c
       LEFT JOIN wallets w ON w.customer_id = c.id
       LEFT JOIN customer_access_keys k ON k.customer_id = c.id
       GROUP BY c.id, w.balance
       ORDER BY c.created_at DESC
       LIMIT 300`
    );
    res.json({ success: true, customers: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const displayName = String(req.body?.displayName || '').trim();
  const referralCode = String(req.body?.referralCode || '').trim();

  if (displayName.length < 2 || displayName.length > 80) {
    return res.status(400).json({
      success: false,
      message: 'Display name must contain 2–80 characters.'
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    let referrer = null;
    let referralProfileId = null;

    if (referralCode) {
      const ref = await client.query(
        `SELECT id, customer_id
         FROM referral_profiles
         WHERE referral_code = $1`,
        [referralCode]
      );

      if (!ref.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Referral code was not found.'
        });
      }

      referrer = ref.rows[0].customer_id;
      referralProfileId = ref.rows[0].id;
    }

    const customerResult = await client.query(
      `INSERT INTO customers (display_name, status, referred_by)
       VALUES ($1, 'active', $2)
       RETURNING id, display_name, status, created_at`,
      [displayName, referrer]
    );

    const customer = customerResult.rows[0];

    await client.query(
      'INSERT INTO wallets (customer_id, balance) VALUES ($1, 0)',
      [customer.id]
    );

    const accessKey =
      'SHX-' + crypto.randomBytes(24).toString('hex').toUpperCase();

    await client.query(
      `INSERT INTO customer_access_keys
       (customer_id, key_hash, key_prefix, status)
       VALUES ($1, $2, $3, 'active')`,
      [customer.id, hashSecret(accessKey), accessKey.slice(0, 12)]
    );

    if (referralProfileId) {
      await client.query(
        `INSERT INTO referral_attributions
         (referral_profile_id, referred_customer_id,
          attributed_at, attribution_expires_at)
         VALUES ($1, $2, NOW(), NOW() + INTERVAL '30 days')
         ON CONFLICT (referred_customer_id) DO NOTHING`,
        [referralProfileId, customer.id]
      );

      await client.query(
        `INSERT INTO referral_events
         (referral_profile_id, event_type, visitor_hash, path)
         VALUES ($1, 'conversion', $2, $3)`,
        [
          referralProfileId,
          'customer:' + customer.id,
          '/admin/customer-created'
        ]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, 'customer.created', 'customer', $2, $3::jsonb)`,
      [
        req.auth.id,
        customer.id,
        JSON.stringify({ displayName, referred: Boolean(referralCode) })
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      customer,
      accessKey,
      warning: 'Copy and deliver this access key securely. It is shown only once.'
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

router.post('/:id/access-keys', async (req, res, next) => {
  const customerId = Number(req.params.id);

  if (!Number.isSafeInteger(customerId) || customerId < 1) {
    return res.status(400).json({ success: false, message: 'Invalid customer ID.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const customer = await client.query(
      "SELECT id FROM customers WHERE id = $1 AND status = 'active' FOR UPDATE",
      [customerId]
    );

    if (!customer.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Active customer not found.'
      });
    }

    const accessKey =
      'SHX-' + crypto.randomBytes(24).toString('hex').toUpperCase();

    await client.query(
      `INSERT INTO customer_access_keys
       (customer_id, key_hash, key_prefix, status)
       VALUES ($1, $2, $3, 'active')`,
      [customerId, hashSecret(accessKey), accessKey.slice(0, 12)]
    );

    await client.query(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, 'customer.access_key_created', 'customer', $2, '{}'::jsonb)`,
      [req.auth.id, customerId]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      accessKey,
      warning: 'This key is shown only once.'
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

router.get('/:id/access-keys', async (req, res, next) => {
  const customerId = Number(req.params.id);

  if (!Number.isSafeInteger(customerId) || customerId < 1) {
    return res.status(400).json({ success: false, message: 'Invalid customer ID.' });
  }

  try {
    const result = await pool.query(
      `SELECT id, key_prefix, status, created_at, expires_at, last_used_at
       FROM customer_access_keys
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [customerId]
    );
    res.json({ success: true, accessKeys: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/:customerId/access-keys/:keyId/revoke', async (req, res, next) => {
  const customerId = Number(req.params.customerId);
  const keyId = Number(req.params.keyId);

  if (!Number.isSafeInteger(customerId) || customerId < 1 ||
      !Number.isSafeInteger(keyId) || keyId < 1) {
    return res.status(400).json({ success: false, message: 'Invalid IDs.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE customer_access_keys
       SET status = 'revoked', revoked_at = NOW()
       WHERE id = $1 AND customer_id = $2 AND status = 'active'
       RETURNING id`,
      [keyId, customerId]
    );

    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Active access key not found.'
      });
    }

    await client.query(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, 'customer.access_key_revoked', 'customer_access_key', $2, $3::jsonb)`,
      [req.auth.id, keyId, JSON.stringify({ customerId })]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Access key revoked.' });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

router.post('/:id/status', async (req, res, next) => {
  const customerId = Number(req.params.id);
  const status = req.body?.status;

  if (!Number.isSafeInteger(customerId) || customerId < 1 ||
      !['active', 'suspended'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid customer or status.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const result = await client.query(
      'UPDATE customers SET status = $2 WHERE id = $1 RETURNING id, status',
      [customerId, status]
    );

    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    await client.query(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, 'customer.status_changed', 'customer', $2, $3::jsonb)`,
      [req.auth.id, customerId, JSON.stringify({ status })]
    );

    await client.query('COMMIT');
    res.json({ success: true, customer: result.rows[0] });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
