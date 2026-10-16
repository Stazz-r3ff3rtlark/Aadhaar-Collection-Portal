'use strict';

// Redacts anything that could carry Aadhaar content or credentials before it reaches
// a log line or an audit entry. It is a safety net, not a licence: callers should
// still pass only IDs, statuses and counts.

// Keys dropped outright (exact match, case-insensitive).
const SECRET_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'passwordhash',
  'otp',
  'code',
  'codehash',
  'token',
  'tokenhash',
  'secret',
  'passcode',
  'authorization',
  'cookie',
  'set-cookie',
]);

// Keys dropped if they contain any of these fragments.
const SENSITIVE_KEY_PART = /aadhaar|base64|ocr|image|filecontent|filedata|buffer|blob/i;

// 12 digits, optionally grouped 4-4-4 with spaces or hyphens: the shape of an Aadhaar number.
const AADHAAR_LIKE = /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g;

// Long runs of base64 / hex characters (line breaks allowed, spaces not): encoded file content or tokens.
const ENCODED_BLOB = /^[A-Za-z0-9+/=_\-\r\n]{200,}$/;

const MAX_STRING = 500;
const MAX_DEPTH = 5;
const MAX_KEYS = 50;

const REDACTED = '[redacted]';

function sanitizeString(value) {
  if (ENCODED_BLOB.test(value)) return '[omitted: encoded data]';
  let out = value.replace(AADHAAR_LIKE, REDACTED);
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…[truncated]`;
  return out;
}

function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return '[omitted: binary data]';
  }
  if (depth >= MAX_DEPTH) return '[omitted: nested too deep]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
      if (SECRET_KEYS.has(key.toLowerCase()) || SENSITIVE_KEY_PART.test(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = sanitize(item, depth + 1);
    }
    return out;
  }
  return `[omitted: ${typeof value}]`;
}

module.exports = { sanitize, REDACTED };
