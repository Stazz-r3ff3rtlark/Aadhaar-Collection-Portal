'use strict';

const mariadb = require('mariadb');
const { BOOLEAN_COLUMNS, JSON_COLUMNS, toSnake, toCamel, pickColumns } = require('./schema');

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
    decimalAsNumber: true,
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
    else if (JSON_COLUMNS.has(key) && typeof value === 'string') out[key] = JSON.parse(value);
    else out[key] = value;
  }
  return out;
}

function encode(key, value) {
  if (BOOLEAN_COLUMNS.has(key)) return value ? 1 : 0;
  if (JSON_COLUMNS.has(key)) return value == null ? null : JSON.stringify(value);
  return value;
}

const USER_SELECT = 'SELECT u.*, d.name AS division_name FROM users u JOIN divisions d ON d.id = u.division_id';

// Booking rows with display names and traveller counts. Vacant rows count towards
// headcount only; cancelled guests leave the pending count.
const BOOKING_SELECT = `
  SELECT b.*,
         d.name AS division_name,
         COALESCE(h.name, b.hotel_name) AS hotel_display_name,
         h.review_status AS hotel_review_status,
         h.city AS hotel_city,
         cu.name AS created_by_name,
         uu.name AS updated_by_name,
         COALESCE(c.total, 0) AS employee_total,
         COALESCE(c.vacant, 0) AS employee_vacant,
         COALESCE(c.active, 0) AS employee_active,
         COALESCE(c.cancelled, 0) AS employee_cancelled,
         COALESCE(c.pending, 0) AS employee_pending
    FROM bookings b
    JOIN divisions d ON d.id = b.division_id
    LEFT JOIN hotels h ON h.id = b.hotel_id
    LEFT JOIN users cu ON cu.id = b.created_by_user_id
    LEFT JOIN users uu ON uu.id = b.updated_by_user_id
    LEFT JOIN (
      SELECT booking_id,
             COUNT(*) AS total,
             SUM(is_vacant = 1) AS vacant,
             SUM(is_vacant = 0) AS active,
             SUM(is_vacant = 0 AND cancelled_at IS NOT NULL) AS cancelled,
             SUM(is_vacant = 0 AND cancelled_at IS NULL AND submission_status = 'pending') AS pending
        FROM booking_employees
       GROUP BY booking_id
    ) c ON c.booking_id = b.id`;

function repos(conn) {
  const one = async (sql, params) => mapRow((await conn.query(sql, params))[0]);
  const many = async (sql, params) => (await conn.query(sql, params)).map(mapRow);
  const exec = async (sql, params) => (await conn.query(sql, params)).affectedRows;

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
    if (!keys.length) return 0;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${toSnake(k)} = ?`).join(', ')} WHERE id = ?`;
    return exec(sql, [...keys.map((k) => encode(k, cols[k])), id]);
  }

  return {
    users: {
      findById: (id) => one(`${USER_SELECT} WHERE u.id = ?`, [id]),
      findByEmail: (email) => one(`${USER_SELECT} WHERE u.email = ?`, [email]),
      list: () => many(`${USER_SELECT} ORDER BY u.is_active DESC, u.name ASC`),
      insert: (fields) => insert('users', fields),
      update: (id, fields) => update('users', id, fields),
      /** Locks and returns the ids of active admins, so two admins cannot remove each other at once. */
      async lockActiveAdmins() {
        return (await conn.query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1 FOR UPDATE"))
          .map((r) => r.id);
      },
      /** Anything showing the user has acted in the system. All zero means it is safe to delete. */
      activity: (id) => one(
        `SELECT
           (SELECT COUNT(*) FROM audit_log WHERE actor_user_id = ?) AS audit_as_actor,
           (SELECT COUNT(*) FROM bookings
             WHERE ? IN (coordinator_user_id, created_by_user_id, updated_by_user_id,
                         finalised_by_user_id, cancelled_by_user_id)) AS bookings,
           (SELECT COUNT(*) FROM booking_employees WHERE ? IN (verified_by_user_id, cancelled_by_user_id)) AS employee_changes,
           (SELECT COUNT(*) FROM users WHERE created_by_user_id = ?) AS users_created,
           (SELECT COUNT(*) FROM hotels WHERE ? IN (created_by_user_id, updated_by_user_id)) AS hotels`,
        [id, id, id, id, id],
      ),
      /** Deletes a never-used user and their unused sign-in codes and sessions. */
      async delete(id) {
        await exec('DELETE FROM otp_codes WHERE user_id = ?', [id]);
        await exec('DELETE FROM sessions WHERE user_id = ?', [id]);
        return exec('DELETE FROM users WHERE id = ?', [id]);
      },
    },

    divisions: {
      list: ({ includeArchived = false } = {}) => many(
        `SELECT d.*,
                (SELECT COUNT(*) FROM users u WHERE u.division_id = d.id) AS user_count,
                (SELECT COUNT(*) FROM bookings b WHERE b.division_id = d.id) AS booking_count
           FROM divisions d
          ${includeArchived ? '' : 'WHERE d.archived_at IS NULL'}
          ORDER BY d.archived_at IS NOT NULL, d.name`,
      ),
      findById: (id) => one('SELECT * FROM divisions WHERE id = ?', [id]),
      findByName: (name) => one('SELECT * FROM divisions WHERE name = ?', [name]),
      insert: (fields) => insert('divisions', fields),
      update: (id, fields) => update('divisions', id, fields),
      usage: (id) => one(
        `SELECT (SELECT COUNT(*) FROM users WHERE division_id = ?) AS users,
                (SELECT COUNT(*) FROM bookings WHERE division_id = ?) AS bookings`,
        [id, id],
      ),
      delete: (id) => exec('DELETE FROM divisions WHERE id = ?', [id]),
    },

    hotels: {
      list: ({ includeArchived = false } = {}) => many(
        `SELECT h.*, (SELECT COUNT(*) FROM bookings b WHERE b.hotel_id = h.id) AS booking_count,
                m.name AS merged_into_name
           FROM hotels h LEFT JOIN hotels m ON m.id = h.merged_into_hotel_id
          ${includeArchived ? '' : 'WHERE h.archived_at IS NULL'}
          ORDER BY h.archived_at IS NOT NULL, h.review_status = 'active', h.name`,
      ),
      findById: (id) => one('SELECT * FROM hotels WHERE id = ?', [id]),
      /** Case-insensitive match (the column collation is case-insensitive) among current hotels. */
      findCurrentByName: (name) => one(
        'SELECT * FROM hotels WHERE name = ? AND archived_at IS NULL ORDER BY id LIMIT 1',
        [name],
      ),
      insert: (fields) => insert('hotels', fields),
      update: (id, fields) => update('hotels', id, fields),
      repointBookings: (fromId, toId) => exec('UPDATE bookings SET hotel_id = ? WHERE hotel_id = ?', [toId, fromId]),
    },

    bookings: {
      list: ({ divisionId, status } = {}) => {
        const where = [];
        const params = [];
        if (divisionId) { where.push('b.division_id = ?'); params.push(divisionId); }
        if (status) { where.push('b.status = ?'); params.push(status); }
        return many(
          `${BOOKING_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY b.check_in_date IS NULL, b.check_in_date, b.id`,
          params,
        );
      },
      findById: (id) => one(`${BOOKING_SELECT} WHERE b.id = ?`, [id]),
      findByShareTokenHash: (hash) => one(`${BOOKING_SELECT} WHERE b.share_token_hash = ?`, [hash]),
      /** Locks the booking row for the rest of the transaction (status changes, imports). */
      lock: (id) => one('SELECT id FROM bookings WHERE id = ? FOR UPDATE', [id]),
      insert: (fields) => insert('bookings', fields),
      update: (id, fields) => update('bookings', id, fields),
    },

    employees: {
      listByBooking: (bookingId) => many(
        'SELECT * FROM booking_employees WHERE booking_id = ? ORDER BY is_vacant, name, id',
        [bookingId],
      ),
      /**
       * Travellers who take part in the process: not vacant, not cancelled.
       * Invitations, reminders, escalations, rooming and hotel lists must use this.
       */
      listActive: (bookingId) => many(
        `SELECT * FROM booking_employees
          WHERE booking_id = ? AND is_vacant = 0 AND cancelled_at IS NULL
          ORDER BY name, id`,
        [bookingId],
      ),
      findById: (bookingId, id) => one('SELECT * FROM booking_employees WHERE booking_id = ? AND id = ?', [bookingId, id]),
      /** By id alone: only for an employee session, which already names its employee. */
      findByIdOnly: (id) => one('SELECT * FROM booking_employees WHERE id = ?', [id]),
      /** Locks one employee row for the rest of the transaction (uploads). */
      lock: (id) => one('SELECT id FROM booking_employees WHERE id = ? FOR UPDATE', [id]),
      insert: (fields) => insert('booking_employees', fields),
      update: (id, fields) => update('booking_employees', id, fields),
      delete: (id) => exec('DELETE FROM booking_employees WHERE id = ?', [id]),
      deleteByBooking: (bookingId) => exec('DELETE FROM booking_employees WHERE booking_id = ?', [bookingId]),
      /**
       * Removes the rows that hang off employees (submissions and their file records,
       * codes, sessions) so the employees themselves can be deleted. Files on disk must
       * be removed by the caller (src/files/deletion.js).
       */
      async purgeRelated(employeeIds) {
        if (!employeeIds.length) return;
        const marks = employeeIds.map(() => '?').join(', ');
        await exec(
          `DELETE f FROM submission_files f JOIN submissions s ON s.id = f.submission_id
            WHERE s.booking_employee_id IN (${marks})`,
          employeeIds,
        );
        await exec(`DELETE FROM submissions WHERE booking_employee_id IN (${marks})`, employeeIds);
        await exec(`DELETE FROM employee_otp_codes WHERE booking_employee_id IN (${marks})`, employeeIds);
        await exec(`DELETE FROM employee_sessions WHERE booking_employee_id IN (${marks})`, employeeIds);
      },
      /** Employees with an upload on file (complete, or started with at least one file). */
      async countWithUploads(bookingId) {
        const rows = await conn.query(
          `SELECT COUNT(DISTINCT e.id) AS n FROM booking_employees e
             JOIN submissions s ON s.booking_employee_id = e.id
             JOIN submission_files f ON f.submission_id = s.id AND f.deleted_at IS NULL
            WHERE e.booking_id = ?`,
          [bookingId],
        );
        return Number(rows[0].n);
      },
    },

    employeeOtps: {
      insert: (fields) => insert('employee_otp_codes', fields),
      update: (id, fields) => update('employee_otp_codes', id, fields),
      findLatestActive: (employeeId, now) => one(
        `SELECT * FROM employee_otp_codes
          WHERE booking_employee_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ?
          ORDER BY id DESC LIMIT 1`,
        [employeeId, now],
      ),
      findLatest: (employeeId) => one(
        'SELECT * FROM employee_otp_codes WHERE booking_employee_id = ? ORDER BY id DESC LIMIT 1',
        [employeeId],
      ),
      async countSince(employeeId, since) {
        const rows = await conn.query(
          'SELECT COUNT(*) AS n FROM employee_otp_codes WHERE booking_employee_id = ? AND created_at >= ?',
          [employeeId, since],
        );
        return Number(rows[0].n);
      },
      async countFromIpSince(ip, since) {
        const rows = await conn.query(
          'SELECT COUNT(*) AS n FROM employee_otp_codes WHERE request_ip = ? AND created_at >= ?',
          [ip, since],
        );
        return Number(rows[0].n);
      },
      invalidateActive: (employeeId, at) => exec(
        `UPDATE employee_otp_codes SET invalidated_at = ?
          WHERE booking_employee_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [at, employeeId],
      ),
    },

    employeeSessions: {
      insert: (fields) => insert('employee_sessions', fields),
      findByTokenHash: (hash) => one('SELECT * FROM employee_sessions WHERE token_hash = ?', [hash]),
      update: (id, fields) => update('employee_sessions', id, fields),
      revokeAllForEmployee: (employeeId, at) => exec(
        'UPDATE employee_sessions SET revoked_at = ? WHERE booking_employee_id = ? AND revoked_at IS NULL',
        [at, employeeId],
      ),
    },

    submissions: {
      insert: (fields) => insert('submissions', fields),
      update: (id, fields) => update('submissions', id, fields),
      findById: (id) => one('SELECT * FROM submissions WHERE id = ?', [id]),
      /** The submission being filled in: not yet complete, not replaced, files not deleted. */
      findDraft: (employeeId) => one(
        `SELECT * FROM submissions
          WHERE booking_employee_id = ? AND submitted_at IS NULL AND superseded_at IS NULL AND files_deleted_at IS NULL
          ORDER BY id DESC LIMIT 1`,
        [employeeId],
      ),
      /** The complete submission currently on file. */
      markFilesDeleted: (ids, at, reason, byUserId) => (ids.length ? exec(
        `UPDATE submissions SET files_deleted_at = ?, files_deleted_reason = ?, files_deleted_by_user_id = ?
          WHERE id IN (${ids.map(() => '?').join(', ')}) AND files_deleted_at IS NULL`,
        [at, reason, byUserId, ...ids],
      ) : Promise.resolve(0)),
      markFilesDeletedForBooking: (bookingId, at, reason, byUserId) => exec(
        `UPDATE submissions s JOIN booking_employees e ON e.id = s.booking_employee_id
            SET s.files_deleted_at = ?, s.files_deleted_reason = ?, s.files_deleted_by_user_id = ?
          WHERE e.booking_id = ? AND s.files_deleted_at IS NULL`,
        [at, reason, byUserId, bookingId],
      ),
      findCurrent: (employeeId) => one(
        `SELECT * FROM submissions
          WHERE booking_employee_id = ? AND submitted_at IS NOT NULL AND superseded_at IS NULL AND files_deleted_at IS NULL
          ORDER BY id DESC LIMIT 1`,
        [employeeId],
      ),
    },

    files: {
      insert: (fields) => insert('submission_files', fields),
      update: (id, fields) => update('submission_files', id, fields),
      findById: (id) => one(
        `SELECT f.*, s.booking_employee_id, s.submitted_at, s.superseded_at
           FROM submission_files f JOIN submissions s ON s.id = f.submission_id
          WHERE f.id = ?`,
        [id],
      ),
      listBySubmission: (submissionId) => many(
        'SELECT * FROM submission_files WHERE submission_id = ? AND deleted_at IS NULL ORDER BY id',
        [submissionId],
      ),
      /** Files not yet deleted for these employees, oldest first. */
      listByEmployees: (employeeIds) => (employeeIds.length ? many(
        `SELECT f.*, s.booking_employee_id FROM submission_files f JOIN submissions s ON s.id = f.submission_id
          WHERE s.booking_employee_id IN (${employeeIds.map(() => '?').join(', ')}) AND f.deleted_at IS NULL
          ORDER BY f.id`,
        employeeIds,
      ) : Promise.resolve([])),
      markDeleted: (ids, at) => (ids.length ? exec(
        `UPDATE submission_files SET deleted_at = ? WHERE id IN (${ids.map(() => '?').join(', ')}) AND deleted_at IS NULL`,
        [at, ...ids],
      ) : Promise.resolve(0)),
      markDeletedForBooking: (bookingId, at) => exec(
        'UPDATE submission_files SET deleted_at = ? WHERE booking_id = ? AND deleted_at IS NULL',
        [at, bookingId],
      ),
      /** Every file of a booking not yet deleted: the list the deletion job works from. */
      listByBooking: (bookingId) => many(
        'SELECT * FROM submission_files WHERE booking_id = ? AND deleted_at IS NULL ORDER BY id',
        [bookingId],
      ),
    },

    sessions: {
      insert: (fields) => insert('sessions', fields),
      findByTokenHash: (hash) => one('SELECT * FROM sessions WHERE token_hash = ?', [hash]),
      update: (id, fields) => update('sessions', id, fields),
      revokeAllForUser: (userId, at, reason) => exec(
        'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
        [at, reason, userId],
      ),
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
      invalidateActive: (userId, purpose, at) => exec(
        `UPDATE otp_codes SET invalidated_at = ?
          WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [at, userId, purpose],
      ),
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
