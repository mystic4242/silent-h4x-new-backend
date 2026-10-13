require('dotenv').config();

const { pool } = require('../src/db');

async function main() {
  const tables = [
    'customers',
    'customer_access_keys',
    'wallets',
    'wallet_transactions',
    'payment_requests',
    'products',
    'product_durations',
    'orders',
    'generated_keys',
    'admin_users',
    'app_settings',
    'audit_logs',
    'referral_profiles',
    'referral_events',
    'referral_attributions',
    'customer_sessions',
    'admin_sessions'
  ];

  for (const table of tables) {
    const result = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );

    console.log(`\n[${table}]`);

    if (!result.rowCount) {
      console.log('MISSING TABLE');
      continue;
    }

    console.log(result.rows.map(row => row.column_name).join(', '));
  }
}

main()
  .catch(err => {
    console.error('Schema check failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
