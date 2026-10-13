const express = require('express');
const { pool } = require('../db');
const { adminAuth } = require('../middleware/auth');

const router = express.Router();

router.use(adminAuth);

const allowedSettings = new Set([
  'bank_name',
  'bank_account_name',
  'bank_account_number',
  'customer_care_whatsapp'
]);

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT setting_key, setting_value, updated_at
       FROM app_settings
       WHERE setting_key = ANY($1::text[])
       ORDER BY setting_key`,
      [[...allowedSettings]]
    );

    res.json({
      success: true,
      settings: result.rows
    });
  } catch (err) {
    next(err);
  }
});

router.put('/', async (req, res, next) => {
  const values = req.body?.settings;

  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return res.status(400).json({
      success: false,
      message: 'Send a settings object.'
    });
  }

  for (const [key, value] of Object.entries(values)) {
    if (
      !allowedSettings.has(key) ||
      typeof value !== 'string' ||
      value.length > 300
    ) {
      return res.status(400).json({
        success: false,
        message: `Invalid setting: ${key}`
      });
    }
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    for (const [key, value] of Object.entries(values)) {
      await client.query(
        `INSERT INTO app_settings (setting_key, setting_value)
         VALUES ($1, $2)
         ON CONFLICT (setting_key)
         DO UPDATE SET
           setting_value = EXCLUDED.setting_value,
           updated_at = NOW()`,
        [key, value.trim()]
      );
    }

    await client.query(
      `INSERT INTO audit_logs
       (admin_id, action, entity_type, details)
       VALUES ($1, 'settings.updated', 'app_settings', $2::jsonb)`,
      [
        req.auth.id,
        JSON.stringify({ changedKeys: Object.keys(values) })
      ]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Settings saved.'
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
