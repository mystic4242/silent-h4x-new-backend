const crypto = require('crypto');

function getEncryptionKey() {
  const secret = process.env.KEY_ENCRYPTION_SECRET;

  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) {
    throw new Error('KEY_ENCRYPTION_SECRET must be 32 bytes in hex.');
  }

  return Buffer.from(secret, 'hex');
}

function hashSecret(value) {
  return crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex');
}

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag();

  return [
    iv.toString('hex'),
    tag.toString('hex'),
    encrypted.toString('hex')
  ].join(':');
}

function decrypt(payload) {
  const parts = String(payload).split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload.');
  }

  const [ivHex, tagHex, encryptedHex] = parts;

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(ivHex, 'hex')
  );

  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final()
  ]).toString('utf8');
}

module.exports = {
  hashSecret,
  generateToken,
  encrypt,
  decrypt
};
