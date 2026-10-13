const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { hashSecret } = require('../services/crypto');
const { createSession, deleteSession } = require('../services/sessions');
const { customerAuth, readCookie } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

function setCookie(res, token) {
  res.cookie('silent_customer_sid', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const accessKey = req.body?.accessKey;

    if (
      typeof accessKey !== 'string' ||
      accessKey.length < 16 ||
      accessKey.length > 256
    ) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid access key.'
      });
    }

    const result = await db.query(
      `SELECT ak.id AS access_key_id,
              ak.customer_id,
              c.status AS customer_status
         FROM customer_access_keys ak
         JOIN customers c ON c.id = ak.customer_id
        WHERE ak.key_hash = $1
          AND ak.status = 'active'
          AND (ak.expires_at IS NULL OR ak.expires_at > NOW())
        LIMIT 1`,
      [hashSecret(accessKey)]
    );

    if (
      !result.rowCount ||
      result.rows[0].customer_status !== 'active'
    ) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or revoked access key.'
      });
    }

    const customer = result.rows[0];
    const token = await createSession('customer', customer.customer_id);

    await db.query(
      `UPDATE customer_access_keys
          SET last_used_at = NOW()
        WHERE id = $1`,
      [customer.access_key_id]
    );

    setCookie(res, token);

    return res.json({
      success: true,
      message: 'Login successful.'
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', customerAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.display_name, c.status,
              w.balance, c.created_at
         FROM customers c
         JOIN wallets w ON w.customer_id = c.id
        WHERE c.id = $1`,
      [req.auth.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found.'
      });
    }

    res.json({
      success: true,
      customer: result.rows[0]
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = readCookie(req, 'silent_customer_sid');

    if (token) {
      await deleteSession('customer', token);
    }

    res.clearCookie('silent_customer_sid', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/'
    });

    res.json({ success: true, message: 'Logged out.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
