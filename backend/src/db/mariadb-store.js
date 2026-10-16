'use strict';

const mariadb = require('mariadb');
const { BOOLEAN_COLUMNS, toSnake, toCamel, pickColumns } = require('./schema');

const IST_SESSION_SQL = "SET time_zone = '+05:30'";

function createPool(db) {
  return mariadb.createPool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    connectionLimit: db.connectionLimit,
    // IST is set explicitly on every connection; never rely on the server default.
    initSql: IST_SESSION_SQL,
    // DATETIME values come back as IST strings; see src/lib/time.js.
    dateStrings: true,
    bigIntAsNumber: true,
    insertIdAsNumber: true,
    // Never include query parameters in driver error messages.
    logParam: false,
  });
}

function mapRow(row) {
  if (!row) return null;
  const out = {};
  for (const [column, value] of Object.entries(row)) {
    const key = toCamel(column);
    if (BOOLEAN_COLUMNS.has(key)) out[key] = Boolean(value);
    else if (key === 'details' && typeof value === 'string') out[key] = JSON.parse(value);
    else out[key] = value;
  }
  return out;
}

function encode(key, value) {
  if (BOOLEAN_COLUMNS.has(key)) return value ? 1 : 0;
  if (key === 'details') return value == null ? null : JSON.stringify(value);
  return value;
}

function repos(conn) {
  const one = async (sql, params) => mapRow((await conn.query(sql, params))[0]);
  const many = async (sql, params) => (await conn.query(sql, params)).map(mapRow);

  async function insert(table, fields) {
    const cols = pickColumns(table, fields);
    const keys = Object.keys(cols);
    const sql = `INSERT INTO ${table} (${keys.map(toSnake).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    const result = await conn.query(sql, keys.map((k) => encode(k, cols[k])));
    return result.insertId;
  }

  async function update(table, id, fields) {
    const cols = pickColumns(table, fields);
    const keys = Object.keys(cols);
    if (!keys.length) return;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${toSnake(k)} = ?`).join(', ')} WHERE id = ?`;
    await conn.query(sql, [...keys.map((k) => encode(k, cols[k])), id]);
  }

  return {
    users: {
      findById: (id) => one('SELECT * FROM users WHERE id = ?', [id]),
      findByEmail: (email) => one('SELECT * FROM users WHERE email = ?', [email]),
      list: () => many('SELECT * FROM users ORDER BY is_active DESC, name ASC'),
      insert: (fields) => insert('users', fields),
      update: (id, fields) => update('users', id, fields),
    },
    divisions: {
      list: () => many('SELECT * FROM divisions WHERE archived_at IS NULL ORDER BY name'),
      findById: (id) => one('SELECT * FROM divisions WHERE id = ?', [id]),
    },
    sessions: {
      insert: (fields) => insert('sessions', fields),
      findByTokenHash: (hash) => one('SELECT * FROM sessions WHERE token_hash = ?', [hash]),
      update: (id, fields) => update('sessions', id, fields),
      async revokeAllForUser(userId, at, reason) {
        const result = await conn.query(
          'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
          [at, reason, userId],
        );
        return result.affectedRows;
      },
    },
    otps: {
      insert: (fields) => insert('otp_codes', fields),
      update: (id, fields) => update('otp_codes', id, fields),
      findLatestActive: (userId, purpose, now) => one(
        `SELECT * FROM otp_codes
          WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ?
          ORDER BY id DESC LIMIT 1`,
        [userId, purpose, now],
      ),
      findLatest: (userId, purpose) => one(
        'SELECT * FROM otp_codes WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
        [userId, purpose],
      ),
      async countCreatedSince(userId, purpose, since) {
        const rows = await conn.query(
          'SELECT COUNT(*) AS n FROM otp_codes WHERE user_id = ? AND purpose = ? AND created_at >= ?',
          [userId, purpose, since],
        );
        return Number(rows[0].n);
      },
      async invalidateActive(userId, purpose, at) {
        await conn.query(
          `UPDATE otp_codes SET invalidated_at = ?
            WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL AND invalidated_at IS NULL`,
          [at, userId, purpose],
        );
      },
    },
    audit: {
      // Insert only: there is deliberately no update or delete here, and the database
      // triggers in migration 002 reject both.
      insert: (fields) => insert('audit_log', fields),
      list({ action, actorUserId, bookingId, beforeId, limit = 100 } = {}) {
        const where = [];
        const params = [];
        if (action) { where.push('action = ?'); params.push(action); }
        if (actorUserId) { where.push('actor_user_id = ?'); params.push(actorUserId); }
        if (bookingId) { where.push('booking_id = ?'); params.push(bookingId); }
        if (beforeId) { where.push('id < ?'); params.push(beforeId); }
        params.push(limit);
        return many(
          `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
          params,
        );
      },
    },
  };
}

function createMariaDbStore(pool) {
  return {
    async transaction(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const result = await fn(repos(conn));
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
    /** Confirms the database answers and that the session timezone really is IST. */
    async healthCheck() {
      const rows = await pool.query('SELECT @@session.time_zone AS tz');
      if (rows[0].tz !== '+05:30') throw new Error('Database session time_zone is not +05:30');
      return true;
    },
    close: () => pool.end(),
  };
}

module.exports = { createPool, createMariaDbStore, IST_SESSION_SQL };
