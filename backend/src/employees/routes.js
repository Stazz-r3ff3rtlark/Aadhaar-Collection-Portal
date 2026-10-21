'use strict';

const express = require('express');
const { defineRoute } = require('../http/route');
const { HttpError, badRequest, notFound } = require('../lib/errors');
const { toIstSql, toIstIso, addDays, formatIstDate } = require('../lib/time');
const { uploadWindow, bookingWindow } = require('../bookings/upload-lock');
const { tokenHash, bookingFacts, TOKEN_PATTERN } = require('./booking-link');
const { maskEmail, requestEmployeeCode, verifyEmployeeCode } = require('./identify');
const { clearEmployeeCookie } = require('./employee-session');
const {
  CARD_TYPES, CONSENT_VERSION, consentText, displacedBy, submissionState, startDraft, completeIfReady,
} = require('./submission');
const { processUpload, UploadProblem } = require('../files/process-upload');
const { checkFileSignature } = require('../files/signed-url');
const { discardFiles } = require('../files/deletion');

// The employee page behind the shared booking link (PRD C1, C4, C5). Mounted at /api/e.
//
// Before identification (public routes) the page gets only the booking's travel details.
// No list of names is ever sent: the employee types at least SEARCH_MIN_CHARS characters
// of their name or employee code and gets at most SEARCH_MAX_RESULTS matches (name and
// code only; never emails, mobiles or anything else). Vacant and cancelled rows never appear, and
// employees of other bookings cannot be reached through this booking's link.
//
// The link token travels in the X-Link-Token header, never in a URL, so it stays out of
// logs. After the emailed code, an employee session (cookie) carries the rest.

const LINK_HEADER = 'x-link-token';
const FILE_BASE = '/api/e/files';
const UPLOAD_SIDES = new Set(['front', 'back', 'document']);
const SEARCH_MIN_CHARS = 2;
const SEARCH_MAX_RESULTS = 10;

const parseId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** The booking named by the link token. Unknown tokens are audited without revealing anything. */
async function loadLinkBooking(ctx) {
  ctx.audit.entityType = 'booking';
  const token = ctx.req.get(LINK_HEADER) || '';
  const booking = TOKEN_PATTERN.test(token) ? await ctx.tx.bookings.findByShareTokenHash(tokenHash(token)) : null;
  if (!booking) {
    ctx.audit.details.reason = 'invalid_link';
    throw notFound('invalid_link', 'This link is not valid. Please ask your coordinator for the current booking link.');
  }
  ctx.audit.entityId = booking.id;
  ctx.audit.bookingId = booking.id;
  return booking;
}

/** An active traveller of this booking, picked from the list. Anything else is "not found". */
async function loadListedEmployee(ctx, booking) {
  const id = parseId(ctx.body.employeeId);
  ctx.audit.entityType = 'booking_employee';
  ctx.audit.entityId = ctx.body.employeeId == null ? null : String(ctx.body.employeeId).slice(0, 20);
  const employee = id ? await ctx.tx.employees.findById(booking.id, id) : null;
  let reason = null;
  if (!employee) reason = 'not_on_booking';
  else if (employee.isVacant) reason = 'vacant_row';
  else if (employee.cancelledAt) reason = 'employee_cancelled';
  if (reason) {
    ctx.audit.details.reason = reason;
    throw notFound('employee_not_found', 'We could not find that name on this booking. Pick your name from the list, or contact your coordinator.', { auditOutcome: 'denied' });
  }
  return employee;
}

/** Throws a friendly "closed" answer, audited as a denied (deadline-locked) attempt. */
function requireOpen(ctx, window) {
  if (window.open) return;
  ctx.audit.details.reason = window.reason;
  throw new HttpError(409, 'upload_closed', window.message, { auditOutcome: 'denied' });
}

function publicWindow(window) {
  return { open: window.open, reason: window.reason, message: window.message, deadlineAt: toIstIso(window.deadlineAt) };
}

function publicFacts(booking) {
  const f = bookingFacts(booking);
  return { event: f.event, hotel: f.hotel, city: f.city, location: f.location, checkIn: f.checkIn, checkOut: f.checkOut };
}

/**
 * Reads the raw upload before the route's transaction starts (a slow phone upload must
 * not hold a database connection), stopping at the size limit. Never throws: the route
 * answers and audits an oversized or missing body.
 */
function readUpload(maxBytes) {
  return (req, _res, next) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      req.upload = { buffer: tooLarge ? null : Buffer.concat(chunks), tooLarge, size };
      next();
    });
    req.on('error', next);
  };
}

function employeeRoutes(config) {
  const router = express.Router();
  const viewerFor = (employee) => ({ base: FILE_BASE, id: `employee:${employee.id}` });

  // --- Before identification -------------------------------------------------

  defineRoute(router, 'get', '/link', { auth: 'public', audit: 'employee.link.open' }, async (ctx) => {
    const booking = await loadLinkBooking(ctx);
    const travellers = await ctx.tx.employees.listActive(booking.id);
    const window = bookingWindow(booking, travellers, ctx.deps.clock.now());
    ctx.audit.details = { open: window.open, reason: window.reason, travellers: travellers.length };
    return {
      body: {
        booking: publicFacts(booking),
        window: publicWindow(window),
        search: { minChars: SEARCH_MIN_CHARS, maxResults: SEARCH_MAX_RESULTS },
      },
    };
  });

  // Name search: matches only once SEARCH_MIN_CHARS characters are typed, capped at
  // SEARCH_MAX_RESULTS, and only while collection is open. The search text itself is not
  // recorded (it is part of a name); the audit keeps its length and the match count.
  defineRoute(router, 'post', '/people/search', { auth: 'public', audit: 'employee.link.search' }, async (ctx) => {
    const booking = await loadLinkBooking(ctx);
    const query = typeof ctx.body.q === 'string' ? ctx.body.q.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 100) : '';
    const travellers = await ctx.tx.employees.listActive(booking.id);
    requireOpen(ctx, bookingWindow(booking, travellers, ctx.deps.clock.now()));
    if (query.length < SEARCH_MIN_CHARS) {
      ctx.audit.details = { queryLength: query.length, matches: 0 };
      return { body: { people: [], tooShort: true } };
    }
    const matches = travellers.filter((e) => e.name.toLowerCase().includes(query) || (e.employeeCode || '').toLowerCase().includes(query));
    ctx.audit.details = { queryLength: query.length, matches: matches.length };
    return {
      body: {
        people: matches.slice(0, SEARCH_MAX_RESULTS).map((e) => ({ id: e.id, name: e.name, employeeCode: e.employeeCode })),
        more: matches.length > SEARCH_MAX_RESULTS,
      },
    };
  });

  defineRoute(router, 'post', '/identify/request', { auth: 'public', audit: 'employee.identify.request_code' }, async (ctx) => {
    const booking = await loadLinkBooking(ctx);
    const employee = await loadListedEmployee(ctx, booking);
    requireOpen(ctx, uploadWindow(booking, employee, ctx.deps.clock.now()));
    return requestEmployeeCode(ctx, booking, employee);
  });

  defineRoute(router, 'post', '/identify/verify', { auth: 'public', audit: 'employee.identify.verify' }, async (ctx) => {
    const booking = await loadLinkBooking(ctx);
    const employee = await loadListedEmployee(ctx, booking);
    requireOpen(ctx, uploadWindow(booking, employee, ctx.deps.clock.now()));
    return verifyEmployeeCode(ctx, employee, ctx.body.code);
  });

  // --- After identification (employee session) -------------------------------

  /** The session's employee and booking, re-read inside this transaction. */
  async function loadSelf(ctx, { lock = false } = {}) {
    const { employee: sessionEmployee } = ctx;
    if (lock) await ctx.tx.employees.lock(sessionEmployee.id);
    const employee = await ctx.tx.employees.findByIdOnly(sessionEmployee.id);
    const booking = await ctx.tx.bookings.findById(employee.bookingId);
    ctx.audit.entityType = 'booking_employee';
    ctx.audit.entityId = employee.id;
    ctx.audit.bookingId = booking.id;
    return { employee, booking };
  }

  defineRoute(router, 'get', '/me', { auth: 'employee', audit: 'employee.page.read' }, async (ctx) => {
    const { employee, booking } = await loadSelf(ctx);
    // Opened from another booking's link: this session is not for that page.
    const header = ctx.req.get(LINK_HEADER);
    if (header && (!TOKEN_PATTERN.test(header) || tokenHash(header) !== booking.shareTokenHash)) {
      ctx.audit.details.reason = 'other_booking_link';
      throw new HttpError(401, 'employee_session_required', 'Open the booking link again and confirm your name.', { auditOutcome: 'denied' });
    }
    const window = uploadWindow(booking, employee, ctx.deps.clock.now());
    const state = await submissionState(ctx, employee, viewerFor(employee));
    ctx.audit.details = { open: window.open, status: employee.submissionStatus };
    return {
      body: {
        employee: { name: employee.name, maskedEmail: maskEmail(employee.email) },
        booking: publicFacts(booking),
        window: publicWindow(window),
        cardTypes: Object.entries(CARD_TYPES).map(([key, c]) => ({ key, label: c.label, sides: c.sides })),
        consent: {
          version: CONSENT_VERSION,
          text: consentText(booking.checkOutDate ? formatIstDate(addDays(booking.checkOutDate, 1)) : null),
        },
        maxBytes: config.upload.maxBytes,
        submission: state,
      },
    };
  });

  // Choosing the card type and ticking consent starts a (new) submission.
  defineRoute(router, 'post', '/submission', { auth: 'employee', audit: 'employee.submission.start' }, async (ctx) => {
    const { employee, booking } = await loadSelf(ctx, { lock: true });
    requireOpen(ctx, uploadWindow(booking, employee, ctx.deps.clock.now()));
    const { cardType, consent, consentVersion } = ctx.body;
    if (!CARD_TYPES[cardType]) throw badRequest('invalid_card_type', 'Choose your card type.');
    if (consent !== true || consentVersion !== CONSENT_VERSION) {
      throw badRequest('consent_required', 'Please read and tick the consent box before uploading.');
    }
    const id = await startDraft(ctx, employee, { cardType, consentAt: toIstSql(ctx.deps.clock.now()) });
    ctx.audit.entityType = 'submission';
    ctx.audit.entityId = id;
    ctx.audit.details = { cardType, consentVersion, replacing: employee.submissionStatus === 'submitted' };
    return { status: 201, body: { submission: await submissionState(ctx, employee, viewerFor(employee)) } };
  });

  router.put('/submission/files/:side', readUpload(config.upload.maxBytes));
  defineRoute(router, 'put', '/submission/files/:side', { auth: 'employee', audit: 'employee.upload' }, async (ctx) => {
    const { employee, booking } = await loadSelf(ctx, { lock: true });
    const requestedSide = ctx.params.side;
    ctx.audit.details = { side: UPLOAD_SIDES.has(requestedSide) ? requestedSide : 'invalid', sizeBytes: ctx.req.upload?.size ?? 0 };
    requireOpen(ctx, uploadWindow(booking, employee, ctx.deps.clock.now()));

    const draft = await ctx.tx.submissions.findDraft(employee.id);
    if (!draft) throw new HttpError(409, 'no_draft', 'Choose your card type and tick the consent box first.');
    if (!UPLOAD_SIDES.has(requestedSide) || (requestedSide === 'back' && !CARD_TYPES[draft.cardType].sides.includes('back'))) {
      throw badRequest('invalid_side', 'Choose which side of the card this is.');
    }

    let processed;
    try {
      if (ctx.req.upload?.tooLarge) {
        throw new UploadProblem('too_large', `This file is larger than ${Math.round(config.upload.maxBytes / 1024 / 1024)} MB. Take a new photo or upload a smaller file.`);
      }
      processed = await processUpload(ctx.req.upload?.buffer, config.upload);
    } catch (err) {
      if (!(err instanceof UploadProblem)) throw err;
      ctx.audit.details.reason = err.reason;
      throw new HttpError(err.reason === 'too_large' ? 413 : 400, err.reason, err.message);
    }

    // A PDF covers the whole card whichever slot it was dropped on; an image needs a side.
    const side = processed.kind === 'pdf' ? 'document' : requestedSide;
    if (side === 'document' && processed.kind !== 'pdf') throw badRequest('invalid_side', 'Choose which side of the card this photo shows.');

    const { fileStore, clock } = ctx.deps;
    const nowSql = toIstSql(clock.now());
    const storageKey = await fileStore.save(booking.id, processed.data);
    ctx.afterRollback(() => fileStore.remove(booking.id, storageKey));

    const existing = await ctx.tx.files.listBySubmission(draft.id);
    const replacedInDraft = await discardFiles(ctx, booking.id, displacedBy(side, existing), nowSql);
    const fileId = await ctx.tx.files.insert({
      submissionId: draft.id,
      bookingId: booking.id,
      side,
      storageKey,
      mimeType: processed.mimeType,
      sizeBytes: processed.data.length,
      pageCount: processed.pageCount,
      createdAt: nowSql,
    });
    const result = await completeIfReady(ctx, employee, draft);

    ctx.audit.entityType = 'submission_file';
    ctx.audit.entityId = fileId;
    Object.assign(ctx.audit.details, {
      side,
      sourceType: processed.sourceType,
      storedBytes: processed.data.length,
      pageCount: processed.pageCount,
      submissionId: draft.id,
      replacedInDraft,
      completed: result.completed,
    });
    if (result.completed) {
      await ctx.recordAudit({
        action: result.replaced ? 'employee.submission.replaced' : 'employee.submission.submitted',
        entityType: 'submission',
        entityId: String(draft.id),
        bookingId: booking.id,
        details: { cardType: draft.cardType, previousSubmissionId: result.previousId },
      });
    }
    const updated = await ctx.tx.employees.findByIdOnly(employee.id);
    return { status: 201, body: { completed: result.completed, submission: await submissionState(ctx, updated, viewerFor(updated)) } };
  });

  // The employee's own files only, through a short-lived link tied to their session.
  defineRoute(router, 'get', '/files/:fileId', { auth: 'employee', audit: 'employee.file.view' }, async (ctx) => {
    const { employee, booking } = await loadSelf(ctx);
    const id = parseId(ctx.params.fileId);
    ctx.audit.entityType = 'submission_file';
    ctx.audit.entityId = ctx.params.fileId;
    const file = id ? await ctx.tx.files.findById(id) : null;
    if (!file || file.bookingEmployeeId !== employee.id || file.deletedAt) {
      ctx.audit.details.reason = file ? 'not_own_file' : 'not_found';
      throw notFound('file_not_found', 'This file is no longer available.', { auditOutcome: file ? 'denied' : 'failure' });
    }
    const check = checkFileSignature(ctx.deps.config, file.id, `employee:${employee.id}`, ctx.query, ctx.deps.clock.now());
    if (check !== 'ok') {
      ctx.audit.details.reason = `link_${check}`;
      throw new HttpError(403, 'link_expired', 'This preview link has expired. Reload the page to see your file.', { auditOutcome: 'denied' });
    }
    const buffer = await ctx.deps.fileStore.read(booking.id, file.storageKey);
    ctx.audit.details = { side: file.side, mimeType: file.mimeType };
    return {
      file: { buffer, contentType: file.mimeType, inline: true, filename: `aadhaar-${file.side}.${file.mimeType === 'application/pdf' ? 'pdf' : 'jpg'}` },
    };
  });

  defineRoute(router, 'post', '/logout', { auth: 'employee', audit: 'employee.logout' }, async (ctx) => {
    const { employee } = await loadSelf(ctx);
    await ctx.tx.employeeSessions.update(ctx.employeeSession.id, { revokedAt: toIstSql(ctx.deps.clock.now()) });
    ctx.audit.details.sessionId = ctx.employeeSession.id;
    ctx.audit.employee = employee;
    clearEmployeeCookie(ctx);
    return { status: 204 };
  });

  return router;
}

module.exports = { employeeRoutes, LINK_HEADER };
