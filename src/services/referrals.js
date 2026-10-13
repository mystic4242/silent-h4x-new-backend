const crypto = require('crypto');
const db = require('../db');

function createReferralCode() {
  return crypto.randomBytes(9).toString('base64url');
}

async function createProfile(customerId, displayName) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = createReferralCode();

    try {
      const result = await db.query(
        `INSERT INTO referral_profiles
           (customer_id, referral_code, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (customer_id) DO NOTHING
         RETURNING id, referral_code, display_name`,
        [customerId, code, displayName || null]
      );

      if (result.rowCount) return result.rows[0];

      const existing = await db.query(
        `SELECT id, referral_code, display_name
           FROM referral_profiles
          WHERE customer_id = $1`,
        [customerId]
      );

      if (existing.rowCount) return existing.rows[0];
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }

  throw new Error('Could not create a unique referral code.');
}

async function recordEvent(code, eventType, visitorHash, path) {
  const allowed = ['visit', 'whatsapp_click', 'conversion'];

  if (!allowed.includes(eventType)) {
    throw new Error('Invalid referral event.');
  }

  const result = await db.query(
    `INSERT INTO referral_events
       (referral_profile_id, event_type, visitor_token_hash, landing_path)
     SELECT id, $2, $3, $4
       FROM referral_profiles
      WHERE referral_code = $1 AND status = 'active'
     RETURNING id`,
    [code, eventType, visitorHash || null, path || null]
  );

  return result.rowCount > 0;
}

async function getLeaderboard(limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const result = await db.query(
    `SELECT rp.referral_code, rp.display_name,
            COUNT(DISTINCT ra.referred_customer_id)::INTEGER AS conversions
       FROM referral_profiles rp
       LEFT JOIN referral_attributions ra
         ON ra.referral_profile_id = rp.id
        AND ra.attributed_at <= ra.attribution_expires_at
      WHERE rp.status = 'active'
      GROUP BY rp.id, rp.referral_code, rp.display_name
      ORDER BY conversions DESC, rp.created_at ASC
      LIMIT $1`,
    [safeLimit]
  );

  return result.rows;
}

module.exports = {
  createProfile,
  recordEvent,
  getLeaderboard
};
