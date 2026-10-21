'use strict';

const express = require('express');
const { defineRoute } = require('../http/route');
const { HttpError, notFound } = require('../lib/errors');
const { canViewBooking, canViewAadhaar } = require('../auth/policy');
const { checkFileSignature } = require('./signed-url');

// Staff viewing of one Aadhaar file. Mounted at /api/files. The link comes from
// GET /api/bookings/:id/employees/:employeeId/files, is signed for the person who asked,
// expires within minutes, and needs that person's session as well. Every view is audited.

function fileRoutes() {
  const router = express.Router();

  defineRoute(router, 'get', '/:fileId', { permission: 'aadhaar.view', audit: 'aadhaar.file.view' }, async (ctx) => {
    const id = Number(ctx.params.fileId);
    ctx.audit.entityType = 'submission_file';
    ctx.audit.entityId = ctx.params.fileId;
    const file = Number.isInteger(id) && id > 0 ? await ctx.tx.files.findById(id) : null;
    const booking = file ? await ctx.tx.bookings.findById(file.bookingId) : null;
    if (booking) ctx.audit.bookingId = booking.id;
    if (!file || !booking || file.deletedAt || !canViewBooking(ctx.user, booking)) {
      ctx.audit.details.reason = !file || !booking ? 'not_found' : (file.deletedAt ? 'deleted' : 'other_division');
      throw notFound('file_not_found', 'This file is no longer available.', { auditOutcome: booking && !file.deletedAt ? 'denied' : 'failure' });
    }
    if (!canViewAadhaar(ctx.user, booking)) {
      ctx.audit.details.reason = 'not_allowed_for_status';
      throw new HttpError(403, 'forbidden', 'Aadhaar copies of this booking are not available to you.');
    }
    const check = checkFileSignature(ctx.deps.config, file.id, `user:${ctx.user.id}`, ctx.query, ctx.deps.clock.now());
    if (check !== 'ok') {
      ctx.audit.details.reason = `link_${check}`;
      throw new HttpError(403, 'link_expired', 'This link has expired. Open the file again from the booking page.', { auditOutcome: 'denied' });
    }
    const buffer = await ctx.deps.fileStore.read(booking.id, file.storageKey);
    ctx.audit.details = { side: file.side, mimeType: file.mimeType, bookingEmployeeId: file.bookingEmployeeId };
    return {
      file: { buffer, contentType: file.mimeType, inline: true, filename: `aadhaar-${file.side}.${file.mimeType === 'application/pdf' ? 'pdf' : 'jpg'}` },
    };
  });

  return router;
}

module.exports = { fileRoutes };
