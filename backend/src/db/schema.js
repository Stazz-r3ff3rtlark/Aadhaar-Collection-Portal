'use strict';

// Columns each repository may write, in camelCase. Both stores use these lists, so the
// in-memory store used by tests cannot accept a field the MariaDB store would reject.

const COLUMNS = {
  users: [
    'email', 'name', 'role', 'divisionId', 'passwordHash', 'passwordSetAt',
    'failedPasswordAttempts', 'lockedUntil', 'isActive', 'deactivatedAt', 'lastLoginAt',
    'createdByUserId', 'createdAt', 'updatedAt',
  ],
  sessions: [
    'tokenHash', 'userId', 'authMethod', 'ip', 'userAgent', 'createdAt', 'lastSeenAt',
    'expiresAt', 'revokedAt', 'revokedReason',
  ],
  otp_codes: [
    'userId', 'purpose', 'codeHash', 'attempts', 'requestIp', 'createdAt', 'expiresAt',
    'consumedAt', 'invalidatedAt',
  ],
  audit_log: [
    'occurredAt', 'actorType', 'actorUserId', 'actorEmail', 'actorRole', 'actorLabel', 'action',
    'outcome', 'entityType', 'entityId', 'bookingId', 'ip', 'userAgent', 'requestId', 'details',
  ],
};

const BOOLEAN_COLUMNS = new Set(['isActive']);

const toSnake = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function pickColumns(table, fields) {
  const allowed = COLUMNS[table];
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) throw new Error(`Unknown column ${table}.${key}`);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

module.exports = { COLUMNS, BOOLEAN_COLUMNS, toSnake, toCamel, pickColumns };
