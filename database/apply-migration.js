require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function main() {
  const file = path.join(__dirname, 'migration-001.sql');

  if (!fs.existsSync(file)) {
    throw new Error('database/migration-001.sql was not found.');
  }

  const sql = fs.readFileSync(file, 'utf8');
  const client = await pool.connect();

  try {
    await client.query(sql);
    console.log('Migration 001 applied successfully.');

    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'customer_sessions',
          'admin_sessions'
        )
      ORDER BY table_name
    `);

    console.log('Session tables found:', result.rows.length);

    for (const row of result.rows) {
      console.log('-', row.table_name);
    }

    if (result.rows.length !== 2) {
      throw new Error('Expected both session tables.');
    }
  } finally {
    client.release();
  }
}

main()
  .catch(err => {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
