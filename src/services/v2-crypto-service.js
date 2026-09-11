'use strict';

const crypto = require('crypto');
const config = require('../config');

function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function digestIdentifier(value, key = config.selfServiceV2.protectionKey) {
  if (!key) throw new Error('V2 transient protection key is not configured.');
  return crypto.createHmac('sha256', Buffer.from(key, 'base64'))
    .update(normalizeIdentifier(value))
    .digest('hex');
}

function timingSafeTextEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''), 'utf8');
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function timingSafeHashEqual(actualHash, expectedHash) {
  if (!/^[0-9a-f]{64}$/i.test(String(actualHash || '')) ||
      !/^[0-9a-f]{64}$/i.test(String(expectedHash || ''))) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(actualHash, 'hex'),
    Buffer.from(expectedHash, 'hex')
  );
}

function getProtectionKey(key = config.selfServiceV2.protectionKey) {
  const decoded = Buffer.from(String(key || ''), 'base64');
  if (decoded.length !== 32) {
    throw new Error('V2 transient protection key must decode to 32 bytes.');
  }
  return decoded;
}

function protectSecret(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getProtectionKey(key), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final(),
  ]);
  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function unprotectSecret(protectedValue, key) {
  const parts = String(protectedValue || '').split('.');
  if (parts.length !== 3) throw new Error('Protected value is malformed.');
  const [iv, tag, ciphertext] = parts.map((part) =>
    Buffer.from(part, 'base64url')
  );
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getProtectionKey(key),
    iv
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

function randomOpaqueToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function randomNumericPin(length) {
  const digits = [];
  while (digits.length < length) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < 250) digits.push(String(byte % 10));
  }
  return digits.join('');
}

module.exports = {
  normalizeIdentifier,
  sha256,
  digestIdentifier,
  timingSafeTextEqual,
  timingSafeHashEqual,
  protectSecret,
  unprotectSecret,
  randomOpaqueToken,
  randomNumericPin,
};
