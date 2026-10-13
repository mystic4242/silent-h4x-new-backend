const express = require('express');
const crypto = require('crypto');
const { pool, query } = require('../db');
const { customerAuth } = require('../middleware/auth');

const router = express.Router();
router.use(customerAuth);

router.get('/', async (req, res, next) => {
  try {
    const wallet = await query(
      'SELECT balance, updated_at FROM wallets WHERE customer_id = $1',
      [req.auth.id]
    );

    if (!wallet.rowCount) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found.'
      });
    }

    const transactions = await query(
      `SELECT id, transaction_type, amount, direction,
              description, reference, created_at
       FROM wallet_transactions
       WHERE customer_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.auth.id]
    );

    res.json({
      success: true,
      wallet: wallet.rows[0],
      transactions: transactions.rows
    });
  } catch (err) {
    next(err);
  }
});

router.post('/topup', async (req, res, next) => {
  const amount = Number(req.body?.amount);

  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100000000) {
    return res.status(400).json({
      success: false,
      message: 'Amount must be between 100 and 100,000,000.'
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const settingsResult = await client.query(
      `SELECT setting_key, setting_value
       FROM app_settings
       WHERE setting_key = ANY($1::text[])`,
      [[
        'bank_name',
        'bank_account_name',
        'bank_account_number',
        'customer_care_whatsapp'
      ]]
    );

    const settings = {};
    for (const row of settingsResult.rows) {
      settings[row.setting_key] = row.setting_value;
    }

    const reference =
      'SHX-' + crypto.randomBytes(8).toString('hex').toUpperCase();

    const payment = await client.query(
      `INSERT INTO payment_requests
       (customer_id, amount, payment_reference, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, amount, payment_reference, status, created_at`,
      [req.auth.id, amount, reference]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      payment: payment.rows[0],
      bank: {
        name: settings.bank_name || '',
        accountName: settings.bank_account_name || '',
        accountNumber: settings.bank_account_number || ''
      },
      customerCareWhatsApp: settings.customer_care_whatsapp || ''
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

router.get('/topups', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, amount, payment_reference, status,
              created_at, reviewed_at, admin_note
       FROM payment_requests
       WHERE customer_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.auth.id]
    );

    res.json({ success: true, payments: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
