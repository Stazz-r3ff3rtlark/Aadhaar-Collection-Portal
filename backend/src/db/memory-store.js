'use strict';

const { ALLOWED_EMAIL_DOMAIN } = require('../config');
const { pickColumns } = require('./schema');

// In-memory implementation of the store interface, for tests only. It mirrors the
// MariaDB store's methods, the constraints that matter to sign-in (unique email, email
// domain, coordinator division) and transaction rollback.

function duplicateError(key) {
  const err = new Error(`Duplicate entry for ${key}`);
  err.code = 'ER_DUP_ENTRY';
  return err;
}

function constraintError(name) {
  const err = new Error(`CHECK constraint ${name} failed`);
  err.code = 'ER_CONSTRAINT_FAILED';
  return err;
}

function emptyState() {
  return {
    seq: { users: 0, sessions: 0, otp_codes: 0, audit_log: 0 },
    users: [],
    divisions: [
      { id: 1, name: 'Marketing', archivedAt: null },
      { id: 2, name: 'Business Enablers', archivedAt: null },
    ],
    sessions: [],
    otp_codes: [],
    audit_log: [],
  };
}

const clone = (row) => (row ? structuredClone(row) : null);

function repos(state) {
  function insert(table, fields) {
    const row = { ...pickColumns(table, fields) };
    for (const col of Object.keys(row)) if (row[col] === undefined) row[col] = null;
    row.id = ++state.seq[table];
    state[table].push(row);
    return row.id;
  }

  function update(table, id, fields) {
    const row = state[table].find((r) => r.id === id);
    if (row) Object.assign(row, pickColumns(table, fields));
    return row;
  }

  function checkUser(row, id) {
    if (state.users.some((u) => u.email === row.email && u.id !== id)) throw duplicateError('uq_users_email');
    if (!row.email.toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) throw constraintError('chk_users_email_domain');
    if ((row.role === 'coordinator') !== (row.divisionId != null)) throw constraintError('chk_users_coordinator_division');
  }

  return {
    users: {
      findById: async (id) => clone(state.users.find((u) => u.id === id)),
      findByEmail: async (email) => clone(state.users.find((u) => u.email === email)),
      list: async () => [...state.users]
        .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name))
        .map(clone),
      async insert(fields) {
        const row = { isActive: true, failedPasswordAttempts: 0, divisionId: null, ...fields };
        checkUser(row, null);
        return insert('users', row);
      },
      async update(id, fields) {
        const existing = state.users.find((u) => u.id === id);
        if (!existing) return;
        checkUser({ ...existing, ...fields }, id);
        update('users', id, fields);
      },
    },
    divisions: {
      list: async () => state.divisions.filter((d) => !d.archivedAt).map(clone),
      findById: async (id) => clone(state.divisions.find((d) => d.id === id)),
    },
    sessions: {
      async insert(fields) {
        if (state.sessions.some((s) => s.tokenHash === fields.tokenHash)) throw duplicateError('uq_sessions_token');
        return insert('sessions', fields);
      },
      findByTokenHash: async (hash) => clone(state.sessions.find((s) => s.tokenHash === hash)),
      update: async (id, fields) => { update('sessions', id, fields); },
      async revokeAllForUser(userId, at, reason) {
        let n = 0;
        for (const s of state.sessions) {
          if (s.userId === userId && !s.revokedAt) {
            s.revokedAt = at;
            s.revokedReason = reason;
            n += 1;
          }
        }
        return n;
      },
    },
    otps: {
      insert: async (fields) => insert('otp_codes', { attempts: 0, ...fields }),
      update: async (id, fields) => { update('otp_codes', id, fields); },
      findLatestActive: async (userId, purpose, now) => clone(
        state.otp_codes
          .filter((o) => o.userId === userId && o.purpose === purpose && !o.consumedAt && !o.invalidatedAt && o.expiresAt > now)
          .at(-1),
      ),
      findLatest: async (userId, purpose) => clone(
        state.otp_codes.filter((o) => o.userId === userId && o.purpose === purpose).at(-1),
      ),
      countCreatedSince: async (userId, purpose, since) => state.otp_codes
        .filter((o) => o.userId === userId && o.purpose === purpose && o.createdAt >= since).length,
      async invalidateActive(userId, purpose, at) {
        for (const o of state.otp_codes) {
          if (o.userId === userId && o.purpose === purpose && !o.consumedAt && !o.invalidatedAt) o.invalidatedAt = at;
        }
      },
    },
    audit: {
      insert: async (fields) => insert('audit_log', fields),
      list: async ({ action, actorUserId, bookingId, beforeId, limit = 100 } = {}) => state.audit_log
        .filter((e) => (!action || e.action === action)
          && (!actorUserId || e.actorUserId === actorUserId)
          && (!bookingId || e.bookingId === bookingId)
          && (!beforeId || e.id < beforeId))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map(clone),
    },
  };
}

function createMemoryStore() {
  let state = emptyState();
  // Transactions run one at a time, like serialisable isolation.
  let queue = Promise.resolve();

  return {
    transaction(fn) {
      const run = async () => {
        const snapshot = structuredClone(state);
        try {
          return await fn(repos(state));
        } catch (err) {
          state = snapshot;
          throw err;
        }
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
    async healthCheck() {
      return true;
    },
    async close() {},
    /** Test helper: raw rows of a table. */
    dump: (table) => structuredClone(state[table]),
  };
}

module.exports = { createMemoryStore };
