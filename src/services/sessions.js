const db = require('../db');
const { generateToken, hashSecret } = require('./crypto');

const CUSTOMER_SESSION_HOURS = 24 * 7;
const ADMIN_SESSION_HOURS = 8;

async function createSession(type, userId) {
  const isAdmin = type === 'admin';
  const table = isAdmin ? 'admin_sessions' : 'customer_sessions';
  const idColumn = isAdmin ? 'admin_id' : 'customer_id';
  const hours = isAdmin
    ? ADMIN_SESSION_HOURS
    : CUSTOMER_SESSION_HOURS;

  const token = generateToken(32);
  const tokenHash = hashSecret(token);

  await db.query(
    `INSERT INTO ${table}
       (${idColumn}, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 hour'))`,
    [userId, tokenHash, hours]
  );

  return token;
}

async function getSession(type, token) {
  if (!token || typeof token !== 'string') return null;

  const isAdmin = type === 'admin';
  const table = isAdmin ? 'admin_sessions' : 'customer_sessions';
  const idColumn = isAdmin ? 'admin_id' : 'customer_id';
  const entityTable = isAdmin ? 'admin_users' : 'customers';
  const tokenHash = hashSecret(token);

  const result = await db.query(
    `SELECT s.${idColumn} AS user_id, s.expires_at
       FROM ${table} s
       JOIN ${entityTable} u ON u.id = s.${idColumn}
      WHERE s.token_hash = $1
        AND s.expires_at > NOW()
        AND u.status = $2
      LIMIT 1`,
    [tokenHash, isAdmin ? 'active' : 'active']
  );

  if (!result.rowCount) return null;

  if (!isAdmin) {
    await db.query(
      `UPDATE customer_sessions
          SET last_seen_at = NOW()
        WHERE token_hash = $1`,
      [tokenHash]
    );
  }

  return {
    id: result.rows[0].user_id,
    expiresAt: result.rows[0].expires_at
  };
}

async function deleteSession(type, token) {
  if (!token || typeof token !== 'string') return;

  const table = type === 'admin'
    ? 'admin_sessions'
    : 'customer_sessions';

  await db.query(
    `DELETE FROM ${table} WHERE token_hash = $1`,
    [hashSecret(token)]
  );
}

module.exports = {
  createSession,
  getSession,
  deleteSession
};
