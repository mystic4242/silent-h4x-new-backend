const express = require('express');
const { pool, query } = require('../db');
const { customerAuth } = require('../middleware/auth');
const { decrypt } = require('../services/crypto');

const router = express.Router();
router.use(customerAuth);

router.post('/', async (req, res, next) => {
  const productId = Number(req.body?.productId);
  const hours = Number(req.body?.durationHours);

  if (!Number.isSafeInteger(productId) || productId < 1 ||
      ![2, 48, 168, 720].includes(hours)) {
    return res.status(400).json({
      success: false,
      message: 'Select a valid product and duration.'
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const productResult = await client.query(
      `SELECT p.id, p.name, d.price
       FROM products p
       JOIN product_durations d ON d.product_id = p.id
       WHERE p.id = $1 AND p.status = 'active'
         AND d.duration_hours = $2 AND d.active = TRUE
       FOR UPDATE OF p, d`,
      [productId, hours]
    );

    if (!productResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Product or selected duration is unavailable.'
      });
    }

    const product = productResult.rows[0];

    const walletResult = await client.query(
      'SELECT balance FROM wallets WHERE customer_id = $1 FOR UPDATE',
      [req.auth.id]
    );

    if (!walletResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Wallet not found.'
      });
    }

    const balance = Number(walletResult.rows[0].balance);
    const price = Number(product.price);

    if (!Number.isSafeInteger(price) || price < 0 || balance < price) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Insufficient wallet balance.',
        balance
      });
    }

    const orderResult = await client.query(
      `INSERT INTO orders
       (customer_id, product_id, duration_hours, price_paid, status)
       VALUES ($1, $2, $3, $4, 'pending_fulfillment')
       RETURNING id, created_at`,
      [req.auth.id, productId, hours, price]
    );

    const order = orderResult.rows[0];

    await client.query(
      `UPDATE wallets
       SET balance = balance - $2, updated_at = NOW()
       WHERE customer_id = $1`,
      [req.auth.id, price]
    );

    await client.query(
      `INSERT INTO wallet_transactions
       (customer_id, transaction_type, amount, direction,
        description, reference)
       VALUES ($1, 'purchase', $2, 'debit', $3, $4)`,
      [
        req.auth.id,
        price,
        `Purchase: ${product.name} (${hours} hours)`,
        `order:${order.id}`
      ]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      message: 'Purchase received. Awaiting fulfillment.',
      order: {
        id: order.id,
        productName: product.name,
        durationHours: hours,
        amount: price,
        status: 'pending_fulfillment',
        createdAt: order.created_at
      }
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

router.get('/keys', async (req, res, next) => {
  try {
    const [keys, orders] = await Promise.all([
      query(
        `SELECT g.id, g.order_id, g.key_prefix, g.status,
                g.expires_at, g.created_at,
                p.name AS product_name, o.duration_hours
         FROM generated_keys g
         JOIN products p ON p.id = g.product_id
         JOIN orders o ON o.id = g.order_id
         WHERE g.customer_id = $1
         ORDER BY g.created_at DESC`,
        [req.auth.id]
      ),
      query(
        `SELECT o.id, o.product_id, o.duration_hours,
                o.price_paid, o.status, o.created_at,
                p.name AS product_name
         FROM orders o
         JOIN products p ON p.id = o.product_id
         WHERE o.customer_id = $1
           AND o.status = 'pending_fulfillment'
         ORDER BY o.created_at DESC`,
        [req.auth.id]
      )
    ]);

    res.json({
      success: true,
      keys: keys.rows,
      pendingOrders: orders.rows
    });
  } catch (err) {
    next(err);
  }
});

router.post('/keys/:id/reveal', async (req, res, next) => {
  const keyId = Number(req.params.id);

  if (!Number.isSafeInteger(keyId) || keyId < 1) {
    return res.status(400).json({
      success: false,
      message: 'Invalid key ID.'
    });
  }

  try {
    const result = await query(
      `SELECT id, encrypted_key, status, expires_at
       FROM generated_keys
       WHERE id = $1 AND customer_id = $2`,
      [keyId, req.auth.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: 'Key not found.'
      });
    }

    const key = result.rows[0];

    if (key.status !== 'active' ||
        new Date(key.expires_at) <= new Date()) {
      return res.status(410).json({
        success: false,
        message: 'This key is expired or inactive.'
      });
    }

    if (!key.encrypted_key) {
      return res.status(410).json({
        success: false,
        message: 'Key cannot be revealed.'
      });
    }

    const plaintext = decrypt(key.encrypted_key);

    await query(
      `UPDATE generated_keys
       SET revealed_at = NOW()
       WHERE id = $1 AND customer_id = $2`,
      [keyId, req.auth.id]
    );

    res.json({ success: true, key: plaintext });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
