require('dotenv').config();

const { checkDatabase, closeDatabase } = require('../src/db');

async function main() {
  try {
    const result = await checkDatabase();

    console.log('PostgreSQL connection: SUCCESS');
    console.log('Database name:', result.database_name);
    console.log('Server time:', result.server_time);
  } catch (err) {
    console.error('PostgreSQL connection: FAILED');
    console.error('Reason:', err.message);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

main();
