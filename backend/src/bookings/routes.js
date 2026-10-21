'use strict';

const express = require('express');
const { defineRoute } = require('../http/route');
const { HttpError, badRequest, notFound } = require('../lib/errors');
const { toIstSql, toIstIso, parseCalendarDate, istToday } = require('../lib/time');
const { ROLES, can, canViewBooking, canEditBooking, canCreateBookingIn, canViewAadhaar } = require('../auth/policy');
const { resolveHotel } = require('../hotels/routes');
const { computeDeadline } = require('./deadline');
const { STATUSES, STATUS_LABELS, availableActions, planTransition } = require('./status');
const { validateRows, MAX_ROWS } = require('./employee-rows');
const { buildTemplate, parseEmployeeFile, FileProblem, MAX_FILE_BYTES } = require('./employee-file');
const { uploadWindow, bookingWindow } = require('./upload-lock');
const { END_OF_DAY } = require('./deadline');
const { bookingLinkToken, tokenHash, bookingLinkUrl, invitationMessages } = require('../employees/booking-link');
const { submissionState } = require('../employees/submission');
const { purgeEmployees } = require('../files/deletion');

// Bookings and their employee lists (backlog 6-11, 46, 47).
//
// Access: all coordinators of a division view, create and edit that division's bookings,
// including each other's, until finalise; hospitality sees and edits all; admins see all
// read-only. Every change records who made it (bookings.updated_by_user_id) and goes
// through the audit service with old and new values.

const EMPLOYEE_FIELDS = ['employeeCode', 'name', 'email', 'mobile', 'department', 'zone', 'hq', 'isVacant'];

const parseId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

function publicBooking(b) {
  return {
    id: b.id,
    divisionId: b.divisionId,
    divisionName: b.divisionName,
    hotelId: b.hotelId,
    hotelName: b.hotelDisplayName,
    hotelPending: b.hotelReviewStatus === 'pending',
    eventName: b.eventName,
    location: b.location,
    checkInDate: b.checkInDate,
    checkOutDate: b.checkOutDate,
    deadlineAt: toIstIso(b.deadlineAt),
    isShortNotice: b.isShortNotice,
    status: b.status,
    statusLabel: STATUS_LABELS[b.status],
    statusChangedAt: toIstIso(b.statusChangedAt),
    cancellationNote: b.cancellationNote,
    createdBy: { id: b.createdByUserId, name: b.createdByName },
    updatedBy: { id: b.updatedByUserId, name: b.updatedByName },
    createdAt: toIstIso(b.createdAt),
    updatedAt: toIstIso(b.updatedAt),
    counts: {
      total: b.employeeTotal,
      active: b.employeeActive,
      vacant: b.employeeVacant,
      cancelled: b.employeeCancelled,
      pending: b.employeePending,
    },
  };
}

function publicEmployee(e) {
  return {
    id: e.id,
    employeeCode: e.employeeCode,
    name: e.name,
    email: e.email,
    mobile: e.mobile,
    department: e.department,
    zone: e.zone,
    hq: e.hq,
    isVacant: e.isVacant,
    inviteStatus: e.inviteStatus,
    openedAt: toIstIso(e.openedAt),
    submissionStatus: e.submissionStatus,
    submittedAt: toIstIso(e.submittedAt),
    deadlineOverrideAt: toIstIso(e.deadlineOverrideAt),
    cancelled: Boolean(e.cancelledAt),
  };
}

/** Coordinators of the booking's division and hospitality copy the link; admins only read bookings. */
function canShareLink(user, booking) {
  return can(user, 'bookings.edit') && canViewBooking(user, booking);
}

function publicWindow(window) {
  return { open: window.open, reason: window.reason, message: window.message, deadlineAt: toIstIso(window.deadlineAt) };
}

function readOnlyMessage(user, booking) {
  if (user.role === ROLES.ADMIN) return 'Admins can view bookings but not change them.';
  return `This booking is ${STATUS_LABELS[booking.status]}, so it is read-only for coordinators. Ask hospitality to change it.`;
}

/**
 * Loads the booking named in the URL and checks access. Bookings of another division
 * answer "not found" (so their existence is not revealed) and are audited as denied.
 */
async function loadBooking(ctx, { edit = false, lock = false } = {}) {
  const id = parseId(ctx.params.id);
  ctx.audit.entityType = 'booking';
  ctx.audit.entityId = ctx.params.id;
  ctx.audit.bookingId = id;
  if (id && lock) await ctx.tx.bookings.lock(id);
  const booking = id ? await ctx.tx.bookings.findById(id) : null;
  if (!booking) throw notFound('booking_not_found', 'Booking not found.');
  if (!canViewBooking(ctx.user, booking)) {
    ctx.audit.details.reason = 'other_division';
    throw notFound('booking_not_found', 'Booking not found.', { auditOutcome: 'denied' });
  }
  if (edit && !canEditBooking(ctx.user, booking)) {
    throw new HttpError(403, 'read_only', readOnlyMessage(ctx.user, booking));
  }
  return booking;
}

/** Records who last changed the booking (including its employee list) and when. */
async function touch(ctx, bookingId) {
  await ctx.tx.bookings.update(bookingId, {
    updatedByUserId: ctx.user.id,
    updatedAt: toIstSql(ctx.deps.clock.now()),
  });
}

function cleanText(value, label, max) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text) throw badRequest('invalid_field', `Enter the ${label}.`);
  if (text.length > max) throw badRequest('invalid_field', `The ${label} can be at most ${max} characters.`);
  return text;
}

function cleanDate(value, label) {
  const date = parseCalendarDate(value);
  if (!date) throw badRequest('invalid_date', `Enter the ${label} as DD/MM/YYYY.`);
  return date;
}

/** Event, location and travel period. Check-out must be after check-in; a new check-in cannot be in the past. */
function cleanDetails(ctx, body, existing) {
  const pick = (key) => (key in body ? body[key] : existing?.[key]);
  const details = {
    eventName: cleanText(pick('eventName'), 'event name', 200),
    location: cleanText(pick('location'), 'location', 200),
    checkInDate: cleanDate(pick('checkInDate'), 'check-in date'),
    checkOutDate: cleanDate(pick('checkOutDate'), 'check-out date'),
  };
  if (details.checkOutDate <= details.checkInDate) {
    throw badRequest('invalid_dates', 'Check-out must be after check-in.');
  }
  if (details.checkInDate !== existing?.checkInDate && details.checkInDate < istToday(ctx.deps.clock.now())) {
    throw badRequest('invalid_dates', 'Check-in cannot be in the past.');
  }
  return details;
}

function parseMode(value) {
  if (value === 'replace' || value === 'append') return value;
  throw badRequest('invalid_mode', 'Choose whether to replace the current list or add to it.');
}

function rowError(result) {
  const messages = result.rows.flatMap((r) => r.errors);
  return {
    status: 400,
    body: { error: 'invalid_rows', message: messages.join(' '), ...result },
  };
}

function employeeInput(body) {
  const values = {};
  for (const key of EMPLOYEE_FIELDS) if (key in body) values[key] = body[key];
  return values;
}

async function loadEmployee(ctx, booking) {
  const id = parseId(ctx.params.employeeId);
  ctx.audit.entityType = 'booking_employee';
  ctx.audit.entityId = ctx.params.employeeId;
  const employee = id ? await ctx.tx.employees.findById(booking.id, id) : null;
  if (!employee) throw notFound('employee_not_found', 'This person is not on the booking.');
  return employee;
}

function bookingRoutes() {
  const router = express.Router();

  // --- Templates (defined before /:id) -----------------------------------

  for (const format of ['xlsx', 'csv']) {
    defineRoute(router, 'get', `/templates/employees.${format}`, { permission: 'bookings.read', audit: 'bookings.template.download' }, async (ctx) => {
      ctx.audit.details.format = format;
      return {
        file: {
          buffer: await buildTemplate(format),
          contentType: format === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          filename: `employee-list-template.${format}`,
        },
      };
    });
  }

  // --- Bookings ---------------------------------------------------------------

  defineRoute(router, 'get', '/', { permission: 'bookings.read', audit: 'bookings.list' }, async (ctx) => {
    const status = STATUSES.includes(ctx.query.status) ? ctx.query.status : undefined;
    const divisionId = ctx.user.role === ROLES.COORDINATOR ? ctx.user.divisionId : parseId(ctx.query.divisionId) ?? undefined;
    const bookings = await ctx.tx.bookings.list({ divisionId, status });
    ctx.audit.entityType = 'booking';
    ctx.audit.details = { filters: { divisionId, status }, count: bookings.length };
    return { body: { bookings: bookings.map(publicBooking) } };
  });

  defineRoute(router, 'post', '/', { permission: 'bookings.create', audit: 'bookings.create' }, async (ctx) => {
    ctx.audit.entityType = 'booking';
    const division = await ctx.tx.divisions.findById(ctx.user.divisionId);
    if (!canCreateBookingIn(ctx.user, division)) {
      throw new HttpError(403, 'division_archived', 'Your division is archived, so new bookings cannot be created in it. Ask an admin.');
    }
    const details = cleanDetails(ctx, ctx.body, null);
    const hotel = await resolveHotel(ctx, ctx.body);

    const now = ctx.deps.clock.now();
    const nowSql = toIstSql(now);
    const { deadlineAt, isShortNotice } = computeDeadline(details.checkInDate, now);
    const id = await ctx.tx.bookings.insert({
      divisionId: division.id,
      coordinatorUserId: ctx.user.id,
      hotelId: hotel.id,
      hotelName: hotel.name,
      ...details,
      deadlineAt,
      isShortNotice,
      status: 'draft',
      statusChangedAt: nowSql,
      createdByUserId: ctx.user.id,
      updatedByUserId: ctx.user.id,
      createdAt: nowSql,
      updatedAt: nowSql,
    });
    ctx.audit.entityId = id;
    ctx.audit.bookingId = id;
    ctx.audit.details.new = { divisionId: division.id, hotelId: hotel.id, ...details, deadlineAt, isShortNotice };
    return { status: 201, body: { booking: publicBooking(await ctx.tx.bookings.findById(id)) } };
  });

  defineRoute(router, 'get', '/:id', { permission: 'bookings.read', audit: 'bookings.read' }, async (ctx) => {
    const booking = await loadBooking(ctx);
    const employees = await ctx.tx.employees.listByBooking(booking.id);
    ctx.audit.details.employeeCount = employees.length;
    const now = ctx.deps.clock.now();
    return {
      body: {
        booking: publicBooking(booking),
        employees: employees.map((e) => ({
          ...publicEmployee(e),
          uploadOpen: !e.isVacant && uploadWindow(booking, e, now).open,
        })),
        actions: availableActions(ctx.user, booking),
        canEdit: canEditBooking(ctx.user, booking),
        canShareLink: canShareLink(ctx.user, booking),
        canViewAadhaar: canViewAadhaar(ctx.user, booking),
        canExtendDeadline: can(ctx.user, 'deadlines.extend'),
        uploadWindow: publicWindow(bookingWindow(booking, employees.filter((e) => !e.isVacant && !e.cancelledAt), now)),
      },
    };
  });

  // --- Booking link and invitation messages (C1, C2) ----------------------------

  // The one shared link, plus ready-to-copy WhatsApp and email texts carrying it.
  defineRoute(router, 'get', '/:id/link', { permission: 'bookings.read', audit: 'bookings.link.read' }, async (ctx) => {
    let booking = await loadBooking(ctx, { lock: true });
    if (!canShareLink(ctx.user, booking)) {
      throw new HttpError(403, 'forbidden', 'Only the booking\'s coordinators and hospitality can share the booking link.');
    }
    const token = bookingLinkToken(ctx.deps.config, booking);
    const hash = tokenHash(token);
    if (booking.shareTokenHash !== hash) {
      await ctx.tx.bookings.update(booking.id, { shareTokenHash: hash });
      booking = await ctx.tx.bookings.findById(booking.id);
      ctx.audit.details.created = true;
    }
    const url = bookingLinkUrl(ctx.deps.config, token);
    const travellers = await ctx.tx.employees.listActive(booking.id);
    return {
      body: {
        url,
        messages: invitationMessages(booking, url),
        window: publicWindow(bookingWindow(booking, travellers, ctx.deps.clock.now())),
      },
    };
  });

  // --- Deadlines (H3): hospitality only, reason required -------------------------

  function cleanDeadline(ctx) {
    const date = parseCalendarDate(ctx.body.date);
    if (!date) throw badRequest('invalid_date', 'Enter the new deadline as DD/MM/YYYY.');
    const deadlineAt = `${date} ${END_OF_DAY}`;
    if (deadlineAt <= toIstSql(ctx.deps.clock.now())) throw badRequest('invalid_date', 'The new deadline must be in the future.');
    const reason = typeof ctx.body.reason === 'string' ? ctx.body.reason.trim() : '';
    if (!reason) throw badRequest('reason_required', 'Add a short reason for the change.');
    if (reason.length > 500) throw badRequest('reason_too_long', 'The reason can be at most 500 characters.');
    return { deadlineAt, reason };
  }

  function requireDeadlineChangeable(booking) {
    if (['cancelled', 'completed', 'files_deleted'].includes(booking.status)) {
      throw new HttpError(409, 'invalid_transition', `A booking that is ${STATUS_LABELS[booking.status]} has no deadline to change.`);
    }
  }

  // Sets or extends the booking's deadline (including the first one of a short-notice booking).
  defineRoute(router, 'post', '/:id/deadline', { permission: 'deadlines.extend', audit: 'bookings.deadline.extend' }, async (ctx) => {
    const booking = await loadBooking(ctx, { lock: true });
    requireDeadlineChangeable(booking);
    const { deadlineAt, reason } = cleanDeadline(ctx);
    await ctx.tx.bookings.update(booking.id, { deadlineAt });
    await touch(ctx, booking.id);
    ctx.audit.details = { changes: { deadlineAt: { old: booking.deadlineAt, new: deadlineAt } }, reason };
    return { body: { booking: publicBooking(await ctx.tx.bookings.findById(booking.id)) } };
  });

  // A personal extension for one traveller.
  defineRoute(router, 'post', '/:id/employees/:employeeId/deadline', { permission: 'deadlines.extend', audit: 'bookings.employees.deadline.extend' }, async (ctx) => {
    const booking = await loadBooking(ctx, { lock: true });
    requireDeadlineChangeable(booking);
    const employee = await loadEmployee(ctx, booking);
    if (employee.isVacant) throw badRequest('vacant_row', 'Vacant positions have no deadline.');
    const { deadlineAt, reason } = cleanDeadline(ctx);
    await ctx.tx.employees.update(employee.id, { deadlineOverrideAt: deadlineAt, updatedAt: toIstSql(ctx.deps.clock.now()) });
    await touch(ctx, booking.id);
    ctx.audit.details = { changes: { deadlineOverrideAt: { old: employee.deadlineOverrideAt, new: deadlineAt } }, reason };
    return { body: { employee: publicEmployee(await ctx.tx.employees.findById(booking.id, employee.id)) } };
  });

  // --- Aadhaar files (staff) --------------------------------------------------------

  // Lists one traveller's files with short-lived signed links (coordinators of the
  // division before finalise, hospitality at any time; never admins).
  defineRoute(router, 'get', '/:id/employees/:employeeId/files', { permission: 'aadhaar.view', audit: 'aadhaar.files.list' }, async (ctx) => {
    const booking = await loadBooking(ctx);
    if (!canViewAadhaar(ctx.user, booking)) {
      throw new HttpError(403, 'forbidden', 'Aadhaar copies of this booking are not available to you.');
    }
    const employee = await loadEmployee(ctx, booking);
    const state = await submissionState(ctx, employee, { base: '/api/files', id: `user:${ctx.user.id}` });
    ctx.audit.details = { status: employee.submissionStatus, files: state.current?.files.length ?? 0 };
    return { body: { status: employee.submissionStatus, current: state.current } };
  });

  // --- Booking history (A3) ------------------------------------------------------

  defineRoute(router, 'get', '/:id/history', { permission: 'bookings.history.read', audit: 'bookings.history.read' }, async (ctx) => {
    const booking = await loadBooking(ctx);
    const limit = Math.min(parseId(ctx.query.limit) ?? 200, 500);
    const entries = await ctx.tx.audit.list({ bookingId: booking.id, limit });
    ctx.audit.details.count = entries.length;
    return {
      body: {
        entries: entries.map((e) => ({
          id: e.id,
          occurredAt: toIstIso(e.occurredAt),
          actorType: e.actorType,
          actor: e.actorType === 'user' ? e.actorEmail : (e.actorLabel ?? null),
          actorRole: e.actorRole,
          action: e.action,
          outcome: e.outcome,
          entityType: e.entityType,
          entityId: e.entityId,
          ip: e.ip,
          details: e.details,
        })),
      },
    };
  });

  defineRoute(router, 'patch', '/:id', { permission: 'bookings.edit', audit: 'bookings.update' }, async (ctx) => {
    const booking = await loadBooking(ctx, { edit: true, lock: true });
    const details = cleanDetails(ctx, ctx.body, booking);
    const next = { ...details };
    if ('hotelId' in ctx.body || 'hotelName' in ctx.body) {
      const hotel = await resolveHotel(ctx, ctx.body);
      next.hotelId = hotel.id;
      next.hotelName = hotel.name;
    }
    if (details.checkInDate !== booking.checkInDate) {
      Object.assign(next, computeDeadline(details.checkInDate, ctx.deps.clock.now()));
    }

    const changes = {};
    for (const key of Object.keys(next)) {
      if (next[key] !== booking[key]) changes[key] = { old: booking[key], new: next[key] };
    }
    ctx.audit.details.changes = changes;
    if (Object.keys(changes).length) {
      await ctx.tx.bookings.update(booking.id, next);
      await touch(ctx, booking.id);
    }
    return { body: { booking: publicBooking(await ctx.tx.bookings.findById(booking.id)) } };
  });

  defineRoute(router, 'post', '/:id/actions', { permission: 'bookings.read', audit: 'bookings.transition' }, async (ctx) => {
    const booking = await loadBooking(ctx, { lock: true });
    ctx.audit.details.action = ctx.body.action;
    const plan = planTransition(ctx.user, booking, ctx.body.action, { note: ctx.body.note });
    if (ctx.body.action === 'start_collecting' && booking.employeeActive - booking.employeeCancelled < 1) {
      throw new HttpError(409, 'no_travellers', 'Add at least one traveller who is not vacant before you start collecting.');
    }

    const nowSql = toIstSql(ctx.deps.clock.now());
    const update = { status: plan.to, statusChangedAt: nowSql };
    if (plan.to === 'cancelled') {
      Object.assign(update, { previousStatus: plan.from, cancelledAt: nowSql, cancelledByUserId: ctx.user.id, cancellationNote: plan.note });
    } else if (plan.from === 'cancelled') {
      Object.assign(update, { previousStatus: null, cancelledAt: null, cancelledByUserId: null, cancellationNote: null });
    }
    await ctx.tx.bookings.update(booking.id, update);
    await touch(ctx, booking.id);
    ctx.audit.details = { action: ctx.body.action, changes: { status: { old: plan.from, new: plan.to } }, note: plan.note };

    const updated = await ctx.tx.bookings.findById(booking.id);
    return { body: { booking: publicBooking(updated), actions: availableActions(ctx.user, updated) } };
  });

  // --- Employee list ------------------------------------------------------------

  // Preview: reads the uploaded file and reports row errors and counts. Saves nothing.
  router.post('/:id/employees/preview', express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 * 1024 }));
  defineRoute(router, 'post', '/:id/employees/preview', { permission: 'bookings.edit', audit: 'bookings.employees.import_preview' }, async (ctx) => {
    const booking = await loadBooking(ctx, { edit: true });
    const format = ctx.query.format === 'csv' ? 'csv' : 'xlsx';
    const mode = parseMode(ctx.query.mode);
    ctx.audit.details = { format, mode };

    let parsed;
    try {
      parsed = await parseEmployeeFile(Buffer.isBuffer(ctx.req.body) ? ctx.req.body : null, format);
    } catch (err) {
      if (err instanceof FileProblem) throw badRequest('invalid_file', err.message);
      throw err;
    }
    const existing = await ctx.tx.employees.listByBooking(booking.id);
    const result = validateRows(parsed.rows, mode === 'append' ? existing : []);
    ctx.audit.details.summary = result.summary;
    return {
      body: { mode, ...result, ignoredColumns: parsed.ignoredColumns, currentCount: existing.length },
    };
  });

  // Confirm: re-checks the previewed rows and saves them in one transaction.
  defineRoute(router, 'post', '/:id/employees/import', { permission: 'bookings.edit', audit: 'bookings.employees.import' }, async (ctx) => {
    const booking = await loadBooking(ctx, { edit: true, lock: true });
    const mode = parseMode(ctx.body.mode);
    const input = ctx.body.rows;
    if (!Array.isArray(input) || !input.length) throw badRequest('no_rows', 'There are no rows to import.');
    if (input.length > MAX_ROWS) throw badRequest('too_many_rows', `At most ${MAX_ROWS} rows can be imported.`);

    const existing = await ctx.tx.employees.listByBooking(booking.id);
    const result = validateRows(input.map((r) => ({ rowNumber: r.rowNumber, ...employeeInput(r) })), mode === 'append' ? existing : []);
    ctx.audit.details = { mode, summary: result.summary };
    if (result.summary.withErrors) return rowError(result);

    let removed = 0;
    if (mode === 'replace') {
      const uploaded = await ctx.tx.employees.countWithUploads(booking.id);
      if (uploaded) {
        ctx.audit.details.reason = 'uploads_on_file';
        throw new HttpError(409, 'uploads_on_file',
          `${uploaded} ${uploaded === 1 ? 'person has' : 'people have'} already uploaded their Aadhaar, so the list cannot be replaced. Add to the list instead, or remove people one at a time.`);
      }
      await purgeEmployees(ctx, booking.id, existing.map((e) => e.id));
      removed = await ctx.tx.employees.deleteByBooking(booking.id);
    }
    const now = toIstSql(ctx.deps.clock.now());
    for (const row of result.rows) {
      const { rowNumber, errors, ...fields } = row;
      await ctx.tx.employees.insert({ bookingId: booking.id, ...fields, createdAt: now, updatedAt: now });
    }
    await touch(ctx, booking.id);
    ctx.audit.details.removed = removed;
    return { status: 201, body: { summary: result.summary, removed } };
  });

  defineRoute(router, 'post', '/:id/employees', { permission: 'bookings.edit', audit: 'bookings.employees.add' }, async (ctx) => {
    const booking = await loadBooking(ctx, { edit: true, lock: true });
    const existing = await ctx.tx.employees.listByBooking(booking.id);
    const result = validateRows([employeeInput(ctx.body)], existing);
    const [row] = result.rows;
    if (row.errors.length) return rowError(result);

    const { rowNumber, errors, ...fields } = row;
    const now = toIstSql(ctx.deps.clock.now());
    const id = await ctx.tx.employees.insert({ bookingId: booking.id, ...fields, createdAt: now, updatedAt: now });
    await touch(ctx, booking.id);
    ctx.audit.entityType = 'booking_employee';
    ctx.audit.entityId = id;
    ctx.audit.details.new = fields;
    return { status: 201, body: { employee: publicEmployee(await ctx.tx.employees.findById(booking.id, id)) } };
  });

  // Replace: edit the row, or swap in a different person for the same place.
  defineRoute(router, 'put', '/:id/employees/:employeeId', { permission: 'bookings.edit', audit: 'bookings.employees.replace' }, async (ctx) => {
    const booking = await loadBooking(ctx, { edit: true, lock: true });
    const employee = await loadEmployee(ctx, booking);
    const others = (await ctx.tx.employees.listByBooking(booking.id)).filter((e) => e.id !== employee.id);
    const result = validateRows([employeeInput(ctx.body)], others);
    const [row] = result.rows;
    if (row.errors.length) return rowError(result);

    const { rowNumber, errors, ...fields } = row;
    const changes = {};
    for (const key of Object.keys(fields)) {
      if (fields[key] !== employee[key]) changes[key] = { old: employee[key], new: fields[key] };
    }
    ctx.audit.details.changes = changes;
    if (!Object.keys(changes).length) return { body: { employee: publicEmployee(employee) } };

    const update = { ...fields, updatedAt: toIstSql(ctx.deps.clock.now()) };
    // A different person (new code or email) starts again: their invitation and
    // submission status belong to the person who left.
    if (changes.employeeCode || changes.email) {
      Object.assign(update, {
        inviteStatus: 'not_sent', inviteSentAt: null, inviteSentVia: null, openedAt: null,
        personalTokenHash: null, submissionStatus: 'pending', submittedAt: null, deadlineOverrideAt: null,
      });
      ctx.audit.details.newPerson = true;
      // The Aadhaar, codes and session of the person who left go with them.
      ctx.audit.details.filesDeleted = await purgeEmployees(ctx, booking.id, [employee.id]);
    }
    await ctx.tx.employees.update(employee.id, update);
    await touch(ctx, booking.id);
    return { body: { employee: publicEmployee(await ctx.tx.employees.findById(booking.id, employee.id)) } };
  });

  defineRoute(router, 'delete', '/:id/employees/:employeeId', { permission: 'bookings.edit', audit: 'bookings.employees.remove' }, async (ctx) => {
    const booking = await loadBooking(ctx, { edit: true, lock: true });
    const employee = await loadEmployee(ctx, booking);
    ctx.audit.details.old = Object.fromEntries(EMPLOYEE_FIELDS.map((k) => [k, employee[k]]));
    ctx.audit.details.filesDeleted = await purgeEmployees(ctx, booking.id, [employee.id]);
    await ctx.tx.employees.delete(employee.id);
    await touch(ctx, booking.id);
    return { status: 204 };
  });

  // Vacant flip: coordinators until finalise, hospitality at any time (canEditBooking).
  defineRoute(router, 'patch', '/:id/employees/:employeeId/vacant', { permission: 'bookings.edit', audit: 'bookings.employees.vacant' }, async (ctx) => {
    const booking = await loadBooking(ctx, { edit: true, lock: true });
    const employee = await loadEmployee(ctx, booking);
    if (typeof ctx.body.isVacant !== 'boolean') throw badRequest('invalid_field', 'isVacant must be true or false.');
    const isVacant = ctx.body.isVacant;
    ctx.audit.details.changes = { isVacant: { old: employee.isVacant, new: isVacant } };
    if (isVacant === employee.isVacant) return { body: { employee: publicEmployee(employee) } };

    if (!isVacant) {
      const others = (await ctx.tx.employees.listByBooking(booking.id)).filter((e) => e.id !== employee.id);
      const [row] = validateRows([{ ...employee, isVacant: false }], others).rows;
      if (row.errors.length) {
        throw badRequest('incomplete_row', `Before marking this row as not vacant: ${row.errors.join(' ')}`);
      }
    }
    await ctx.tx.employees.update(employee.id, { isVacant, updatedAt: toIstSql(ctx.deps.clock.now()) });
    await touch(ctx, booking.id);
    return { body: { employee: publicEmployee(await ctx.tx.employees.findById(booking.id, employee.id)) } };
  });

  return router;
}

module.exports = { bookingRoutes, publicBooking };
