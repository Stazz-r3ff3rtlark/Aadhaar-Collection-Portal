'use strict';

// Test harness. Tests run against a real MariaDB test database (default
// aadhaar_portal_test) on the server in backend/.env. Override with TEST_DB_HOST,
// TEST_DB_PORT, TEST_DB_USER, TEST_DB_PASSWORD, TEST_DB_NAME.
//
// Before each test the database is migrated (once per file) and every table is emptied,
// so the test user needs DROP privilege (for TRUNCATE). The name must end in "_test":
// the harness refuses to empty anything else.

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const request = require('supertest');
const { loadEnvFile } = require('../src/lib/env');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { createPool, createMariaDbStore } = require('../src/db/mariadb-store');
const { migrate } = require('../src/db/migrate');
const { createAuditService } = require('../src/audit/audit-service');
const { createMailer } = require('../src/mail/mailer');
const { toIstSql } = require('../src/lib/time');
const { toCamel, JSON_COLUMNS, BOOLEAN_COLUMNS } = require('../src/db/schema');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileStore } = require('../src/files/file-store');

loadEnvFile();

const APP_ORIGIN = 'https://portal.test';
const START = '2026-10-14T10:00:00.000+05:30';

const TEST_DB = {
  host: process.env.TEST_DB_HOST || process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT || process.env.DB_PORT || 3306),
  user: process.env.TEST_DB_USER || process.env.DB_USER || 'root',
  password: process.env.TEST_DB_PASSWORD ?? process.env.DB_PASSWORD ?? '',
  database: process.env.TEST_DB_NAME || 'aadhaar_portal_test',
};

if (!TEST_DB.database.endsWith('_test') || TEST_DB.database === process.env.DB_NAME) {
  throw new Error(`Refusing to run tests against "${TEST_DB.database}": the test database name must end in _test.`);
}

// Test divisions with fixed ids. Divisions are free, admin-managed names; these are
// arbitrary examples and nothing in the app depends on them.
const DIVISIONS = { MEGACARE: 1, MAXIS: 2, DIGILABS: 3 };

const TABLES = [
  'audit_log', 'otp_codes', 'sessions', 'employee_otp_codes', 'employee_sessions', 'submission_files', 'submissions', 'booking_employees',
  'rooming_list_versions', 'emergency_contacts', 'hotel_links', 'bookings', 'hotels', 'users', 'divisions',
];

let migrated = null;

async function resetDatabase(pool) {
  migrated ??= migrate(TEST_DB, { log: () => {} });
  await migrated;
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    // TRUNCATE does not fire the audit log's append-only DELETE trigger.
    for (const table of TABLES) await conn.query(`TRUNCATE TABLE ${table}`);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    await conn.query(
      `INSERT INTO divisions (id, name, created_at, updated_at) VALUES
        (1, 'Megacare', ?, ?), (2, 'Maxis', ?, ?), (3, 'Digilabs', ?, ?)`,
      Array(6).fill('2026-10-01 09:00:00.000'),
    );
  } finally {
    conn.release();
  }
}

function createTestClock(start = START) {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advanceMinutes(minutes) { current += minutes * 60 * 1000; },
    advanceSeconds(seconds) { current += seconds * 1000; },
    advanceDays(days) { current += days * 86_400_000; },
  };
}

async function buildTestApp() {
  const clock = createTestClock();
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_ORIGIN,
    OTP_SECRET: 'test-otp-secret-at-least-thirty-two-characters',
    MAIL_TRANSPORT: 'memory',
    BCRYPT_COST: '4',
    LINK_SECRET: 'test-link-secret-at-least-thirty-two-characters',
    FILE_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    // Each test app gets its own throwaway storage folder.
    STORAGE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'acp-test-storage-')),
  });
  const pool = createPool({ ...TEST_DB, connectionLimit: 4 });
  await resetDatabase(pool);
  const store = createMariaDbStore(pool);
  const mailer = createMailer(config);
  const audit = createAuditService({ clock });
  const fileStore = createFileStore({ storageDir: config.storageDir, key: config.fileEncryptionKey });
  const app = createApp({ config, store, mailer, clock, audit, fileStore });

  const t = {
    app,
    store,
    pool,
    mailer,
    clock,
    config,
    audit,
    fileStore,

    async close() {
      await pool.end();
      fs.rmSync(config.storageDir, { recursive: true, force: true });
    },

    /** Raw SQL for setting up states the API cannot reach yet (e.g. a finalised booking). */
    query: (sql, params) => pool.query(sql, params),

    /** All rows of a table, camelCased, in id order. */
    async dump(table) {
      const rows = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
      return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => {
        const key = toCamel(k);
        if (JSON_COLUMNS.has(key) && typeof v === 'string') return [key, JSON.parse(v)];
        if (BOOLEAN_COLUMNS.has(key)) return [key, Boolean(v)];
        return [key, v];
      })));
    },

    /** Adds a user to the allow-list directly. Coordinators default to Megacare, everyone else to Digilabs. */
    async seedUser({ email, name = 'Test User', role = 'hospitality', divisionId, isActive = true } = {}) {
      const now = toIstSql(clock.now());
      return store.transaction(async (tx) => {
        const id = await tx.users.insert({
          email,
          name,
          role,
          divisionId: divisionId ?? (role === 'coordinator' ? DIVISIONS.MEGACARE : DIVISIONS.DIGILABS),
          isActive,
          createdAt: now,
          updatedAt: now,
        });
        return tx.users.findById(id);
      });
    },

    /** The six-digit code in the most recent email to this address. */
    lastCode(email) {
      const message = mailer.outbox.filter((m) => m.to === email).at(-1);
      return message?.text.match(/\b(\d{6})\b/)?.[1];
    },

    mailCount: (email) => mailer.outbox.filter((m) => m.to === email).length,

    /** Signs in by emailed code and returns a supertest agent carrying the session cookie. */
    async signIn(email) {
      const agent = request.agent(app);
      await agent.post('/api/auth/otp/request').send({ email }).expect(202);
      await agent.post('/api/auth/otp/verify').send({ email, code: t.lastCode(email) }).expect(200);
      return agent;
    },

    async auditEntries(action) {
      const rows = await t.dump('audit_log');
      return action ? rows.filter((r) => r.action === action) : rows;
    },
  };
  return t;
}

/** A valid booking body; check-in 30/10/2026 is 16 days after the test clock's start. */
function bookingBody(overrides = {}) {
  return {
    hotelName: 'Taj Lands End',
    eventName: 'Annual Sales Meet',
    location: 'Mumbai',
    checkInDate: '30/10/2026',
    checkOutDate: '01/11/2026',
    ...overrides,
  };
}

/** A valid employee row. */
function employee(n, overrides = {}) {
  return {
    name: `Traveller ${n}`,
    employeeCode: `E${String(n).padStart(4, '0')}`,
    email: `traveller${n}@example.com`,
    mobile: `98765${String(n).padStart(5, '0')}`,
    department: 'Sales',
    zone: 'West',
    hq: 'Mumbai',
    isVacant: false,
    ...overrides,
  };
}

/** Imports employees straight away (preview is tested separately). */
function importEmployees(agent, bookingId, rows, mode = 'replace') {
  return agent.post(`/api/bookings/${bookingId}/employees/import`).send({ mode, rows });
}

module.exports = {
  buildTestApp, createTestClock, bookingBody, employee, importEmployees, APP_ORIGIN, DIVISIONS, request,
};
