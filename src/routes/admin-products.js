const express = require('express');
const db = require('../db');
const { adminAuth } = require('../middleware/auth');

const router = express.Router();
router.use(adminAuth);

const validDurations = [2, 48, 168, 720];

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT p.*,
        COALESCE(
          json_agg(
            json_build_object(
              'id', d.id,
              'duration_hours', d.duration_hours,
              'price', d.price,
              'active', d.active
            ) ORDER BY d.duration_hours
          ) FILTER (WHERE d.id IS NOT NULL),
          '[]'::json
        ) AS durations
      FROM products p
      LEFT JOIN product_durations d ON d.product_id = p.id
      GROUP BY p.id
      ORDER BY p.slot
    `);
    res.json({ success: true, products: result.rows });
  } catch (err) {
    next(err);
  }
});

router.put('/:slot', async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const slot = Number(req.params.slot);
    const { name, imageUrl, productUrl, description, status, durations } = req.body;

    if (!Number.isInteger(slot) || slot < 1 || slot > 10) {
      return res.status(400).json({ success: false, message: 'Slot must be 1–10' });
    }
    if (!String(name || '').trim()) {
      return res.status(400).json({ success: false, message: 'Product name required' });
    }
    if (!Array.isArray(durations)) {
      return res.status(400).json({ success: false, message: 'Durations must be an array' });
    }

    for (const d of durations) {
      if (!validDurations.includes(Number(d.duration_hours)) ||
          !Number.isFinite(Number(d.price)) || Number(d.price) < 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid duration or price'
        });
      }
    }

    await client.query('BEGIN');

    const product = await client.query(
      `INSERT INTO products
       (slot, name, image_url, product_url, description, status)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (slot) DO UPDATE SET
         name = EXCLUDED.name,
         image_url = EXCLUDED.image_url,
         product_url = EXCLUDED.product_url,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         updated_at = NOW()
       RETURNING *`,
      [
        slot,
        String(name).trim().slice(0, 120),
        imageUrl || null,
        productUrl || null,
        String(description || '').slice(0, 3000),
        status === 'inactive' ? 'inactive' : 'active'
      ]
    );

    const productId = product.rows[0].id;

    for (const d of durations) {
      await client.query(
        `INSERT INTO product_durations
         (product_id, duration_hours, price, active)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (product_id, duration_hours)
         DO UPDATE SET price = EXCLUDED.price, active = EXCLUDED.active`,
        [
          productId,
          Number(d.duration_hours),
          Number(d.price),
          d.active !== false
        ]
      );
    }

    await client.query(
      `INSERT INTO audit_logs
       (admin_id, action, entity_type, entity_id, details)
       VALUES ($1,'product_updated','product',$2,$3)`,
      [req.auth.id, productId, JSON.stringify({ slot })]
    );

    await client.query('COMMIT');
    res.json({ success: true, product: product.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
