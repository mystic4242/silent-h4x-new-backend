const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { createSession, deleteSession } = require('../services/sessions');
const { adminAuth, readCookie } = require('../middleware/auth');

const router = express.Router();

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

function safeCompare(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  return a.length === b.length &&
    a.length > 0 &&
    crypto.timingSafeEqual(a, b);
}

router.post('/login', adminLoginLimiter, async (req, res, next) => {
  try {
    const adminKey = req.body?.adminKey;
    const configuredKey = process.env.ADMIN_LOGIN_KEY;

    if (!configuredKey) {
      return res.status(503).json({
        success: false,
        message: 'Admin authentication is not configured.'
      });
    }

    if (!safeCompare(adminKey, configuredKey)) {
      return res.status(401).json({
        success: false,
        message: 'Invalid admin authentication key.'
      });
    }

    const result = await db.query(
      `SELECT id, username
       FROM admin_users
       WHERE username = 'silent' AND status = 'active'
       LIMIT 1`
    );

    if (!result.rowCount) {
      return res.status(503).json({
        success: false,
        message: 'Default admin account is unavailable.'
      });
    }

    const admin = result.rows[0];
    const token = await createSession('admin', admin.id);

    res.cookie('silent_admin_sid', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
      maxAge: 8 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      admin: {
        id: admin.id,
        username: 'silent'
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', adminAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, username
       FROM admin_users
       WHERE id = $1
         AND username = 'silent'
         AND status = 'active'`,
      [req.auth.id]
    );

    if (!result.rowCount) {
      return res.status(401).json({
        success: false,
        message: 'Admin account unavailable.'
      });
    }

    res.json({
      success: true,
      admin: {
        id: result.rows[0].id,
        username: 'silent'
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = readCookie(req, 'silent_admin_sid');

    if (token) {
      await deleteSession('admin', token);
    }

    res.clearCookie('silent_admin_sid', {
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
