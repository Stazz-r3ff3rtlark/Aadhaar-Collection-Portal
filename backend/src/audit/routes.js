'use strict';

const express = require('express');
const { defineRoute } = require('../http/route');
const { badRequest } = require('../lib/errors');
const { toIstIso } = require('../lib/time');

const optionalId = (value, name) => {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw badRequest('invalid_filter', `${name} must be a positive whole number.`);
  return n;
};

function auditRoutes() {
  const router = express.Router();

  // Full log for admins. The per-booking history (A3) for hospitality arrives with bookings.
  defineRoute(router, 'get', '/', { permission: 'audit.read', audit: 'audit.read' }, async (ctx) => {
    const filters = {
      action: typeof ctx.query.action === 'string' && ctx.query.action ? ctx.query.action.slice(0, 80) : undefined,
      actorUserId: optionalId(ctx.query.actorUserId, 'actorUserId'),
      bookingId: optionalId(ctx.query.bookingId, 'bookingId'),
      beforeId: optionalId(ctx.query.beforeId, 'beforeId'),
      limit: Math.min(optionalId(ctx.query.limit, 'limit') ?? 100, 500),
    };
    const entries = await ctx.tx.audit.list(filters);
    ctx.audit.entityType = 'audit_log';
    ctx.audit.details = { filters, count: entries.length };
    return {
      body: {
        entries: entries.map((e) => ({ ...e, occurredAt: toIstIso(e.occurredAt) })),
        nextBeforeId: entries.length === filters.limit ? entries.at(-1).id : null,
      },
    };
  });

  return router;
}

module.exports = { auditRoutes };
