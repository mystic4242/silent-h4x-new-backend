const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { adminAuth } = require('../middleware/auth');
const { hashSecret, encrypt } = require('../services/crypto');

router.use(adminAuth);

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.id, o.customer_id, c.display_name,
             o.product_id, p.name AS product_name,
             o.duration_hours, o.price_paid, o.status,
             o.created_at, g.id AS generated_key_id,
             g.key_prefix, g.expires_at
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = o.product_id
      LEFT JOIN generated_keys g ON g.order_id = o.id
      ORDER BY
        CASE WHEN o.status = 'pending_fulfillment'
          THEN 0 ELSE 1 END,
        o.created_at DESC
      LIMIT 500
    `);

    res.json({ success: true, orders: result.rows });
  } catch (err) {
    console.error('Admin orders:', err.message);
    res.status(500).json({
      success: false,
      message: 'Could not load orders.'
    });
  }
});

router.post('/:id/fulfill', async (req, res) => {
  const orderId = Number(req.params.id);
  const productKey = typeof req.body?.productKey === 'string'
    ? req.body.productKey.trim()
    : '';

  if (!Number.isSafeInteger(orderId) || orderId < 1) {
    return res.status(400).json({
      success: false, message: 'Invalid order ID.'
    });
  }

  if (productKey.length < 4 || productKey.length > 500) {
    return res.status(400).json({
      success: false, message: 'Enter a valid product key.'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const found = await client.query(
      `SELECT o.*
       FROM orders o
       WHERE o.id = $1
       FOR UPDATE`,
      [orderId]
    );

    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false, message: 'Order not found.'
      });
    }

    const order = found.rows[0];

    if (order.status !== 'pending_fulfillment') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'Order is not awaiting fulfillment.'
      });
    }

    const keyHash = hashSecret(productKey);
    const encryptedKey = encrypt(productKey);
    const keyPrefix = productKey.slice(0, 10);
    const expiresAt = new Date(
      new Date(order.created_at).getTime() +
      Number(order.duration_hours) * 3600000
    );

    await client.query(
      `INSERT INTO generated_keys
       (order_id, customer_id, product_id, key_hash,
        key_prefix, encrypted_key, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
      [
        order.id, order.customer_id, order.product_id,
        keyHash, keyPrefix, encryptedKey, expiresAt
      ]
    );

    await client.query(
      `UPDATE orders SET status = 'completed' WHERE id = $1`,
      [orderId]
    );

    await client.query(
      `INSERT INTO audit_logs
       (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, 'order_fulfilled', 'order', $2, $3::jsonb)`,
      [
        req.auth.id,
        String(orderId),
        JSON.stringify({
          customerId: order.customer_id,
          productId: order.product_id,
          durationHours: order.duration_hours,
          keyPrefix
        })
      ]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Product key assigned successfully.',
      orderId
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Fulfillment error:', err.message);

    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'This product key or order assignment already exists.'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Could not fulfill order.'
    });
  } finally {
    client.release();
  }
});

module.exports = router;
