require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function main() {
  const client = await pool.connect();

  try {
    for (const version of ['001', '002']) {
      const file = path.join(
        __dirname,
        `migration-${version}.sql`
      );

      if (!fs.existsSync(file)) {
        throw new Error(`Migration ${version} not found.`);
      }

      const sql = fs.readFileSync(file, 'utf8');
      await client.query(sql);
      console.log(`Migration ${version} applied successfully.`);
    }

    const result = await client.query(`
      SELECT
        column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'generated_keys'
        AND column_name IN (
          'encrypted_key',
          'revealed_at',
          'revoked_at'
        )
      ORDER BY column_name
    `);

    console.log('Verified generated_keys columns:');
    result.rows.forEach(row => console.log('-', row.column_name));

    if (result.rows.length !== 3) {
      throw new Error('Required generated_keys columns are missing.');
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
