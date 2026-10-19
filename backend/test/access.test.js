'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { buildTestApp, request, DIVISIONS } = require('./helpers');
const policy = require('../src/auth/policy');
const { defineRoute } = require('../src/http/route');

const { can, canViewBooking, canEditBooking, canCreateBookingIn, canFinaliseBooking, canViewAadhaar, PERMISSIONS } = policy;

const { MEGACARE, MAXIS, DIGILABS } = DIVISIONS;

const users = {
  admin: { id: 1, role: 'admin', isActive: true, divisionId: DIGILABS },
  hospitality: { id: 2, role: 'hospitality', isActive: true, divisionId: DIGILABS },
  coordinator: { id: 3, role: 'coordinator', isActive: true, divisionId: MEGACARE },
  colleague: { id: 5, role: 'coordinator', isActive: true, divisionId: MEGACARE },
  analytics: { id: 4, role: 'analytics_viewer', isActive: true, divisionId: DIGILABS },
};

const booking = (status, divisionId = MEGACARE) => ({ id: 10, status, divisionId, coordinatorUserId: 3 });

describe('access rules (policy)', () => {
  it('grants each permission only to the roles in the PRD roles table', () => {
    const expected = {
      admin: ['users.manage', 'divisions.manage', 'settings.manage', 'audit.read', 'hotels.read', 'hotels.manage',
        'bookings.read', 'bookings.history.read', 'analytics.read'],
      hospitality: ['hotels.read', 'hotels.manage', 'bookings.read', 'bookings.edit', 'bookings.history.read',
        'bookings.reopen', 'deadlines.extend', 'guests.cancel', 'emergency_contacts.manage', 'hotel_links.manage',
        'files.delete', 'guests.verify', 'aadhaar.view'],
      coordinator: ['hotels.read', 'bookings.create', 'bookings.read', 'bookings.edit', 'bookings.finalise', 'aadhaar.view'],
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
    const strange = { id: 9, role: 'superuser', isActive: true, divisionId: MEGACARE };
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

  describe('division scoping', () => {
    it('coordinators see only their own division\'s bookings', () => {
      assert.equal(canViewBooking(users.coordinator, booking('collecting', MEGACARE)), true);
      assert.equal(canViewBooking(users.coordinator, booking('collecting', MAXIS)), false);
      assert.equal(canEditBooking(users.coordinator, booking('collecting', MAXIS)), false);
      assert.equal(canViewAadhaar(users.coordinator, booking('collecting', MAXIS)), false);
    });

    it('coordinators share their division\'s bookings, including colleagues\' ones', () => {
      const colleaguesBooking = { ...booking('collecting'), coordinatorUserId: users.colleague.id };
      assert.equal(canViewBooking(users.coordinator, colleaguesBooking), true);
      assert.equal(canEditBooking(users.coordinator, colleaguesBooking), true);
    });

    it('coordinators create bookings only in their own, active division', () => {
      assert.equal(canCreateBookingIn(users.coordinator, { id: MEGACARE, archivedAt: null }), true);
      assert.equal(canCreateBookingIn(users.coordinator, { id: MAXIS, archivedAt: null }), false);
      assert.equal(canCreateBookingIn(users.coordinator, { id: MEGACARE, archivedAt: '2026-10-01 00:00:00.000' }), false);
      assert.equal(canCreateBookingIn(users.hospitality, { id: DIGILABS, archivedAt: null }), false);
    });

    it('hospitality and admins see every division whatever their own division is', () => {
      for (const divisionId of [MEGACARE, MAXIS, DIGILABS]) {
        assert.equal(canViewBooking(users.hospitality, booking('draft', divisionId)), true);
        assert.equal(canViewBooking(users.admin, booking('draft', divisionId)), true);
      }
    });

    it('admins see bookings but cannot edit them', () => {
      assert.equal(canEditBooking(users.admin, booking('draft')), false);
    });

    it('analytics viewers see no bookings', () => {
      assert.equal(canViewBooking(users.analytics, booking('draft')), false);
    });
  });

  describe('coordinators and booking status', () => {
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
      for (const divisionId of [MEGACARE, MAXIS]) {
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
    await t.seedUser({ email: COORDINATOR, name: 'Coordinator', role: 'coordinator', divisionId: MEGACARE });
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

  it('only admins manage users and divisions; other roles are refused and audited by name', async () => {
    for (const email of [HOSPITALITY, COORDINATOR, ANALYTICS]) {
      const agent = await t.signIn(email);
      await agent.get('/api/admin/users').expect(403);
      await agent.post('/api/admin/users').send({ email: 'x@alembic.co.in', name: 'X', role: 'admin', divisionId: 1 }).expect(403);
      await agent.post('/api/admin/divisions').send({ name: 'Rogue' }).expect(403);
    }
    const denied = (await t.auditEntries()).filter((e) => e.outcome === 'denied' && e.action.startsWith('admin.'));
    assert.equal(denied.length, 9);
    assert.deepEqual([...new Set(denied.map((e) => e.actorEmail))].sort(), [ANALYTICS, COORDINATOR, HOSPITALITY]);

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

  it('analytics viewers cannot open bookings', async () => {
    const agent = await t.signIn(ANALYTICS);
    await agent.get('/api/bookings').expect(403);
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
