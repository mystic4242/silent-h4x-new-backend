const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db');
const { adminAuth } = require('../middleware/auth');

const router = express.Router();

router.use(adminAuth);

router.post('/:customerId/adjust', async (req, res, next) => {
  const customerId = Number(req.params.customerId);
  const amount = Number(req.body?.amount);
  const reason = String(req.body?.reason || '').trim().slice(0, 300);

  if (
    !Number.isSafeInteger(customerId) ||
    customerId < 1 ||
    !Number.isSafeInteger(amount) ||
    amount === 0 ||
    Math.abs(amount) > 1000000000 ||
    reason.length < 3
  ) {
    return res.status(400).json({
      success: false,
      message: 'Provide a valid customer, adjustment, and reason.'
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT balance FROM wallets WHERE customer_id = $1 FOR UPDATE',
      [customerId]
    );

    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Wallet not found.'
      });
    }

    const balance = Number(result.rows[0].balance);

    if (balance + amount < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Adjustment would make the wallet negative.'
      });
    }

    await client.query(
      `UPDATE wallets
       SET balance = balance + $2, updated_at = NOW()
       WHERE customer_id = $1`,
      [customerId, amount]
    );

    await client.query(
      `INSERT INTO wallet_transactions
       (customer_id, transaction_type, amount, direction,
        description, reference, created_by_admin)
       VALUES ($1, 'adjustment', $2, $3, $4, $5, $6)`,
      [
        customerId,
        Math.abs(amount),
        amount > 0 ? 'credit' : 'debit',
        'Admin adjustment: ' + reason,
        `admin-adjustment:${crypto.randomUUID()}`,
        req.auth.id
      ]
    );

    await client.query(
      `INSERT INTO audit_logs
       (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, 'wallet.adjusted', 'customer', $2, $3::jsonb)`,
      [
        req.auth.id,
        customerId,
        JSON.stringify({ amount, reason })
      ]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Wallet adjusted.'
    });
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    next(err);
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
