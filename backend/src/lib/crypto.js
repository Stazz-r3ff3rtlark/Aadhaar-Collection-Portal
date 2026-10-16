'use strict';

const crypto = require('node:crypto');

/** URL-safe random token (default 256 bits). Only its SHA-256 is ever stored. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Six-digit numeric one-time code. */
function randomOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

module.exports = { randomToken, sha256Hex, hmacHex, safeEqualHex, randomOtp, randomUUID: crypto.randomUUID };
