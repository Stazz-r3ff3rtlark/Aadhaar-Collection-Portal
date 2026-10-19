'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildTestApp, bookingBody, DIVISIONS, request } = require('./helpers');

const { MEGACARE, MAXIS, DIGILABS } = DIVISIONS;

const ADMIN = 'admin@alembic.co.in';
const HOSPITALITY = 'hospitality@alembic.co.in';
const COORDINATOR = 'coordinator@alembic.co.in';

describe('admin console', () => {
  let t;
  let admin;
  let ids;

  beforeEach(async () => {
    t = await buildTestApp();
    ids = {
      admin: (await t.seedUser({ email: ADMIN, name: 'Admin', role: 'admin' })).id,
      hospitality: (await t.seedUser({ email: HOSPITALITY, name: 'Hospitality', role: 'hospitality' })).id,
      coordinator: (await t.seedUser({ email: COORDINATOR, name: 'Coordinator', role: 'coordinator', divisionId: MEGACARE })).id,
    };
    admin = await t.signIn(ADMIN);
  });
  afterEach(() => t.close());

  const userById = async (id) => (await admin.get('/api/admin/users')).body.users.find((u) => u.id === id);

  describe('divisions', () => {
    it('creates, renames, archives and restores a division, auditing each step', async () => {
      const created = await admin.post('/api/admin/divisions').send({ name: '  Field   Force ' }).expect(201);
      const { id } = created.body.division;
      assert.equal(created.body.division.name, 'Field Force');

      await admin.patch(`/api/admin/divisions/${id}`).send({ name: 'Field Sales' }).expect(200);
      const archived = await admin.post(`/api/admin/divisions/${id}/archive`).expect(200);
      assert.equal(archived.body.division.archived, true);
      const restored = await admin.post(`/api/admin/divisions/${id}/restore`).expect(200);
      assert.equal(restored.body.division.archived, false);

      const actions = (await t.auditEntries()).filter((e) => e.action.startsWith('admin.divisions.') && e.action !== 'admin.divisions.list');
      assert.deepEqual(actions.map((e) => e.action), [
        'admin.divisions.create', 'admin.divisions.rename', 'admin.divisions.archive', 'admin.divisions.restore',
      ]);
      assert.deepEqual(actions[1].details.changes, { name: { old: 'Field Force', new: 'Field Sales' } });
      assert.ok(actions.every((e) => e.actorEmail === ADMIN && e.entityId === String(id)));
    });

    it('accepts any free names: creates, renames and archives them in a flat list', async () => {
      const names = ['Business Excellence', 'Megacare West & Central (2027)', 'Zoë’s Field Team', 'BX-2'];
      const ids = [];
      for (const name of names) {
        const res = await admin.post('/api/admin/divisions').send({ name }).expect(201);
        assert.equal(res.body.division.name, name);
        ids.push(res.body.division.id);
      }

      const renamed = await admin.patch(`/api/admin/divisions/${ids[0]}`).send({ name: 'Business Excellence & Digital' }).expect(200);
      assert.equal(renamed.body.division.name, 'Business Excellence & Digital');
      await admin.post(`/api/admin/divisions/${ids[1]}/archive`).expect(200);

      const list = (await admin.get('/api/admin/divisions')).body.divisions;
      const byId = Object.fromEntries(list.map((d) => [d.id, d]));
      assert.equal(byId[ids[0]].name, 'Business Excellence & Digital');
      assert.equal(byId[ids[1]].archived, true);
      assert.equal(byId[ids[2]].name, 'Zoë’s Field Team');
      // Flat: a division is just a name and its state, with no parent or group.
      for (const d of list) {
        assert.deepEqual(Object.keys(d).sort(), ['archived', 'archivedAt', 'bookingCount', 'id', 'name', 'userCount']);
      }

      // A new name works like any other: users join it and coordinators book in it.
      await admin.post('/api/admin/users')
        .send({ email: 'bx.coord@alembic.co.in', name: 'BX Coordinator', role: 'coordinator', divisionId: ids[3] }).expect(201);
      const bx = await t.signIn('bx.coord@alembic.co.in');
      const booking = (await bx.post('/api/bookings').send(bookingBody()).expect(201)).body.booking;
      assert.equal(booking.divisionName, 'BX-2');
    });

    it('refuses duplicate names, ignoring case', async () => {
      const res = await admin.post('/api/admin/divisions').send({ name: 'megacare' });
      assert.equal(res.status, 409);
      await admin.patch(`/api/admin/divisions/${MAXIS}`).send({ name: 'MEGACARE' }).expect(409);
    });

    it('archives a division that has users or bookings, but never deletes it', async () => {
      const coordinator = await t.signIn(COORDINATOR);
      await coordinator.post('/api/bookings').send(bookingBody()).expect(201);

      const del = await admin.delete(`/api/admin/divisions/${MEGACARE}`);
      assert.equal(del.status, 409);
      assert.match(del.body.message, /Archive it instead/);
      await admin.post(`/api/admin/divisions/${MEGACARE}/archive`).expect(200);

      const del2 = await admin.delete(`/api/admin/divisions/${DIGILABS}`);
      assert.equal(del2.status, 409, 'a division with users only is protected too');

      const list = (await admin.get('/api/admin/divisions')).body.divisions;
      const megacare = list.find((d) => d.id === MEGACARE);
      assert.equal(megacare.archived, true);
      assert.equal(megacare.userCount, 1);
      assert.equal(megacare.bookingCount, 1);
    });

    it('deletes an unused division', async () => {
      const { id } = (await admin.post('/api/admin/divisions').send({ name: 'Typo Divison' })).body.division;
      await admin.delete(`/api/admin/divisions/${id}`).expect(204);
      const [entry] = await t.auditEntries('admin.divisions.delete');
      assert.equal(entry.outcome, 'success');
      assert.equal(entry.details.name, 'Typo Divison');
    });

    it('archived divisions are not offered for new users or moves, but existing members keep them', async () => {
      await admin.post(`/api/admin/divisions/${MAXIS}/archive`).expect(200);
      const add = await admin.post('/api/admin/users')
        .send({ email: 'new@alembic.co.in', name: 'New', role: 'hospitality', divisionId: MAXIS });
      assert.equal(add.status, 400);
      assert.equal(add.body.error, 'division_archived');

      await admin.patch(`/api/admin/users/${ids.coordinator}`).send({ divisionId: MAXIS }).expect(400);

      // A user already in an archived division can still be edited without moving.
      await admin.post(`/api/admin/divisions/${MEGACARE}/archive`).expect(200);
      await admin.patch(`/api/admin/users/${ids.coordinator}`).send({ name: 'Renamed Coordinator' }).expect(200);

      const active = (await (await t.signIn(HOSPITALITY)).get('/api/divisions')).body.divisions.map((d) => d.name);
      assert.deepEqual(active, ['Digilabs']);
    });

    it('coordinators in an archived division cannot create bookings', async () => {
      await admin.post(`/api/admin/divisions/${MEGACARE}/archive`).expect(200);
      const coordinator = await t.signIn(COORDINATOR);
      const res = await coordinator.post('/api/bookings').send(bookingBody());
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'division_archived');
    });
  });

  describe('users', () => {
    it('requires a division for every role', async () => {
      for (const role of ['admin', 'hospitality', 'coordinator', 'analytics_viewer']) {
        const res = await admin.post('/api/admin/users').send({ email: `${role}2@alembic.co.in`, name: 'X', role });
        assert.equal(res.status, 400, role);
        assert.equal(res.body.error, 'invalid_division');
      }
      const ok = await admin.post('/api/admin/users')
        .send({ email: 'viewer@alembic.co.in', name: 'Viewer', role: 'analytics_viewer', divisionId: MEGACARE }).expect(201);
      assert.equal(ok.body.user.divisionId, MEGACARE);
    });

    it('edits name, email, role and division, recording old and new values', async () => {
      const res = await admin.patch(`/api/admin/users/${ids.hospitality}`).send({
        name: 'Hosp Team', email: 'Hosp.Team@alembic.co.in', role: 'coordinator', divisionId: MAXIS,
      }).expect(200);
      assert.equal(res.body.user.email, 'hosp.team@alembic.co.in');
      assert.equal(res.body.user.divisionName, 'Maxis');

      const [entry] = await t.auditEntries('admin.users.update');
      assert.deepEqual(entry.details.changes, {
        name: { old: 'Hospitality', new: 'Hosp Team' },
        email: { old: HOSPITALITY, new: 'hosp.team@alembic.co.in' },
        role: { old: 'hospitality', new: 'coordinator' },
        divisionId: { old: DIGILABS, new: MAXIS },
      });
      assert.equal(entry.actorEmail, ADMIN);
    });

    it('keeps edited emails on @alembic.co.in and unique', async () => {
      const other = await admin.patch(`/api/admin/users/${ids.hospitality}`).send({ email: 'hosp@gmail.com' });
      assert.equal(other.status, 400);
      assert.equal(other.body.error, 'email_domain_not_allowed');
      const taken = await admin.patch(`/api/admin/users/${ids.hospitality}`).send({ email: COORDINATOR.toUpperCase() });
      assert.equal(taken.status, 409);
    });

    it('refuses unknown fields such as password hashes', async () => {
      await admin.patch(`/api/admin/users/${ids.hospitality}`).send({ passwordHash: 'x' }).expect(400);
    });

    describe('session end on change', () => {
      for (const [label, change] of [
        ['a name edit', { name: 'New Name' }],
        ['an email change', { email: 'moved@alembic.co.in' }],
        ['a role change', { role: 'hospitality' }],
        ['a division change', { divisionId: MAXIS }],
        ['deactivation', { isActive: false }],
      ]) {
        it(`signs the user out at once after ${label}`, async () => {
          const victim = await t.signIn(COORDINATOR);
          await victim.get('/api/auth/me').expect(200);
          await admin.patch(`/api/admin/users/${ids.coordinator}`).send(change).expect(200);
          await victim.get('/api/auth/me').expect(401);
          const [entry] = await t.auditEntries('admin.users.update');
          assert.equal(entry.details.sessionsRevoked, 1);
        });
      }

      it('signs the user out when the account is deleted', async () => {
        const res = await admin.post('/api/admin/users')
          .send({ email: 'fresh@alembic.co.in', name: 'Fresh', role: 'hospitality', divisionId: DIGILABS }).expect(201);
        // A session that exists without any audited action (direct insert) is still removed.
        await t.query(
          `INSERT INTO sessions (token_hash, user_id, auth_method, created_at, last_seen_at, expires_at)
           VALUES (REPEAT('a', 64), ?, 'otp', '2026-10-14 10:00:00.000', '2026-10-14 10:00:00.000', '2026-10-14 22:00:00.000')`,
          [res.body.user.id],
        );
        await admin.delete(`/api/admin/users/${res.body.user.id}`).expect(204);
        assert.equal((await t.dump('sessions')).filter((s) => s.userId === res.body.user.id).length, 0);
      });

      it('a moved coordinator loses the old division\'s bookings and gains the new one\'s', async () => {
        const coordinator = await t.signIn(COORDINATOR);
        const { id } = (await coordinator.post('/api/bookings').send(bookingBody())).body.booking;
        await admin.patch(`/api/admin/users/${ids.coordinator}`).send({ divisionId: MAXIS }).expect(200);
        t.clock.advanceSeconds(61); // one sign-in code per minute
        const again = await t.signIn(COORDINATOR);
        await again.get(`/api/bookings/${id}`).expect(404);
        assert.equal((await again.get('/api/bookings')).body.bookings.length, 0);
      });
    });

    describe('delete only if never used', () => {
      it('deletes an account created by mistake that never acted', async () => {
        const res = await admin.post('/api/admin/users')
          .send({ email: 'mistake@alembic.co.in', name: 'Mistake', role: 'hospitality', divisionId: DIGILABS }).expect(201);
        // Requesting a code is not acting: it does not make the account undeletable.
        await request(t.app).post('/api/auth/otp/request').send({ email: 'mistake@alembic.co.in' });

        await admin.delete(`/api/admin/users/${res.body.user.id}`).expect(204);
        assert.equal(await userById(res.body.user.id), undefined);
        const [entry] = await t.auditEntries('admin.users.delete');
        assert.equal(entry.outcome, 'success');
        assert.equal(entry.details.old.email, 'mistake@alembic.co.in');
      });

      it('refuses to delete anyone who has signed in, and says to deactivate instead', async () => {
        await t.signIn(HOSPITALITY);
        const res = await admin.delete(`/api/admin/users/${ids.hospitality}`);
        assert.equal(res.status, 409);
        assert.equal(res.body.error, 'user_has_history');
        assert.match(res.body.message, /Deactivate it instead/);
        assert.ok(await userById(ids.hospitality), 'still there');
      });

      it('refuses to delete a user whose only trace is a booking', async () => {
        const { id: bookingId } = (await (await t.signIn(COORDINATOR)).post('/api/bookings').send(bookingBody())).body.booking;
        // Remove the coordinator's audit trail from the picture: a booking alone must block deletion.
        const other = await t.seedUser({ email: 'ghost@alembic.co.in', role: 'coordinator', divisionId: MEGACARE });
        await t.query('UPDATE bookings SET updated_by_user_id = ? WHERE id = ?', [other.id, bookingId]);
        const res = await admin.delete(`/api/admin/users/${other.id}`);
        assert.equal(res.status, 409);
        assert.equal(res.body.error, 'user_has_history');
      });

      it('refuses to delete an admin who has added users', async () => {
        const second = await t.seedUser({ email: 'second.admin@alembic.co.in', role: 'admin' });
        await t.query('UPDATE users SET created_by_user_id = ? WHERE id = ?', [second.id, ids.hospitality]);
        await admin.delete(`/api/admin/users/${second.id}`).expect(409);
      });

      it('refuses after a deactivated user had acted before', async () => {
        await t.signIn(COORDINATOR);
        await admin.patch(`/api/admin/users/${ids.coordinator}`).send({ isActive: false }).expect(200);
        await admin.delete(`/api/admin/users/${ids.coordinator}`).expect(409);
        await admin.patch(`/api/admin/users/${ids.coordinator}`).send({ isActive: true }).expect(200);
        assert.equal((await userById(ids.coordinator)).isActive, true, 'reactivated');
      });
    });

    describe('last-admin and self protection', () => {
      it('never removes the last active admin, even by themselves', async () => {
        for (const change of [{ isActive: false }, { role: 'hospitality' }]) {
          const res = await admin.patch(`/api/admin/users/${ids.admin}`).send(change);
          assert.equal(res.status, 409);
          assert.equal(res.body.error, 'last_admin');
        }
        const del = await admin.delete(`/api/admin/users/${ids.admin}`);
        assert.equal(del.status, 409);
        assert.equal(del.body.error, 'last_admin');
        assert.equal((await userById(ids.admin)).isActive, true);
      });

      it('with two admins, an admin still cannot deactivate, demote or delete themselves', async () => {
        await t.seedUser({ email: 'second.admin@alembic.co.in', role: 'admin' });
        for (const change of [{ isActive: false }, { role: 'hospitality' }]) {
          const res = await admin.patch(`/api/admin/users/${ids.admin}`).send(change);
          assert.equal(res.status, 400);
          assert.equal(res.body.error, 'cannot_change_self');
        }
        await admin.delete(`/api/admin/users/${ids.admin}`).expect(400);
      });

      it('an admin can remove another admin while one active admin remains', async () => {
        const second = await t.seedUser({ email: 'second.admin@alembic.co.in', role: 'admin' });
        await admin.patch(`/api/admin/users/${second.id}`).send({ role: 'hospitality' }).expect(200);
        await admin.patch(`/api/admin/users/${second.id}`).send({ role: 'admin' }).expect(200);
        await admin.patch(`/api/admin/users/${second.id}`).send({ isActive: false }).expect(200);
      });

      it('an inactive admin does not count as the remaining admin', async () => {
        await t.seedUser({ email: 'second.admin@alembic.co.in', role: 'admin', isActive: false });
        // The only active admin is ADMIN; demoting them is refused even though another (inactive) admin exists.
        const res = await admin.patch(`/api/admin/users/${ids.admin}`).send({ role: 'hospitality' });
        assert.equal(res.status, 409);
        assert.equal(res.body.error, 'last_admin');
      });

      it('admins can edit their own name and are signed out by it', async () => {
        await admin.patch(`/api/admin/users/${ids.admin}`).send({ name: 'Renamed Admin' }).expect(200);
        await admin.get('/api/auth/me').expect(401);
      });
    });
  });
});
