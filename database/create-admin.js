require('dotenv').config();

const crypto = require('crypto');
const readline = require('readline');
const db = require('../src/db');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);

  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

(async () => {
  try {
    const username = (await ask('Admin username: ')).trim();
    const password = await ask('Admin password: ');

    if (!/^[a-zA-Z0-9_.-]{3,80}$/.test(username)) {
      throw new Error('Username must be 3-80 valid characters.');
    }

    if (password.length < 12 || password.length > 256) {
      throw new Error('Password must be at least 12 characters.');
    }

    const passwordHash = hashPassword(password);

    await db.query(
      `INSERT INTO admin_users (username, password_hash)
       VALUES ($1, $2)`,
      [username, passwordHash]
    );

    console.log('Admin account created.');
  } catch (err) {
    console.error('Admin creation failed:', err.message);
    process.exitCode = 1;
  } finally {
    rl.close();
    await db.closeDatabase();
  }
})();
