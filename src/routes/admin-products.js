const express = require('express');
const db = require('../db');
const { adminAuth } = require('../middleware/auth');

const router = express.Router();
router.use(adminAuth);

function validHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;

  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

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
  const slot = Number(req.params.slot);
  const {
    name, imageUrl, productUrl, description,
    status, isFree, price: submittedPrice, durations
  } = req.body || {};

  if (!Number.isSafeInteger(slot) || slot < 1) {
    return res.status(400).json({
      success: false, message: 'Slot must be a positive integer.'
    });
  }

  const cleanName = String(name || '').trim();

  if (!cleanName || cleanName.length > 120) {
    return res.status(400).json({
      success: false, message: 'Product name must contain 1–120 characters.'
    });
  }

  if (status !== undefined && !['active', 'inactive'].includes(status)) {
    return res.status(400).json({
      success: false, message: 'Invalid product status.'
    });
  }

  const free = isFree === true;
  let price = Number(submittedPrice);

  // Temporary compatibility with the old admin form.
  if (submittedPrice === undefined && Array.isArray(durations)) {
    const prices = durations
      .filter(d => d && d.active !== false)
      .map(d => Number(d.price))
      .filter(n => Number.isFinite(n) && n >= 0);

    price = prices.length ? Math.min(...prices) : 0;
  }

  if (free) {
    price = 0;
  } else if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({
      success: false, message: 'Paid products need a price greater than zero.'
    });
  }

  const cleanUrl = String(productUrl || '').trim();

  if (status !== 'inactive' && !validHttpUrl(cleanUrl)) {
    return res.status(400).json({
      success: false,
      message: 'Active products need a valid HTTP or HTTPS download URL.'
    });
  }

  if (cleanUrl && !validHttpUrl(cleanUrl)) {
    return res.status(400).json({
      success: false, message: 'Invalid download URL.'
    });
  }

  const cleanImage = String(imageUrl || '').trim();

  if (cleanImage && !validHttpUrl(cleanImage)) {
    return res.status(400).json({
      success: false, message: 'Invalid image URL.'
    });
  }

  let client;

  try {
    client = await db.pool.connect();
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO products
         (slot, name, image_url, product_url, description,
          status, is_free, price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (slot) DO UPDATE SET
         name = EXCLUDED.name,
         image_url = EXCLUDED.image_url,
         product_url = EXCLUDED.product_url,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         is_free = EXCLUDED.is_free,
         price = EXCLUDED.price,
         updated_at = NOW()
       RETURNING id, slot, name, image_url, product_url,
                 description, status, is_free, price`,
      [
        slot, cleanName, cleanImage || null, cleanUrl || null,
        String(description || '').slice(0, 3000),
        status === 'inactive' ? 'inactive' : 'active',
        free, price
      ]
    );

    const product = result.rows[0];

    await client.query(
      `INSERT INTO audit_logs
         (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, 'product_updated', 'product', $2, $3::jsonb)`,
      [
        req.auth.id,
        product.id,
        JSON.stringify({ slot, isFree: free, price, status: product.status })
      ]
    );

    await client.query('COMMIT');
    res.json({ success: true, product });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});


router.delete('/:id', async (req, res, next) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      success: false,
      message: 'Invalid product ID.'
    });
  }

  let client;

  try {
    client = await db.pool.connect();
    await client.query('BEGIN');

    const found = await client.query(
      'SELECT id, name, slot FROM products WHERE id = $1 FOR UPDATE',
      [id]
    );

    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Product not found.'
      });
    }

    const orders = await client.query(
      'SELECT 1 FROM orders WHERE product_id = $1 LIMIT 1',
      [id]
    );

    const ownerships = await client.query(
      'SELECT 1 FROM product_ownerships WHERE product_id = $1 LIMIT 1',
      [id]
    );

    if (orders.rowCount || ownerships.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'This product has order or ownership history. Deactivate it instead of deleting it.'
      });
    }

    await client.query('DELETE FROM product_ownerships WHERE product_id = $1', [id]);
    await client.query('DELETE FROM generated_keys WHERE product_id = $1', [id]);
    await client.query('DELETE FROM product_durations WHERE product_id = $1', [id]);

    await client.query(
      `INSERT INTO audit_logs
         (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, 'product_deleted', 'product', $2, $3::jsonb)`,
      [
        req.auth.id,
        id,
        JSON.stringify({
          name: found.rows[0].name,
          slot: found.rows[0].slot
        })
      ]
    );

    await client.query('DELETE FROM products WHERE id = $1', [id]);
    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'Product permanently deleted.'
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
