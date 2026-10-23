const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('../db');
const { hashSecret } = require('../services/crypto');
const { createSession, deleteSession } = require('../services/sessions');
const { customerAuth, readCookie } = require('../middleware/auth');

const router = express.Router();
const scrypt = promisify(crypto.scrypt);

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

async function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

async function passwordMatches(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  try {
    const expected = Buffer.from(parts[2], 'hex');
    if (expected.length !== 64) return false;
    const actual = await scrypt(password, parts[1], 64);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

router.post('/register', loginLimiter, async (req, res, next) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  const displayName = String(req.body?.displayName || '').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
  }
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    return res.status(400).json({ success: false, message: 'Password must be 10–128 characters.' });
  }
  if (displayName.length > 80) {
    return res.status(400).json({ success: false, message: 'Display name is too long.' });
  }

  let client;
  try {
    const hashed = await passwordHash(password);
    client = await db.pool.connect();
    await client.query('BEGIN');

    const created = await client.query(
      `INSERT INTO customers (email, password_hash, display_name, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id, email, display_name, status, created_at`,
      [email, hashed, displayName || email.split('@')[0]]
    );

    const customer = created.rows[0];
    await client.query(
      'INSERT INTO wallets (customer_id, balance) VALUES ($1, 0)',
      [customer.id]
    );

    await client.query('COMMIT');
    const token = await createSession('customer', customer.id);
    setCookie(res, token);

    return res.status(201).json({
      success: true,
      message: 'Account created.',
      customer
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'An account with that email already exists.' });
    }
    next(err);
  } finally {
    if (client) client.release();
  }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;

    if (email && typeof password === 'string') {
      const result = await db.query(
        `SELECT id, password_hash, status
           FROM customers
          WHERE LOWER(email) = $1
          LIMIT 1`,
        [email]
      );

      if (!result.rowCount ||
          result.rows[0].status !== 'active' ||
          !(await passwordMatches(password, result.rows[0].password_hash))) {
        return res.status(401).json({ success: false, message: 'Invalid email or password.' });
      }

      const token = await createSession('customer', result.rows[0].id);
      setCookie(res, token);
      return res.json({ success: true, message: 'Login successful.' });
    }

    // Temporary compatibility for existing access-key accounts.
    const accessKey = req.body?.accessKey;
    if (typeof accessKey !== 'string' || accessKey.length < 16 || accessKey.length > 256) {
      return res.status(400).json({ success: false, message: 'Enter your email and password.' });
    }

    const result = await db.query(
      `SELECT ak.id AS access_key_id, ak.customer_id, c.status AS customer_status
         FROM customer_access_keys ak
         JOIN customers c ON c.id = ak.customer_id
        WHERE ak.key_hash = $1 AND ak.status = 'active'
          AND (ak.expires_at IS NULL OR ak.expires_at > NOW())
        LIMIT 1`,
      [hashSecret(accessKey)]
    );

    if (!result.rowCount || result.rows[0].customer_status !== 'active') {
      return res.status(401).json({ success: false, message: 'Invalid login details.' });
    }

    const customer = result.rows[0];
    const token = await createSession('customer', customer.customer_id);
    await db.query('UPDATE customer_access_keys SET last_used_at = NOW() WHERE id = $1', [customer.access_key_id]);
    setCookie(res, token);
    return res.json({ success: true, message: 'Login successful.' });
  } catch (err) {
    next(err);
  }
});

router.get('/me', customerAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.email, c.display_name, c.status, w.balance, c.created_at
         FROM customers c
         JOIN wallets w ON w.customer_id = c.id
        WHERE c.id = $1`,
      [req.auth.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }
    res.json({ success: true, customer: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = readCookie(req, 'silent_customer_sid');
    if (token) await deleteSession('customer', token);
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
