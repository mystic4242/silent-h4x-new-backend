const express = require('express');
const db = require('../db');
const { adminAuth } = require('../middleware/auth');

const router = express.Router();
router.use(adminAuth);

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT p.*, c.display_name
      FROM payment_requests p
      JOIN customers c ON c.id = p.customer_id
      ORDER BY p.created_at DESC
      LIMIT 300
    `);
    res.json({ success: true, payments: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/approve', async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const payment = await client.query(
      `SELECT * FROM payment_requests
       WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );

    if (!payment.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false, message: 'Payment request not found'
      });
    }

    const p = payment.rows[0];

    if (p.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false, message: 'Payment already reviewed'
      });
    }

    await client.query(
      `INSERT INTO wallets (customer_id, balance)
       VALUES ($1, 0)
       ON CONFLICT (customer_id) DO NOTHING`,
      [p.customer_id]
    );

    await client.query(
      `UPDATE wallets
       SET balance = balance + $1, updated_at = NOW()
       WHERE customer_id = $2`,
      [p.amount, p.customer_id]
    );

    await client.query(
      `UPDATE payment_requests
       SET status = 'approved',
           reviewed_by = $1,
           reviewed_at = NOW(),
           admin_note = $2
       WHERE id = $3`,
      [req.auth.id, req.body.adminNote || null, p.id]
    );

    await client.query(
      `INSERT INTO wallet_transactions
       (customer_id, transaction_type, amount, direction,
        reference, description, created_by_admin)
       VALUES ($1, 'topup', $2, 'credit', $3, $4, $5)`,
      [
        p.customer_id,
        p.amount,
        `payment:${p.id}`,
        'Approved manual wallet top-up',
        req.auth.id
      ]
    );

    await client.query(
      `INSERT INTO audit_logs
       (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, 'payment_approved', 'payment_request', $2, $3)`,
      [req.auth.id, p.id, JSON.stringify({ amount: p.amount })]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Payment approved and wallet credited' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/:id/reject', async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE payment_requests
       SET status = 'rejected',
           admin_note = $1,
           reviewed_by = $2,
           reviewed_at = NOW()
       WHERE id = $3 AND status = 'pending'
       RETURNING id`,
      [
        String(req.body.adminNote || 'Rejected by admin').slice(0, 1000),
        req.auth.id,
        req.params.id
      ]
    );

    if (!result.rowCount) {
      return res.status(409).json({
        success: false,
        message: 'Payment not found or already reviewed'
      });
    }

    await db.query(
      `INSERT INTO audit_logs
       (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, 'payment_rejected', 'payment_request', $2, $3)`,
      [req.auth.id, result.rows[0].id,
       JSON.stringify({ note: req.body.adminNote || '' })]
    );

    res.json({ success: true, message: 'Payment rejected' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
