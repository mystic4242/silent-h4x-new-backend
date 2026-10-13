const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { customerAuth, adminAuth } = require('../middleware/auth');
const {
  createProfile,
  recordEvent,
  getLeaderboard
} = require('../services/referrals');

const router = express.Router();

function visitorHash(req) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return crypto.createHash('sha256')
    .update(ip + ':' + (req.get('user-agent') || 'unknown'))
    .digest('hex');
}

router.get('/leaderboard', async (req, res, next) => {
  try {
    const rows = await getLeaderboard(20);
    res.json({ success: true, leaderboard: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/me', customerAuth, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT referral_code, display_name, created_at
       FROM referral_profiles
       WHERE customer_id = $1`,
      [req.auth.id]
    );

    if (result.rowCount) {
      return res.json({ success: true, profile: result.rows[0] });
    }

    const customer = await query(
      'SELECT display_name FROM customers WHERE id = $1',
      [req.auth.id]
    );

    if (!customer.rowCount) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found.'
      });
    }

    const profile = await createProfile(
      req.auth.id,
      customer.rows[0].display_name || 'Customer'
    );

    res.json({ success: true, profile });
  } catch (err) {
    next(err);
  }
});

router.post('/event', async (req, res, next) => {
  try {
    const { code, eventType, path } = req.body || {};

    if (
      typeof code !== 'string' ||
      !/^[A-Za-z0-9_-]{6,40}$/.test(code) ||
      !['visit', 'whatsapp_click'].includes(eventType)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid referral event.'
      });
    }

    const recorded = await recordEvent(
      code,
      eventType,
      visitorHash(req),
      typeof path === 'string' ? path.slice(0, 300) : '/'
    );

    if (!recorded) {
      return res.status(404).json({
        success: false,
        message: 'Referral code not found.'
      });
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/* Admin-only conversion attribution.
   Use this when creating a customer from a WhatsApp referral lead. */
router.post('/attribute', adminAuth, async (req, res, next) => {
  const { customerId, referralCode } = req.body || {};

  if (!Number.isInteger(Number(customerId)) ||
      typeof referralCode !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Customer ID and referral code are required.'
    });
  }

  const client = require('../db').pool;
  let connection;

  try {
    connection = await client.connect();
    await connection.query('BEGIN');

    const profile = await connection.query(
      `SELECT id, customer_id
       FROM referral_profiles
       WHERE referral_code = $1`,
      [referralCode]
    );

    if (!profile.rowCount) {
      await connection.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Referral code not found.'
      });
    }

    const referrerId = profile.rows[0].customer_id;
    const newCustomerId = Number(customerId);

    if (referrerId === newCustomerId) {
      await connection.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Self-referrals are not allowed.'
      });
    }

    const customer = await connection.query(
      'SELECT id, referred_by FROM customers WHERE id = $1 FOR UPDATE',
      [newCustomerId]
    );

    if (!customer.rowCount) {
      await connection.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Customer not found.'
      });
    }

    if (customer.rows[0].referred_by) {
      await connection.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'Customer already has a referrer.'
      });
    }

    await connection.query(
      'UPDATE customers SET referred_by = $1 WHERE id = $2',
      [referrerId, newCustomerId]
    );

    await connection.query(
      `INSERT INTO referral_attributions
       (referral_profile_id, referred_customer_id,
        first_visit_at, attributed_at, attribution_expires_at)
       VALUES ($1, $2, NOW(), NOW(), NOW() + INTERVAL '30 days')
       ON CONFLICT (referred_customer_id) DO NOTHING`,
      [profile.rows[0].id, newCustomerId]
    );

    await connection.query(
      `INSERT INTO referral_events
       (referral_profile_id, event_type, visitor_token_hash, landing_path)
       VALUES ($1, 'conversion', $2, $3)`,
      [
        profile.rows[0].id,
        'customer:' + newCustomerId,
        '/admin/customer-created'
      ]
    );

    await connection.query('COMMIT');
    res.json({ success: true, message: 'Referral attributed.' });
  } catch (err) {
    if (connection) {
      await connection.query('ROLLBACK').catch(() => {});
    }
    next(err);
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
