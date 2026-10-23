const express = require('express');
const { pool, query } = require('../db');
const { customerAuth } = require('../middleware/auth');
const { decrypt } = require('../services/crypto');

const router = express.Router();
router.use(customerAuth);

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

router.post('/free/:productId', async (req, res, next) => {
  const productId = validId(req.params.productId);
  if (!productId) {
    return res.status(400).json({
      success: false, message: 'Invalid product ID.'
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT id, name, product_url, is_free, status
       FROM products WHERE id = $1 FOR UPDATE`,
      [productId]
    );

    if (!result.rowCount || result.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false, message: 'Product unavailable.'
      });
    }

    const product = result.rows[0];

    if (!product.is_free) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false, message: 'This product is not free.'
      });
    }

    if (!product.product_url) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false, message: 'Download is not ready. Contact support.'
      });
    }

    const ownership = await client.query(
      `INSERT INTO product_ownerships
         (customer_id, product_id, amount_paid)
       VALUES ($1, $2, 0)
       ON CONFLICT (customer_id, product_id) DO NOTHING
       RETURNING id`,
      [req.auth.id, productId]
    );

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: ownership.rowCount
        ? 'Added to My Products.'
        : 'You already own this product.',
      alreadyOwned: ownership.rowCount === 0,
      product: {
        id: product.id,
        name: product.name,
        downloadUrl: product.product_url
      }
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

router.post('/', async (req, res, next) => {
  const productId = validId(req.body?.productId);
  if (!productId) {
    return res.status(400).json({
      success: false, message: 'Select a valid product.'
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT id, name, product_url, is_free, price, status
       FROM products WHERE id = $1 FOR UPDATE`,
      [productId]
    );

    if (!result.rowCount || result.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false, message: 'Product unavailable.'
      });
    }

    const product = result.rows[0];

    if (product.is_free) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false, message: 'Use the free-claim option.'
      });
    }

    if (!product.product_url) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false, message: 'Download is not ready. Contact support.'
      });
    }

    const existing = await client.query(
      `SELECT id FROM product_ownerships
       WHERE customer_id = $1 AND product_id = $2`,
      [req.auth.id, productId]
    );

    if (existing.rowCount) {
      await client.query('COMMIT');
      return res.json({
        success: true,
        alreadyOwned: true,
        message: 'You already own this product.',
        product: {
          id: product.id,
          name: product.name,
          downloadUrl: product.product_url
        }
      });
    }

    const price = Number(product.price);
    if (!Number.isFinite(price) || price <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false, message: 'Invalid product price.'
      });
    }

    const wallet = await client.query(
      `SELECT balance FROM wallets
       WHERE customer_id = $1 FOR UPDATE`,
      [req.auth.id]
    );

    if (!wallet.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false, message: 'Wallet not found.'
      });
    }

    const balance = Number(wallet.rows[0].balance);
    if (!Number.isFinite(balance) || balance < price) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Insufficient wallet balance.',
        balance
      });
    }

    const orderResult = await client.query(
      `INSERT INTO orders
         (customer_id, product_id, duration_hours, price_paid, status)
       VALUES ($1, $2, NULL, $3, 'completed')
       RETURNING id, created_at`,
      [req.auth.id, productId, price]
    );

    const order = orderResult.rows[0];

    await client.query(
      `UPDATE wallets SET balance = balance - $2, updated_at = NOW()
       WHERE customer_id = $1`,
      [req.auth.id, price]
    );

    await client.query(
      `INSERT INTO wallet_transactions
         (customer_id, transaction_type, amount, direction,
          description, reference)
       VALUES ($1, 'purchase', $2, 'debit', $3, $4)`,
      [
        req.auth.id, price,
        `Permanent purchase: ${product.name}`,
        `order:${order.id}`
      ]
    );

    await client.query(
      `INSERT INTO product_ownerships
         (customer_id, product_id, order_id, amount_paid)
       VALUES ($1, $2, $3, $4)`,
      [req.auth.id, productId, order.id, price]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      alreadyOwned: false,
      message: 'Purchase successful. You own this product permanently.',
      order: {
        id: order.id,
        productId: product.id,
        productName: product.name,
        amount: price,
        status: 'completed',
        createdAt: order.created_at
      },
      product: {
        id: product.id,
        name: product.name,
        downloadUrl: product.product_url
      }
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

router.get('/products', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT p.id, p.name, p.image_url, p.description, p.is_free,
              o.amount_paid, o.acquired_at, o.order_id,
              p.product_url AS download_url
       FROM product_ownerships o
       JOIN products p ON p.id = o.product_id
       WHERE o.customer_id = $1
       ORDER BY o.acquired_at DESC`,
      [req.auth.id]
    );

    res.json({ success: true, products: result.rows });
  } catch (err) {
    next(err);
  }
});

/* Legacy key endpoints retained temporarily during frontend migration. */
router.get('/keys', async (req, res, next) => {
  try {
    const [keys, orders] = await Promise.all([
      query(
        `SELECT g.id, g.order_id, g.key_prefix, g.status,
                g.expires_at, g.created_at,
                p.name AS product_name, o.duration_hours
         FROM generated_keys g
         JOIN products p ON p.id = g.product_id
         JOIN orders o ON o.id = g.order_id
         WHERE g.customer_id = $1
         ORDER BY g.created_at DESC`,
        [req.auth.id]
      ),
      query(
        `SELECT o.id, o.product_id, o.duration_hours,
                o.price_paid, o.status, o.created_at,
                p.name AS product_name
         FROM orders o
         JOIN products p ON p.id = o.product_id
         WHERE o.customer_id = $1
           AND o.status = 'pending_fulfillment'
         ORDER BY o.created_at DESC`,
        [req.auth.id]
      )
    ]);

    res.json({
      success: true,
      keys: keys.rows,
      pendingOrders: orders.rows
    });
  } catch (err) {
    next(err);
  }
});

router.post('/keys/:id/reveal', async (req, res, next) => {
  const keyId = validId(req.params.id);

  if (!keyId) {
    return res.status(400).json({
      success: false, message: 'Invalid key ID.'
    });
  }

  try {
    const result = await query(
      `SELECT id, encrypted_key, status, expires_at
       FROM generated_keys
       WHERE id = $1 AND customer_id = $2`,
      [keyId, req.auth.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false, message: 'Key not found.'
      });
    }

    const key = result.rows[0];

    if (key.status !== 'active' ||
        !key.expires_at ||
        new Date(key.expires_at) <= new Date()) {
      return res.status(410).json({
        success: false, message: 'Key is expired or inactive.'
      });
    }

    if (!key.encrypted_key) {
      return res.status(410).json({
        success: false, message: 'Key cannot be revealed.'
      });
    }

    const plaintext = decrypt(key.encrypted_key);

    await query(
      `UPDATE generated_keys SET revealed_at = NOW()
       WHERE id = $1 AND customer_id = $2`,
      [keyId, req.auth.id]
    );

    res.json({ success: true, key: plaintext });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
