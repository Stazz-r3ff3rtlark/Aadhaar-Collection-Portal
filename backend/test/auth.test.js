'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildTestApp, request, APP_ORIGIN } = require('./helpers');

const EMAIL = 'asha.rao@alembic.co.in';
const PASSWORD = 'correct horse battery';

describe('internal sign-in', () => {
  let t;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.seedUser({ email: EMAIL, name: 'Asha Rao', role: 'hospitality' });
  });
  afterEach(() => t.close());

  describe('allow-list', () => {
    it('gives other domains the same neutral answer and sends nothing', async () => {
      const known = await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL });
      const res = await request(t.app).post('/api/auth/otp/request').send({ email: 'asha@gmail.com' });
      assert.equal(res.status, 202);
      assert.deepEqual(res.body, known.body);
      assert.equal(res.body.message, 'If this email is registered, a code has been sent.');
      assert.equal(t.mailCount('asha@gmail.com'), 0);
      const entry = (await t.auditEntries('auth.otp.request')).find((e) => e.details.claimedEmail === 'asha@gmail.com');
      assert.equal(entry.outcome, 'failure');
      assert.equal(entry.details.reason, 'email_domain_not_allowed');
    });

    it('treats look-alike domains as other domains', async () => {
      for (const email of ['asha@alembic.co.in.evil.com', 'asha@notalembic.co.in', 'asha@alembic.co']) {
        const res = await request(t.app).post('/api/auth/otp/request').send({ email });
        assert.equal(res.status, 202, email);
      }
      assert.equal(t.mailer.outbox.length, 0);
    });

    it('still rejects text that is not an email address', async () => {
      const res = await request(t.app).post('/api/auth/otp/request').send({ email: 'not an email' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_email');
    });

    it('does not send a code to a company email that an admin has not added, and does not reveal that', async () => {
      const stranger = 'not.added@alembic.co.in';
      const known = await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL });
      const unknown = await request(t.app).post('/api/auth/otp/request').send({ email: stranger });
      assert.equal(unknown.status, 202);
      assert.deepEqual(unknown.body, known.body);
      assert.equal(t.mailCount(stranger), 0);
      const entries = await t.auditEntries('auth.otp.request');
      const strangerEntry = entries.find((e) => e.details.claimedEmail === stranger);
      assert.equal(strangerEntry.outcome, 'failure');
      assert.equal(strangerEntry.details.reason, 'not_on_allow_list');
    });

    it('gives a deactivated user the same neutral answer and no code', async () => {
      const email = 'former@alembic.co.in';
      await t.seedUser({ email, isActive: false });
      const known = await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL });
      const res = await request(t.app).post('/api/auth/otp/request').send({ email });
      assert.equal(res.status, 202);
      assert.deepEqual(res.body, known.body);
      assert.equal(t.mailCount(email), 0);
      const verify = await request(t.app).post('/api/auth/otp/verify').send({ email, code: '123456' });
      assert.equal(verify.status, 401);
      assert.equal(verify.body.message, 'That code is not valid or has expired.');
    });

    it('treats email case and surrounding spaces as the same address', async () => {
      const agent = request.agent(t.app);
      await agent.post('/api/auth/otp/request').send({ email: '  Asha.Rao@Alembic.CO.IN ' }).expect(202);
      const code = t.lastCode(EMAIL);
      assert.ok(code);
      await agent.post('/api/auth/otp/verify').send({ email: 'ASHA.RAO@alembic.co.in', code }).expect(200);
    });
  });

  describe('email one-time code', () => {
    it('signs in with a valid code and starts a session', async () => {
      const agent = request.agent(t.app);
      await agent.post('/api/auth/otp/request').send({ email: EMAIL }).expect(202);
      const code = t.lastCode(EMAIL);
      assert.match(code, /^\d{6}$/);
      assert.match(t.mailer.outbox[0].text, /expires at \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} IST/);

      const res = await agent.post('/api/auth/otp/verify').send({ email: EMAIL, code }).expect(200);
      assert.equal(res.body.user.email, EMAIL);
      assert.equal(res.body.user.role, 'hospitality');
      assert.equal(res.body.user.passwordHash, undefined);

      const me = await agent.get('/api/auth/me').expect(200);
      assert.equal(me.body.user.email, EMAIL);

      const [login] = await t.auditEntries('auth.login.otp');
      assert.equal(login.outcome, 'success');
      assert.equal(login.actorType, 'user');
      assert.equal(login.actorEmail, EMAIL);
      assert.equal(login.actorRole, 'hospitality');
      assert.match(login.occurredAt, /^2026-10-14 10:00:00\.\d{3}$/, 'audit time is IST wall-clock');
    });

    it('sets a HttpOnly, SameSite=Lax session cookie', async () => {
      await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL });
      const res = await request(t.app).post('/api/auth/otp/verify').send({ email: EMAIL, code: t.lastCode(EMAIL) });
      const cookie = res.headers['set-cookie'].join(';');
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
      assert.match(cookie, /Path=\//);
    });

    it('rejects a wrong code, and burns the code after 5 wrong attempts', async () => {
      await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL });
      const code = t.lastCode(EMAIL);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i += 1) {
        const res = await request(t.app).post('/api/auth/otp/verify').send({ email: EMAIL, code: wrong });
        assert.equal(res.status, 401);
      }
      const late = await request(t.app).post('/api/auth/otp/verify').send({ email: EMAIL, code });
      assert.equal(late.status, 401, 'the correct code no longer works');
      const entries = await t.auditEntries('auth.login.otp');
      assert.equal(entries[4].details.reason, 'wrong_code_attempts_exhausted');
      assert.equal(entries[5].details.reason, 'no_active_code');
    });

    it('rejects an expired code', async () => {
      await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL });
      const code = t.lastCode(EMAIL);
      t.clock.advanceMinutes(11);
      const res = await request(t.app).post('/api/auth/otp/verify').send({ email: EMAIL, code });
      assert.equal(res.status, 401);
      assert.equal(res.body.message, 'That code is not valid or has expired.');
    });

    it('accepts a code only once', async () => {
      await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL });
      const code = t.lastCode(EMAIL);
      await request(t.app).post('/api/auth/otp/verify').send({ email: EMAIL, code }).expect(200);
      await request(t.app).post('/api/auth/otp/verify').send({ email: EMAIL, code }).expect(401);
    });

    it('invalidates the previous code when a new one is requested', async () => {
      await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL });
      const first = t.lastCode(EMAIL);
      t.clock.advanceSeconds(61);
      await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL });
      const second = t.lastCode(EMAIL);
      if (first !== second) {
        await request(t.app).post('/api/auth/otp/verify').send({ email: EMAIL, code: first }).expect(401);
      }
      await request(t.app).post('/api/auth/otp/verify').send({ email: EMAIL, code: second }).expect(200);
    });

    it('throttles code requests: one per minute and five per hour', async () => {
      await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL }).expect(202);
      await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL }).expect(202);
      assert.equal(t.mailCount(EMAIL), 1, 'second request inside the cooldown sends nothing');

      for (let i = 0; i < 6; i += 1) {
        t.clock.advanceSeconds(61);
        await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL }).expect(202);
      }
      assert.equal(t.mailCount(EMAIL), 5, 'capped at five per hour');
      const throttled = (await t.auditEntries('auth.otp.request')).filter((e) => e.details.reason === 'throttled');
      assert.equal(throttled.length, 3);
    });
  });

  describe('password', () => {
    async function setPassword(password = PASSWORD) {
      await request(t.app).post('/api/auth/password/reset/request').send({ email: EMAIL }).expect(202);
      return request(t.app).post('/api/auth/password/reset/confirm')
        .send({ email: EMAIL, code: t.lastCode(EMAIL), newPassword: password });
    }

    it('cannot sign in by password before one is set', async () => {
      const res = await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: PASSWORD });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'invalid_credentials');
    });

    it('sets a password through an emailed code, then signs in with it', async () => {
      const set = await setPassword();
      assert.equal(set.status, 200);
      const agent = request.agent(t.app);
      const res = await agent.post('/api/auth/password/login').send({ email: EMAIL, password: PASSWORD });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.hasPassword, true);
      await agent.get('/api/auth/me').expect(200);
      const [entry] = await t.auditEntries('auth.login.password');
      assert.equal(entry.outcome, 'success');
      assert.equal(entry.details.method, 'password');
    });

    it('stores only a bcrypt hash', async () => {
      await setPassword();
      const [user] = await t.dump('users');
      assert.match(user.passwordHash, /^\$2[aby]\$\d{2}\$/);
      assert.ok(!user.passwordHash.includes(PASSWORD));
    });

    it('requires at least 10 characters', async () => {
      const res = await setPassword('short-pw1');
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'weak_password');
    });

    it('refuses passwords longer than bcrypt can check', async () => {
      const res = await setPassword('x'.repeat(73));
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'password_too_long');
    });

    it('rejects a reset with a sign-in code (codes are bound to their purpose)', async () => {
      await request(t.app).post('/api/auth/otp/request').send({ email: EMAIL });
      const res = await request(t.app).post('/api/auth/password/reset/confirm')
        .send({ email: EMAIL, code: t.lastCode(EMAIL), newPassword: PASSWORD });
      assert.equal(res.status, 401);
    });

    it('locks password sign-in for 15 minutes after 5 failed attempts', async () => {
      await setPassword();
      for (let i = 0; i < 4; i += 1) {
        await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: 'wrong password!' }).expect(401);
      }
      const fifth = await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: 'wrong password!' });
      assert.equal(fifth.status, 429);
      assert.equal(fifth.body.error, 'locked');

      const whileLocked = await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: PASSWORD });
      assert.equal(whileLocked.status, 429, 'even the right password is refused while locked');

      t.clock.advanceMinutes(14);
      await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: PASSWORD }).expect(429);
      t.clock.advanceMinutes(2);
      await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

      const entries = await t.auditEntries('auth.login.password');
      assert.ok(entries.some((e) => e.details.reason === 'wrong_password_locked'));
      assert.ok(entries.some((e) => e.outcome === 'denied' && e.details.reason === 'locked'));
    });

    it('still allows an emailed code while the password is locked', async () => {
      await setPassword();
      for (let i = 0; i < 5; i += 1) {
        await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: 'wrong password!' });
      }
      t.clock.advanceSeconds(61);
      await t.signIn(EMAIL);
    });

    it('resets the failure counter after a successful sign-in', async () => {
      await setPassword();
      for (let i = 0; i < 4; i += 1) {
        await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: 'wrong password!' });
      }
      await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: PASSWORD }).expect(200);
      await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: 'wrong password!' }).expect(401);
    });

    it('ends every existing session when the password is reset', async () => {
      const agent = await t.signIn(EMAIL);
      t.clock.advanceSeconds(61);
      await setPassword();
      await agent.get('/api/auth/me').expect(401);
    });

    it('gives the same answer for unknown users and wrong passwords', async () => {
      await setPassword();
      const wrong = await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: 'wrong password!' });
      const unknown = await request(t.app).post('/api/auth/password/login')
        .send({ email: 'nobody@alembic.co.in', password: 'wrong password!' });
      assert.equal(wrong.status, unknown.status);
      assert.deepEqual(wrong.body, unknown.body);
    });
  });

  describe('sessions', () => {
    it('signs out and revokes the session', async () => {
      const agent = await t.signIn(EMAIL);
      await agent.post('/api/auth/logout').expect(204);
      await agent.get('/api/auth/me').expect(401);
      const [entry] = await t.auditEntries('auth.logout');
      assert.equal(entry.actorEmail, EMAIL);
    });

    it('expires after 2 hours idle, and records the expiry', async () => {
      const agent = await t.signIn(EMAIL);
      t.clock.advanceMinutes(90);
      await agent.get('/api/auth/me').expect(200);
      t.clock.advanceMinutes(121);
      await agent.get('/api/auth/me').expect(401);
      const [entry] = await t.auditEntries('auth.session.expire');
      assert.equal(entry.actorType, 'system');
      assert.equal(entry.details.reason, 'idle_timeout');
    });

    it('expires 12 hours after sign-in even when active', async () => {
      const agent = await t.signIn(EMAIL);
      for (let i = 0; i < 12; i += 1) {
        t.clock.advanceMinutes(60);
        if (i < 11) await agent.get('/api/auth/me').expect(200);
      }
      await agent.get('/api/auth/me').expect(401);
    });

    it('ignores forged session cookies', async () => {
      await request(t.app).get('/api/auth/me').set('Cookie', 'acp_session=forged-token').expect(401);
    });
  });

  describe('request safety', () => {
    it('blocks state-changing requests from another origin, and audits them', async () => {
      const res = await request(t.app).post('/api/auth/otp/request')
        .set('Origin', 'https://evil.example').send({ email: EMAIL });
      assert.equal(res.status, 403);
      assert.equal(t.mailer.outbox.length, 0);
      const [entry] = await t.auditEntries('security.request_blocked');
      assert.equal(entry.outcome, 'denied');
    });

    it('accepts requests from the portal origin', async () => {
      await request(t.app).post('/api/auth/otp/request').set('Origin', APP_ORIGIN).send({ email: EMAIL }).expect(202);
    });

    it('never writes codes, passwords or hashes to the audit log', async () => {
      await request(t.app).post('/api/auth/password/reset/request').send({ email: EMAIL });
      const code = t.lastCode(EMAIL);
      await request(t.app).post('/api/auth/password/reset/confirm').send({ email: EMAIL, code, newPassword: PASSWORD });
      await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: PASSWORD });
      await request(t.app).post('/api/auth/password/login').send({ email: EMAIL, password: 'a wrong one!!' });
      const [user] = await t.dump('users');
      const log = JSON.stringify(await t.auditEntries());
      for (const secret of [code, PASSWORD, 'a wrong one!!', user.passwordHash]) {
        assert.ok(!log.includes(secret), `audit log contains a secret: ${secret.slice(0, 4)}…`);
      }
    });
  });
});
