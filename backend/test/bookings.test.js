'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildTestApp, bookingBody, employee, importEmployees, DIVISIONS } = require('./helpers');
const { computeDeadline } = require('../src/bookings/deadline');
const { planTransition, availableActions } = require('../src/bookings/status');

const { MEGACARE, MAXIS } = DIVISIONS;

const ist = (text) => new Date(`${text}+05:30`);

describe('deadline and short notice (rules)', () => {
  it('is 23:59 IST on check-in minus 7 days', () => {
    assert.deepEqual(computeDeadline('2026-10-30', ist('2026-10-14T10:00:00')), {
      isShortNotice: false,
      deadlineAt: '2026-10-23 23:59:59.999',
    });
  });

  it('crosses month and year boundaries correctly', () => {
    assert.equal(computeDeadline('2026-11-03', ist('2026-10-01T10:00:00')).deadlineAt, '2026-10-27 23:59:59.999');
    assert.equal(computeDeadline('2027-01-05', ist('2026-12-01T10:00:00')).deadlineAt, '2026-12-29 23:59:59.999');
  });

  it('is not short notice exactly 7 days before check-in, even late in the evening', () => {
    const result = computeDeadline('2026-10-21', ist('2026-10-14T23:30:00'));
    assert.equal(result.isShortNotice, false);
    assert.equal(result.deadlineAt, '2026-10-14 23:59:59.999');
  });

  it('is short notice fewer than 7 days before check-in, with no deadline until hospitality sets one', () => {
    for (const checkIn of ['2026-10-20', '2026-10-15', '2026-10-14']) {
      assert.deepEqual(computeDeadline(checkIn, ist('2026-10-14T00:05:00')), { isShortNotice: true, deadlineAt: null }, checkIn);
    }
  });

  it('uses the IST calendar day, not UTC (00:30 IST is still the previous day in UTC)', () => {
    // 15/10 00:30 IST = 14/10 19:00 UTC. In IST it is already the 15th: 6 days to the 21st.
    assert.equal(computeDeadline('2026-10-21', ist('2026-10-15T00:30:00')).isShortNotice, true);
  });
});

describe('booking status model (rules)', () => {
  const coordinator = { id: 3, role: 'coordinator', isActive: true, divisionId: MEGACARE };
  const hospitality = { id: 2, role: 'hospitality', isActive: true, divisionId: 3 };
  const admin = { id: 1, role: 'admin', isActive: true, divisionId: 3 };
  const at = (status, extra = {}) => ({ id: 1, divisionId: MEGACARE, status, ...extra });

  it('moves Draft to Collecting for coordinators and hospitality', () => {
    assert.deepEqual(planTransition(coordinator, at('draft'), 'start_collecting'), { from: 'draft', to: 'collecting', note: null });
    assert.equal(planTransition(hospitality, at('draft'), 'start_collecting').to, 'collecting');
  });

  it('refuses actions from the wrong status', () => {
    assert.throws(() => planTransition(coordinator, at('collecting'), 'start_collecting'), (e) => e.status === 409);
    assert.throws(() => planTransition(hospitality, at('draft'), 'reopen'), (e) => e.status === 409);
  });

  it('explains steps that arrive in later stages instead of pretending they work', () => {
    assert.throws(() => planTransition(coordinator, at('collecting'), 'finalise'),
      (e) => e.code === 'not_available_yet' && /checklist/.test(e.message));
    const finalise = availableActions(coordinator, at('collecting')).find((a) => a.action === 'finalise');
    assert.equal(finalise.available, false);
  });

  it('only hospitality reopens, and only after finalise', () => {
    assert.equal(planTransition(hospitality, at('finalised'), 'reopen').to, 'collecting');
    assert.throws(() => planTransition(coordinator, at('finalised'), 'reopen'), (e) => e.status === 403);
  });

  it('cancels from any live status with a note; coordinators only before finalise', () => {
    assert.throws(() => planTransition(coordinator, at('draft'), 'cancel'), (e) => e.code === 'note_required');
    assert.equal(planTransition(coordinator, at('collecting'), 'cancel', { note: 'Event postponed' }).to, 'cancelled');
    assert.throws(() => planTransition(coordinator, at('finalised'), 'cancel', { note: 'x' }), (e) => e.status === 403);
    for (const status of ['draft', 'collecting', 'finalised', 'with_hospitality', 'shared_with_hotel', 'completed']) {
      assert.equal(planTransition(hospitality, at(status), 'cancel', { note: 'x' }).to, 'cancelled', status);
    }
    assert.throws(() => planTransition(hospitality, at('files_deleted'), 'cancel', { note: 'x' }), (e) => e.status === 409);
  });

  it('restores a cancelled booking to where it was, by hospitality only', () => {
    assert.equal(planTransition(hospitality, at('cancelled', { previousStatus: 'collecting' }), 'restore').to, 'collecting');
    assert.throws(() => planTransition(coordinator, at('cancelled', { previousStatus: 'draft' }), 'restore'), (e) => e.status === 403);
  });

  it('gives admins no actions (they view bookings read-only)', () => {
    for (const status of ['draft', 'collecting', 'finalised', 'cancelled']) {
      assert.deepEqual(availableActions(admin, at(status)), [], status);
    }
  });

  it('never lets a person delete files (the retention job does)', () => {
    assert.throws(() => planTransition(hospitality, at('completed'), 'delete_files'), (e) => e.status === 403);
  });
});

describe('bookings (HTTP)', () => {
  let t;
  let coordinator;
  let ids;
  const COORDINATOR = 'asha@alembic.co.in';
  const COLLEAGUE = 'ravi@alembic.co.in';
  const OTHER_DIVISION = 'neha@alembic.co.in';
  const HOSPITALITY = 'hosp@alembic.co.in';
  const ADMIN = 'admin@alembic.co.in';

  beforeEach(async () => {
    t = await buildTestApp();
    ids = {
      coordinator: (await t.seedUser({ email: COORDINATOR, name: 'Asha', role: 'coordinator', divisionId: MEGACARE })).id,
      colleague: (await t.seedUser({ email: COLLEAGUE, name: 'Ravi', role: 'coordinator', divisionId: MEGACARE })).id,
      other: (await t.seedUser({ email: OTHER_DIVISION, name: 'Neha', role: 'coordinator', divisionId: MAXIS })).id,
      hospitality: (await t.seedUser({ email: HOSPITALITY, name: 'Hosp', role: 'hospitality' })).id,
      admin: (await t.seedUser({ email: ADMIN, name: 'Admin', role: 'admin' })).id,
    };
    coordinator = await t.signIn(COORDINATOR);
  });
  afterEach(() => t.close());

  const create = async (overrides) => (await coordinator.post('/api/bookings').send(bookingBody(overrides)).expect(201)).body.booking;

  describe('create', () => {
    it('creates a draft in the coordinator\'s division with the deadline at 23:59 IST, 7 days before check-in', async () => {
      const booking = await create();
      assert.equal(booking.status, 'draft');
      assert.equal(booking.divisionId, MEGACARE);
      assert.equal(booking.checkInDate, '2026-10-30');
      assert.equal(booking.checkOutDate, '2026-11-01');
      assert.equal(booking.deadlineAt, '2026-10-23T23:59:59.999+05:30');
      assert.equal(booking.isShortNotice, false);
      assert.equal(booking.createdBy.name, 'Asha');
      assert.equal(booking.updatedBy.name, 'Asha');

      const [entry] = await t.auditEntries('bookings.create');
      assert.equal(entry.bookingId, booking.id);
      assert.equal(entry.actorEmail, COORDINATOR);
      assert.equal(entry.details.new.eventName, 'Annual Sales Meet');
    });

    it('ignores any division the coordinator tries to choose', async () => {
      const booking = await create({ divisionId: MAXIS });
      assert.equal(booking.divisionId, MEGACARE);
    });

    it('requires check-out after check-in', async () => {
      for (const checkOutDate of ['30/10/2026', '29/10/2026']) {
        const res = await coordinator.post('/api/bookings').send(bookingBody({ checkOutDate }));
        assert.equal(res.status, 400, checkOutDate);
        assert.equal(res.body.message, 'Check-out must be after check-in.');
      }
    });

    it('requires real DD/MM/YYYY dates and refuses a check-in in the past', async () => {
      for (const checkInDate of ['31/02/2027', '2026/10/30', '10-30-2026', '']) {
        const res = await coordinator.post('/api/bookings').send(bookingBody({ checkInDate }));
        assert.equal(res.status, 400, checkInDate);
      }
      const past = await coordinator.post('/api/bookings').send(bookingBody({ checkInDate: '13/10/2026' }));
      assert.equal(past.body.message, 'Check-in cannot be in the past.');
    });

    it('requires hotel, event name and location', async () => {
      for (const missing of ['hotelName', 'eventName', 'location']) {
        const res = await coordinator.post('/api/bookings').send(bookingBody({ [missing]: '  ' }));
        assert.equal(res.status, 400, missing);
      }
    });

    it('only coordinators create bookings', async () => {
      for (const email of [HOSPITALITY, ADMIN]) {
        const agent = await t.signIn(email);
        await agent.post('/api/bookings').send(bookingBody()).expect(403);
      }
    });
  });

  describe('short notice', () => {
    it('flags a booking created fewer than 7 days before check-in and leaves the deadline to hospitality', async () => {
      const booking = await create({ checkInDate: '19/10/2026', checkOutDate: '21/10/2026' });
      assert.equal(booking.isShortNotice, true);
      assert.equal(booking.deadlineAt, null);
      const [entry] = await t.auditEntries('bookings.create');
      assert.equal(entry.details.new.isShortNotice, true);
    });

    it('does not flag a booking exactly 7 days ahead', async () => {
      const booking = await create({ checkInDate: '21/10/2026', checkOutDate: '22/10/2026' });
      assert.equal(booking.isShortNotice, false);
      assert.equal(booking.deadlineAt, '2026-10-14T23:59:59.999+05:30');
    });

    it('recalculates when the check-in date moves', async () => {
      const booking = await create();
      const moved = await coordinator.patch(`/api/bookings/${booking.id}`)
        .send({ checkInDate: '18/10/2026', checkOutDate: '20/10/2026' }).expect(200);
      assert.equal(moved.body.booking.isShortNotice, true);
      assert.equal(moved.body.booking.deadlineAt, null);
      const back = await coordinator.patch(`/api/bookings/${booking.id}`)
        .send({ checkInDate: '30/11/2026', checkOutDate: '02/12/2026' }).expect(200);
      assert.equal(back.body.booking.isShortNotice, false);
      assert.equal(back.body.booking.deadlineAt, '2026-11-23T23:59:59.999+05:30');
    });
  });

  describe('hotels', () => {
    it('a typed hotel name becomes a pending hotel, audited, and is reused for later bookings ignoring case', async () => {
      const first = await create({ hotelName: 'Novotel Juhu' });
      assert.equal(first.hotelPending, true);
      const second = await create({ hotelName: '  novotel   JUHU ' });
      assert.equal(second.hotelId, first.hotelId);
      const hotels = await t.dump('hotels');
      assert.equal(hotels.length, 1);
      assert.equal(hotels[0].reviewStatus, 'pending');
      assert.equal(hotels[0].createdByUserId, ids.coordinator);
      const [entry] = await t.auditEntries('hotels.create_pending');
      assert.equal(entry.actorEmail, COORDINATOR);
    });

    it('coordinators pick existing hotels from the list', async () => {
      const hosp = await t.signIn(HOSPITALITY);
      const { hotel } = (await hosp.post('/api/hotels').send({ name: 'The Leela', city: 'Mumbai' }).expect(201)).body;
      const list = (await coordinator.get('/api/hotels').expect(200)).body.hotels;
      assert.deepEqual(list.map((h) => h.name), ['The Leela']);
      const booking = await create({ hotelId: hotel.id, hotelName: undefined });
      assert.equal(booking.hotelName, 'The Leela');
      assert.equal(booking.hotelPending, false);
    });

    it('admin or hospitality complete a pending hotel, or merge a duplicate into the right one', async () => {
      const booking = await create({ hotelName: 'Leela Mumbai' });
      const hosp = await t.signIn(HOSPITALITY);
      const leela = (await hosp.post('/api/hotels').send({ name: 'The Leela', city: 'Mumbai' })).body.hotel;

      const merged = await hosp.post(`/api/hotels/${booking.hotelId}/merge`).send({ intoHotelId: leela.id }).expect(200);
      assert.equal(merged.body.bookingsMoved, 1);
      const after = (await coordinator.get(`/api/bookings/${booking.id}`)).body.booking;
      assert.equal(after.hotelName, 'The Leela');
      const names = (await coordinator.get('/api/hotels')).body.hotels.map((h) => h.name);
      assert.deepEqual(names, ['The Leela'], 'the duplicate is archived');

      const other = await create({ hotelName: 'ITC Maratha' });
      const admin = await t.signIn(ADMIN);
      const done = await admin.patch(`/api/hotels/${other.hotelId}`).send({ city: 'Mumbai', reviewStatus: 'active' }).expect(200);
      assert.equal(done.body.hotel.reviewStatus, 'active');
      const actions = (await t.auditEntries()).map((e) => e.action);
      assert.ok(actions.includes('hotels.merge') && actions.includes('hotels.update'));
    });

    it('coordinators cannot add, complete or merge hotels', async () => {
      await coordinator.post('/api/hotels').send({ name: 'X' }).expect(403);
      const booking = await create({ hotelName: 'Pending One' });
      await coordinator.patch(`/api/hotels/${booking.hotelId}`).send({ reviewStatus: 'active' }).expect(403);
    });
  });

  describe('division scoping', () => {
    it('coordinators in the same division view and edit each other\'s bookings; the change is attributed', async () => {
      const booking = await create();
      const colleague = await t.signIn(COLLEAGUE);
      await colleague.get(`/api/bookings/${booking.id}`).expect(200);
      const res = await colleague.patch(`/api/bookings/${booking.id}`).send({ location: 'Navi Mumbai' }).expect(200);
      assert.equal(res.body.booking.createdBy.name, 'Asha');
      assert.equal(res.body.booking.updatedBy.name, 'Ravi');

      const [entry] = await t.auditEntries('bookings.update');
      assert.equal(entry.actorEmail, COLLEAGUE);
      assert.equal(entry.bookingId, booking.id);
      assert.deepEqual(entry.details.changes, { location: { old: 'Mumbai', new: 'Navi Mumbai' } });
    });

    it('a coordinator from another division sees nothing: not in the list, "not found" when guessed, audited as denied', async () => {
      const booking = await create();
      const other = await t.signIn(OTHER_DIVISION);
      assert.equal((await other.get('/api/bookings')).body.bookings.length, 0);
      const res = await other.get(`/api/bookings/${booking.id}`);
      assert.equal(res.status, 404);
      await other.patch(`/api/bookings/${booking.id}`).send({ location: 'X' }).expect(404);
      await importEmployees(other, booking.id, [employee(1)]).expect(404);

      const denied = (await t.auditEntries()).filter((e) => e.outcome === 'denied' && e.bookingId === booking.id);
      assert.equal(denied.length, 3);
      assert.ok(denied.every((e) => e.actorEmail === OTHER_DIVISION && e.details.reason === 'other_division'));
    });

    it('hospitality and admins see bookings of every division; coordinators can filter only their own', async () => {
      await create();
      const other = await t.signIn(OTHER_DIVISION);
      await other.post('/api/bookings').send(bookingBody({ eventName: 'BE Offsite' })).expect(201);

      for (const email of [HOSPITALITY, ADMIN]) {
        const agent = await t.signIn(email);
        const all = (await agent.get('/api/bookings').expect(200)).body.bookings;
        assert.equal(all.length, 2, email);
        const filtered = (await agent.get(`/api/bookings?divisionId=${MAXIS}`)).body.bookings;
        assert.deepEqual(filtered.map((b) => b.eventName), ['BE Offsite']);
      }
      const own = (await coordinator.get(`/api/bookings?divisionId=${MAXIS}`)).body.bookings;
      assert.deepEqual(own.map((b) => b.divisionId), [MEGACARE], 'the filter cannot widen a coordinator\'s view');
    });

    it('admins view bookings read-only', async () => {
      const booking = await create();
      const admin = await t.signIn(ADMIN);
      const detail = (await admin.get(`/api/bookings/${booking.id}`).expect(200)).body;
      assert.equal(detail.canEdit, false);
      const res = await admin.patch(`/api/bookings/${booking.id}`).send({ location: 'X' });
      assert.equal(res.status, 403);
    });

    it('coordinators cannot edit after finalise, but hospitality can', async () => {
      const booking = await create();
      await t.query("UPDATE bookings SET status = 'finalised' WHERE id = ?", [booking.id]);
      const res = await coordinator.patch(`/api/bookings/${booking.id}`).send({ location: 'X' });
      assert.equal(res.status, 403);
      assert.match(res.body.message, /read-only for coordinators/);
      const hosp = await t.signIn(HOSPITALITY);
      await hosp.patch(`/api/bookings/${booking.id}`).send({ location: 'Pune' }).expect(200);
    });
  });

  describe('status transitions', () => {
    it('start collecting needs at least one traveller who is not vacant', async () => {
      const booking = await create();
      const empty = await coordinator.post(`/api/bookings/${booking.id}/actions`).send({ action: 'start_collecting' });
      assert.equal(empty.status, 409);
      assert.equal(empty.body.error, 'no_travellers');

      await importEmployees(coordinator, booking.id, [employee(1, { isVacant: true, name: '', email: '', mobile: '' })]).expect(201);
      const vacantOnly = await coordinator.post(`/api/bookings/${booking.id}/actions`).send({ action: 'start_collecting' });
      assert.equal(vacantOnly.status, 409, 'vacant rows do not count');

      await importEmployees(coordinator, booking.id, [employee(2)], 'append').expect(201);
      const ok = await coordinator.post(`/api/bookings/${booking.id}/actions`).send({ action: 'start_collecting' }).expect(200);
      assert.equal(ok.body.booking.status, 'collecting');

      const [entry] = (await t.auditEntries('bookings.transition')).filter((e) => e.outcome === 'success');
      assert.deepEqual(entry.details.changes, { status: { old: 'draft', new: 'collecting' } });
    });

    it('cancel needs a note; hospitality restores to the previous status', async () => {
      const booking = await create();
      await importEmployees(coordinator, booking.id, [employee(1)]).expect(201);
      await coordinator.post(`/api/bookings/${booking.id}/actions`).send({ action: 'start_collecting' }).expect(200);
      await coordinator.post(`/api/bookings/${booking.id}/actions`).send({ action: 'cancel' }).expect(400);
      const cancelled = await coordinator.post(`/api/bookings/${booking.id}/actions`)
        .send({ action: 'cancel', note: 'Event postponed' }).expect(200);
      assert.equal(cancelled.body.booking.status, 'cancelled');
      assert.equal(cancelled.body.booking.cancellationNote, 'Event postponed');

      await coordinator.post(`/api/bookings/${booking.id}/actions`).send({ action: 'restore' }).expect(403);
      const hosp = await t.signIn(HOSPITALITY);
      const restored = await hosp.post(`/api/bookings/${booking.id}/actions`).send({ action: 'restore' }).expect(200);
      assert.equal(restored.body.booking.status, 'collecting');
      assert.equal(restored.body.booking.cancellationNote, null);
    });

    it('lists the actions each person may take, and refuses steps from later stages', async () => {
      const booking = await create();
      await importEmployees(coordinator, booking.id, [employee(1)]).expect(201);
      await coordinator.post(`/api/bookings/${booking.id}/actions`).send({ action: 'start_collecting' }).expect(200);
      const { actions } = (await coordinator.get(`/api/bookings/${booking.id}`)).body;
      assert.deepEqual(actions.map((a) => [a.action, a.available]), [['finalise', false], ['cancel', true]]);
      const res = await coordinator.post(`/api/bookings/${booking.id}/actions`).send({ action: 'finalise' });
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'not_available_yet');
    });
  });
});
