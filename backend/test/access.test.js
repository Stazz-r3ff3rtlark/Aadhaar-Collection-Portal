'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { buildTestApp, request } = require('./helpers');
const policy = require('../src/auth/policy');
const { defineRoute } = require('../src/http/route');

const { can, canViewBooking, canEditBooking, canFinaliseBooking, canViewAadhaar, PERMISSIONS } = policy;

const MARKETING = 1;
const BUSINESS_ENABLERS = 2;

const users = {
  admin: { id: 1, role: 'admin', isActive: true, divisionId: null },
  hospitality: { id: 2, role: 'hospitality', isActive: true, divisionId: null },
  coordinator: { id: 3, role: 'coordinator', isActive: true, divisionId: MARKETING },
  analytics: { id: 4, role: 'analytics_viewer', isActive: true, divisionId: null },
};

const booking = (status, divisionId = MARKETING) => ({ id: 10, status, divisionId });

describe('access rules (policy)', () => {
  it('grants each permission only to the roles in the PRD roles table', () => {
    const expected = {
      admin: ['users.manage', 'divisions.manage', 'hotels.manage', 'settings.manage', 'audit.read',
        'bookings.history.read', 'analytics.read'],
      hospitality: ['bookings.read', 'bookings.edit', 'bookings.history.read', 'bookings.reopen',
        'deadlines.extend', 'guests.cancel', 'emergency_contacts.manage', 'hotel_links.manage',
        'files.delete', 'guests.verify', 'aadhaar.view'],
      coordinator: ['bookings.create', 'bookings.read', 'bookings.edit', 'bookings.finalise', 'aadhaar.view'],
      analytics: ['analytics.read'],
    };
    for (const [who, allowed] of Object.entries(expected)) {
      for (const permission of Object.keys(PERMISSIONS)) {
        assert.equal(can(users[who], permission), allowed.includes(permission), `${who} / ${permission}`);
      }
    }
  });

  it('only hospitality can extend deadlines, reopen, cancel guests or delete files', () => {
    for (const permission of ['deadlines.extend', 'bookings.reopen', 'guests.cancel', 'files.delete', 'hotel_links.manage']) {
      assert.deepEqual(PERMISSIONS[permission], ['hospitality'], permission);
    }
  });

  it('never lets admins or analytics viewers see Aadhaar files', () => {
    for (const status of ['draft', 'collecting', 'finalised', 'shared_with_hotel']) {
      assert.equal(canViewAadhaar(users.admin, booking(status)), false);
      assert.equal(canViewAadhaar(users.analytics, booking(status)), false);
    }
  });

  it('denies everything to deactivated users, unknown roles and anonymous callers', () => {
    const inactive = { ...users.hospitality, isActive: false };
    const strange = { id: 9, role: 'superuser', isActive: true };
    for (const permission of Object.keys(PERMISSIONS)) {
      assert.equal(can(inactive, permission), false);
      assert.equal(can(strange, permission), false);
      assert.equal(can(null, permission), false);
    }
    assert.equal(canViewBooking(inactive, booking('collecting')), false);
  });

  it('throws on a misspelt permission instead of silently denying or allowing', () => {
    assert.throws(() => can(users.admin, 'user.manage'), /Unknown permission/);
  });

  describe('coordinators', () => {
    it('see only their own division\'s bookings', () => {
      assert.equal(canViewBooking(users.coordinator, booking('collecting', MARKETING)), true);
      assert.equal(canViewBooking(users.coordinator, booking('collecting', BUSINESS_ENABLERS)), false);
      assert.equal(canEditBooking(users.coordinator, booking('collecting', BUSINESS_ENABLERS)), false);
      assert.equal(canViewAadhaar(users.coordinator, booking('collecting', BUSINESS_ENABLERS)), false);
    });

    it('edit, finalise and view Aadhaar only before finalise', () => {
      for (const status of ['draft', 'collecting']) {
        assert.equal(canEditBooking(users.coordinator, booking(status)), true, status);
        assert.equal(canFinaliseBooking(users.coordinator, booking(status)), true, status);
        assert.equal(canViewAadhaar(users.coordinator, booking(status)), true, status);
      }
      for (const status of ['finalised', 'with_hospitality', 'shared_with_hotel', 'completed', 'files_deleted', 'cancelled']) {
        assert.equal(canEditBooking(users.coordinator, booking(status)), false, status);
        assert.equal(canFinaliseBooking(users.coordinator, booking(status)), false, status);
        assert.equal(canViewAadhaar(users.coordinator, booking(status)), false, status);
        assert.equal(canViewBooking(users.coordinator, booking(status)), true, `can still view status: ${status}`);
      }
    });

    it('without a division see nothing', () => {
      const orphan = { ...users.coordinator, divisionId: null };
      assert.equal(canViewBooking(orphan, booking('collecting')), false);
    });
  });

  describe('hospitality', () => {
    it('sees and edits every booking in every division and status', () => {
      for (const divisionId of [MARKETING, BUSINESS_ENABLERS]) {
        for (const status of ['draft', 'finalised', 'shared_with_hotel', 'completed', 'cancelled']) {
          assert.equal(canViewBooking(users.hospitality, booking(status, divisionId)), true);
          assert.equal(canEditBooking(users.hospitality, booking(status, divisionId)), true);
        }
      }
    });

    it('cannot view Aadhaar once files are deleted', () => {
      assert.equal(canViewAadhaar(users.hospitality, booking('finalised')), true);
      assert.equal(canViewAadhaar(users.hospitality, booking('files_deleted')), false);
    });

    it('cannot finalise (that is the coordinator\'s step)', () => {
      assert.equal(canFinaliseBooking(users.hospitality, booking('collecting')), false);
    });
  });
});

describe('access rules (HTTP)', () => {
  let t;
  const ADMIN = 'admin@alembic.co.in';
  const HOSPITALITY = 'hospitality@alembic.co.in';
  const COORDINATOR = 'coordinator@alembic.co.in';
  const ANALYTICS = 'analytics@alembic.co.in';

  beforeEach(async () => {
    t = await buildTestApp();
    await t.seedUser({ email: ADMIN, name: 'Admin', role: 'admin' });
    await t.seedUser({ email: HOSPITALITY, name: 'Hospitality', role: 'hospitality' });
    await t.seedUser({ email: COORDINATOR, name: 'Coordinator', role: 'coordinator', divisionId: MARKETING });
    await t.seedUser({ email: ANALYTICS, name: 'Analytics', role: 'analytics_viewer' });
  });
  afterEach(() => t.close());

  it('requires sign-in, and audits the attempt', async () => {
    const res = await request(t.app).get('/api/admin/users');
    assert.equal(res.status, 401);
    const [entry] = await t.auditEntries('admin.users.list');
    assert.equal(entry.outcome, 'denied');
    assert.equal(entry.actorType, 'anonymous');
    assert.equal(entry.details.reason, 'unauthenticated');
  });

  it('only admins manage the allow-list; other roles are refused and audited by name', async () => {
    for (const email of [HOSPITALITY, COORDINATOR, ANALYTICS]) {
      const agent = await t.signIn(email);
      await agent.get('/api/admin/users').expect(403);
      await agent.post('/api/admin/users').send({ email: 'x@alembic.co.in', name: 'X', role: 'admin' }).expect(403);
    }
    const denied = (await t.auditEntries()).filter((e) => e.outcome === 'denied' && e.action.startsWith('admin.users'));
    assert.equal(denied.length, 6);
    assert.deepEqual([...new Set(denied.map((e) => e.actorEmail))].sort(), [ANALYTICS, COORDINATOR, HOSPITALITY]);
    assert.ok(denied.every((e) => e.details.permission === 'users.manage'));

    const admin = await t.signIn(ADMIN);
    const res = await admin.get('/api/admin/users').expect(200);
    assert.equal(res.body.users.length, 4);
    assert.ok(res.body.users.every((u) => u.passwordHash === undefined));
  });

  it('only admins read the full audit log', async () => {
    for (const email of [HOSPITALITY, COORDINATOR, ANALYTICS]) {
      const agent = await t.signIn(email);
      await agent.get('/api/audit').expect(403);
    }
    const admin = await t.signIn(ADMIN);
    const res = await admin.get('/api/audit?limit=5').expect(200);
    assert.equal(res.body.entries.length, 5);
    assert.match(res.body.entries[0].occurredAt, /\+05:30$/);
    const reads = await t.auditEntries('audit.read');
    assert.deepEqual(reads.map((e) => e.outcome), ['denied', 'denied', 'denied', 'success'],
      'reading the audit log, and trying to, is itself audited');
    assert.equal(reads[3].actorEmail, ADMIN);
  });

  describe('admin allow-list management', () => {
    let admin;
    beforeEach(async () => { admin = await t.signIn(ADMIN); });

    it('adds a company email, which can then sign in', async () => {
      const email = 'new.coordinator@alembic.co.in';
      const res = await admin.post('/api/admin/users')
        .send({ email: 'New.Coordinator@alembic.co.in', name: 'New Coordinator', role: 'coordinator', divisionId: BUSINESS_ENABLERS });
      assert.equal(res.status, 201);
      assert.equal(res.body.user.email, email);
      assert.equal(res.body.user.divisionId, BUSINESS_ENABLERS);
      await t.signIn(email);

      const [entry] = (await t.auditEntries('admin.users.create')).filter((e) => e.outcome === 'success');
      assert.equal(entry.actorEmail, ADMIN);
      assert.equal(entry.entityId, String(res.body.user.id));
      assert.equal(entry.details.new.role, 'coordinator');
    });

    it('refuses non-company emails', async () => {
      const res = await admin.post('/api/admin/users').send({ email: 'someone@gmail.com', name: 'Someone', role: 'hospitality' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'email_domain_not_allowed');
      const [entry] = await t.auditEntries('admin.users.create');
      assert.equal(entry.outcome, 'failure');
    });

    it('requires a division for coordinators and ignores it for other roles', async () => {
      await admin.post('/api/admin/users').send({ email: 'c@alembic.co.in', name: 'C', role: 'coordinator' }).expect(400);
      await admin.post('/api/admin/users').send({ email: 'c@alembic.co.in', name: 'C', role: 'coordinator', divisionId: 999 }).expect(400);
      const res = await admin.post('/api/admin/users')
        .send({ email: 'h@alembic.co.in', name: 'H', role: 'hospitality', divisionId: MARKETING }).expect(201);
      assert.equal(res.body.user.divisionId, null);
    });

    it('refuses unknown roles and duplicates', async () => {
      await admin.post('/api/admin/users').send({ email: 'r@alembic.co.in', name: 'R', role: 'root' }).expect(400);
      await admin.post('/api/admin/users').send({ email: HOSPITALITY, name: 'Again', role: 'hospitality' }).expect(409);
    });

    it('deactivating a user ends their sessions immediately', async () => {
      const victim = await t.signIn(HOSPITALITY);
      await victim.get('/api/auth/me').expect(200);
      const { body } = await admin.get('/api/admin/users');
      const target = body.users.find((u) => u.email === HOSPITALITY);

      const res = await admin.patch(`/api/admin/users/${target.id}`).send({ isActive: false }).expect(200);
      assert.equal(res.body.user.isActive, false);
      await victim.get('/api/auth/me').expect(401);

      const [entry] = await t.auditEntries('admin.users.update');
      assert.deepEqual(entry.details.changes, { isActive: { old: true, new: false } });
      assert.equal(entry.details.sessionsRevoked, 1);
    });

    it('a role change ends sessions so new permissions apply at once', async () => {
      const coordinator = await t.signIn(COORDINATOR);
      const { body } = await admin.get('/api/admin/users');
      const target = body.users.find((u) => u.email === COORDINATOR);
      await admin.patch(`/api/admin/users/${target.id}`).send({ role: 'hospitality' }).expect(200);
      await coordinator.get('/api/auth/me').expect(401);
    });

    it('admins cannot deactivate or demote themselves', async () => {
      const { body } = await admin.get('/api/admin/users');
      const self = body.users.find((u) => u.email === ADMIN);
      await admin.patch(`/api/admin/users/${self.id}`).send({ isActive: false }).expect(400);
      await admin.patch(`/api/admin/users/${self.id}`).send({ role: 'hospitality' }).expect(400);
    });

    it('cannot change email or password through the admin console', async () => {
      const { body } = await admin.get('/api/admin/users');
      const target = body.users.find((u) => u.email === HOSPITALITY);
      await admin.patch(`/api/admin/users/${target.id}`).send({ email: 'other@alembic.co.in' }).expect(400);
      await admin.patch(`/api/admin/users/${target.id}`).send({ passwordHash: 'x' }).expect(400);
    });
  });

  describe('route definitions', () => {
    it('refuse to register a route without an audit action', () => {
      assert.throws(() => defineRoute(express.Router(), 'get', '/x', { auth: 'public' }, () => ({})), /audit action/);
    });

    it('refuse to register a route with a misspelt permission', () => {
      assert.throws(
        () => defineRoute(express.Router(), 'get', '/x', { permission: 'user.manage', audit: 'x.read' }, () => ({})),
        /Unknown permission/,
      );
    });
  });
});
