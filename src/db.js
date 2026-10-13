const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured.');
}

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString,
  ssl: isProduction
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  allowExitOnIdle: false
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function checkDatabase() {
  const result = await pool.query(
    'SELECT NOW() AS server_time, current_database() AS database_name'
  );

  return result.rows[0];
}

async function closeDatabase() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  checkDatabase,
  closeDatabase
};
