'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { buildTestApp, request } = require('./helpers');
const { defineRoute } = require('../src/http/route');
const { sessionMiddleware } = require('../src/http/session');
const { sanitize } = require('../src/lib/sanitize');
const { toIstSql, toIstIso, formatIstDate, formatIstDateTime } = require('../src/lib/time');
const { HttpError } = require('../src/lib/errors');

const AADHAAR_LIKE = '2345 6789 0123';

describe('sanitize (log and audit redaction)', () => {
  it('redacts Aadhaar-shaped numbers in any grouping', () => {
    for (const value of ['234567890123', '2345 6789 0123', '2345-6789-0123', `note: ${AADHAAR_LIKE} end`]) {
      assert.ok(!/\d{4}[\s-]?\d{4}[\s-]?\d{4}/.test(sanitize(value)), value);
    }
  });

  it('keeps ordinary IDs, counts and 10-digit mobiles', () => {
    assert.deepEqual(sanitize({ bookingId: 42, count: 3, mobile: '9876543210' }), { bookingId: 42, count: 3, mobile: '9876543210' });
  });

  it('drops secret and Aadhaar-related keys', () => {
    const out = sanitize({
      password: 'x', newPassword: 'x', code: '123456', token: 't', passcode: 'p',
      aadhaarNumber: '1', imageData: 'x', ocrText: 'x', fileBase64: 'x', nested: { otp: '1', ok: true },
    });
    for (const key of ['password', 'newPassword', 'code', 'token', 'passcode', 'aadhaarNumber', 'imageData', 'ocrText', 'fileBase64']) {
      assert.equal(out[key], '[redacted]', key);
    }
    assert.deepEqual(out.nested, { otp: '[redacted]', ok: true });
  });

  it('omits binary data and long encoded strings', () => {
    assert.equal(sanitize(Buffer.from('file')), '[omitted: binary data]');
    assert.equal(sanitize('A'.repeat(300)), '[omitted: encoded data]');
    assert.ok(sanitize(`${'word '.repeat(200)}`).endsWith('…[truncated]'));
  });
});

describe('IST time helpers', () => {
  it('converts to IST wall-clock regardless of the server timezone', () => {
    // 18:30 UTC is midnight IST the next day.
    const date = new Date('2026-10-13T18:30:00.000Z');
    assert.equal(toIstSql(date), '2026-10-14 00:00:00.000');
    assert.equal(toIstIso(date), '2026-10-14T00:00:00.000+05:30');
    assert.equal(formatIstDate(date), '14/10/2026');
    assert.equal(formatIstDateTime(date), '14/10/2026 00:00 IST');
    assert.equal(toIstIso('2026-10-14 00:00:00.000'), '2026-10-14T00:00:00.000+05:30');
  });
});

describe('audit service', () => {
  let t;
  beforeEach(async () => { t = await buildTestApp(); });
  afterEach(() => t.close());

  it('rejects malformed entries', async () => {
    await assert.rejects(t.store.transaction((tx) => t.audit.record(tx, { action: 'Bad Action', actorType: 'user', outcome: 'success' })), /action/);
    await assert.rejects(t.store.transaction((tx) => t.audit.record(tx, { action: 'a.b', actorType: 'robot', outcome: 'success' })), /actorType/);
    await assert.rejects(t.store.transaction((tx) => t.audit.record(tx, { action: 'a.b', actorType: 'user', outcome: 'ok' })), /outcome/);
  });

  it('sanitises details before storing them', async () => {
    await t.store.transaction((tx) => t.audit.record(tx, {
      action: 'test.write', actorType: 'system', outcome: 'success',
      details: { note: `number ${AADHAAR_LIKE}`, password: 'secret-value' },
    }));
    const [entry] = await t.auditEntries('test.write');
    assert.ok(!JSON.stringify(entry).includes('6789'));
    assert.ok(!JSON.stringify(entry).includes('secret-value'));
  });

  it('exposes no way to update or delete entries', async () => {
    await t.store.transaction(async (tx) => {
      assert.deepEqual(Object.keys(tx.audit).sort(), ['insert', 'list']);
    });
  });

  describe('defineRoute', () => {
    let app;
    const NEW_EMAIL = 'rolled.back@alembic.co.in';

    beforeEach(async () => {
      await t.seedUser({ email: 'hosp@alembic.co.in', role: 'hospitality' });
      app = express();
      app.locals.deps = { config: t.config, store: t.store, audit: t.audit, clock: t.clock, mailer: t.mailer };
      app.use(express.json());
      app.use(sessionMiddleware(app.locals.deps));
      const router = express.Router();
      defineRoute(router, 'post', '/explode', { auth: 'public', audit: 'test.explode' }, async (ctx) => {
        await ctx.tx.users.insert({ email: NEW_EMAIL, name: 'X', role: 'hospitality', createdAt: '2026-10-14 10:00:00.000', updatedAt: '2026-10-14 10:00:00.000' });
        ctx.audit.entityType = 'user';
        throw new Error('boom after write');
      });
      defineRoute(router, 'post', '/reject', { auth: 'public', audit: 'test.reject' }, async () => {
        throw new HttpError(422, 'nope', 'Nope.');
      });
      defineRoute(router, 'post', '/write', { auth: 'public', audit: 'test.write' }, async (ctx) => {
        await ctx.tx.users.insert({ email: NEW_EMAIL, name: 'X', role: 'hospitality', createdAt: '2026-10-14 10:00:00.000', updatedAt: '2026-10-14 10:00:00.000' });
        return { status: 201 };
      });
      defineRoute(router, 'get', '/ok', { auth: 'public', audit: 'test.ok' }, async (ctx) => {
        ctx.audit.entityType = 'thing';
        ctx.audit.entityId = 7;
        ctx.audit.bookingId = 3;
        return { body: { ok: true } };
      });
      app.use(router);
      app.use((_err, _req, res, _next) => res.status(500).json({ error: 'internal_error' }));
    });

    it('records who, what, which record, when and where for a successful action', async () => {
      await request(app).get('/ok').set('User-Agent', 'test-agent').expect(200);
      const [entry] = await t.auditEntries('test.ok');
      assert.equal(entry.outcome, 'success');
      assert.equal(entry.entityType, 'thing');
      assert.equal(entry.entityId, '7');
      assert.equal(entry.bookingId, 3);
      assert.equal(entry.userAgent, 'test-agent');
      assert.ok(entry.ip);
      assert.match(entry.occurredAt, /^2026-10-14 10:00:00\.000$/);
    });

    it('rolls back the action when it fails, and still records the failure', async () => {
      const res = await request(app).post('/explode').send({});
      assert.equal(res.status, 500);
      const emails = (await t.store.dump('users')).map((u) => u.email);
      assert.ok(!emails.includes(NEW_EMAIL), 'the write was rolled back');
      const [entry] = await t.auditEntries('test.explode');
      assert.equal(entry.outcome, 'failure');
      assert.equal(entry.details.error, 'internal_error');
    });

    it('records client errors with their code', async () => {
      await request(app).post('/reject').send({}).expect(422);
      const [entry] = await t.auditEntries('test.reject');
      assert.equal(entry.outcome, 'failure');
      assert.equal(entry.details.error, 'nope');
    });

    it('rolls back the action if the audit entry cannot be written', async () => {
      const failingAudit = { record: async () => { throw new Error('audit store down'); } };
      app.locals.deps.audit = failingAudit;
      const res = await request(app).post('/write').send({});
      assert.equal(res.status, 500);
      const emails = (await t.store.dump('users')).map((u) => u.email);
      assert.ok(!emails.includes(NEW_EMAIL), 'no action commits without its audit entry');
    });
  });
});

describe('logger', () => {
  it('redacts Aadhaar-shaped numbers and secrets from log lines', () => {
    const logger = require('../src/lib/logger');
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    const lines = [];
    const original = process.stdout.write;
    process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
    try {
      logger.info('upload', { bookingId: 5, note: `aadhaar ${AADHAAR_LIKE}`, password: 'hunter22', file: Buffer.from('jpeg') });
    } finally {
      process.stdout.write = original;
      process.env.LOG_LEVEL = previous;
    }
    const line = lines.join('');
    assert.ok(line.includes('"bookingId":5'));
    assert.ok(!line.includes('6789'));
    assert.ok(!line.includes('hunter22'));
    assert.ok(!line.includes('jpeg'));
  });

  it('logs errors without their message, which may echo request data', () => {
    const logger = require('../src/lib/logger');
    const err = new Error(`Duplicate entry 'x@alembic.co.in' value ${AADHAAR_LIKE}`);
    err.code = 'ER_DUP_ENTRY';
    const fields = logger.errorFields(err);
    assert.equal(fields.errCode, 'ER_DUP_ENTRY');
    assert.ok(!JSON.stringify(fields).includes('Duplicate entry'));
  });
});
