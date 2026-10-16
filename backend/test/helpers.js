'use strict';

// Test harness. By default the app runs on the in-memory store. To run the same tests
// against a real MariaDB (recommended in CI), set TEST_DB_HOST, TEST_DB_PORT,
// TEST_DB_USER, TEST_DB_PASSWORD and TEST_DB_NAME. The database is migrated and its
// sign-in and audit tables are emptied before each test. Never point this at production.

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { createMemoryStore } = require('../src/db/memory-store');
const { createAuditService } = require('../src/audit/audit-service');
const { createMailer } = require('../src/mail/mailer');
const { toIstSql } = require('../src/lib/time');

const APP_ORIGIN = 'https://portal.test';
const START = '2026-10-14T10:00:00.000+05:30';

function createTestClock(start = START) {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advanceMinutes(minutes) { current += minutes * 60 * 1000; },
    advanceSeconds(seconds) { current += seconds * 1000; },
  };
}

let mariaDbReady = null;

async function createMariaDbTestStore() {
  const { createPool, createMariaDbStore } = require('../src/db/mariadb-store');
  const { migrate } = require('../src/db/migrate');
  const db = {
    host: process.env.TEST_DB_HOST || '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT || 3306),
    user: process.env.TEST_DB_USER,
    password: process.env.TEST_DB_PASSWORD || '',
    database: process.env.TEST_DB_NAME,
    connectionLimit: 2,
  };
  mariaDbReady ??= migrate(db, { log: () => {} });
  await mariaDbReady;
  const pool = createPool(db);
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    // TRUNCATE does not fire the append-only DELETE trigger; it needs DROP privilege,
    // which only a test database user should ever have.
    for (const table of ['audit_log', 'otp_codes', 'sessions', 'users']) await conn.query(`TRUNCATE TABLE ${table}`);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
  const store = createMariaDbStore(pool);
  const { toCamel } = require('../src/db/schema');
  store.dump = async (table) => (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).map((row) => (
    Object.fromEntries(Object.entries(row).map(([k, v]) => [
      toCamel(k),
      k === 'details' && typeof v === 'string' ? JSON.parse(v) : v,
    ]))
  ));
  return store;
}

async function buildTestApp() {
  const clock = createTestClock();
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_ORIGIN,
    OTP_SECRET: 'test-otp-secret-at-least-thirty-two-characters',
    MAIL_TRANSPORT: 'memory',
    BCRYPT_COST: '4',
  });
  const store = process.env.TEST_DB_NAME ? await createMariaDbTestStore() : createMemoryStore();
  const mailer = createMailer(config);
  const audit = createAuditService({ clock });
  const app = createApp({ config, store, mailer, clock, audit });

  const t = {
    app,
    store,
    mailer,
    clock,
    config,
    audit,

    async close() {
      await store.close();
    },

    /** Adds a user to the allow-list directly. */
    async seedUser({ email, name = 'Test User', role = 'hospitality', divisionId, isActive = true } = {}) {
      const now = toIstSql(clock.now());
      return store.transaction(async (tx) => {
        const id = await tx.users.insert({
          email,
          name,
          role,
          divisionId: role === 'coordinator' ? (divisionId ?? 1) : null,
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
      const rows = await store.dump('audit_log');
      return action ? rows.filter((r) => r.action === action) : rows;
    },
  };
  return t;
}

module.exports = { buildTestApp, createTestClock, APP_ORIGIN, request };
