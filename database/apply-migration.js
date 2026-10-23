require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function main() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(20) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const version of ['001', '002', '003']) {
      const file = path.join(__dirname, `migration-${version}.sql`);

      if (!fs.existsSync(file)) {
        throw new Error(`Migration ${version} not found.`);
      }

      const check = await client.query(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [version]
      );

      if (check.rowCount) {
        console.log(`Migration ${version} already recorded; skipping.`);
        continue;
      }

      console.log(`Applying migration ${version}...`);
      await client.query(fs.readFileSync(file, 'utf8'));

      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [version]
      );

      console.log(`Migration ${version} applied.`);
    }

    const result = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'generated_keys'
        AND column_name IN ('encrypted_key', 'revealed_at', 'revoked_at')
      ORDER BY column_name
    `);

    console.log('Verified generated_keys columns:', result.rows);

    if (result.rows.length !== 3) {
      throw new Error('Required generated_keys columns are missing.');
    }

    const status = await client.query(
      'SELECT version, applied_at FROM schema_migrations ORDER BY version'
    );

    console.log('Recorded migrations:', status.rows);
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
