const express = require('express');
const { query } = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT
        p.id,
        p.slot,
        p.name,
        p.image_url,
        p.product_url,
        p.description,
        p.status,
        COALESCE(
          json_agg(
            json_build_object(
              'durationHours', d.duration_hours,
              'price', d.price
            )
            ORDER BY d.duration_hours
          ) FILTER (
            WHERE d.id IS NOT NULL AND d.active = TRUE
          ),
          '[]'::json
        ) AS durations
      FROM products p
      LEFT JOIN product_durations d
        ON d.product_id = p.id
      WHERE p.status = 'active'
      GROUP BY p.id
      ORDER BY p.slot ASC
    `);

    res.json({
      success: true,
      products: result.rows
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
