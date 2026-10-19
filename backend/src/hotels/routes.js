'use strict';

const express = require('express');
const { defineRoute } = require('../http/route');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { toIstSql } = require('../lib/time');
const { can } = require('../auth/policy');

// Hotels. Coordinators pick from this list or type a new name; a typed name becomes a
// "pending" hotel that admin or hospitality complete, or merge into an existing hotel
// when it is a duplicate. Hotels are archived (merged ones automatically), never deleted.

function cleanText(value, label, max, { required = false } = {}) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text && required) throw badRequest('invalid_field', `Enter the ${label}.`);
  if (text.length > max) throw badRequest('invalid_field', `The ${label} can be at most ${max} characters.`);
  return text || null;
}

function publicHotel(h) {
  return {
    id: h.id,
    name: h.name,
    city: h.city ?? null,
    reviewStatus: h.reviewStatus,
    archived: Boolean(h.archivedAt),
    mergedIntoHotelId: h.mergedIntoHotelId ?? null,
    mergedIntoName: h.mergedIntoName ?? null,
    bookingCount: h.bookingCount ?? undefined,
  };
}

/**
 * The hotel for a booking: an existing id, or a typed name. A typed name matching a
 * current hotel (ignoring case) reuses it; otherwise a pending hotel is created and
 * audited in the same transaction.
 */
async function resolveHotel(ctx, { hotelId, hotelName }) {
  if (hotelId != null && hotelId !== '') {
    const id = Number(hotelId);
    const hotel = Number.isInteger(id) ? await ctx.tx.hotels.findById(id) : null;
    if (!hotel || hotel.archivedAt) throw badRequest('invalid_hotel', 'Choose a hotel from the list, or type its name.');
    return hotel;
  }
  const name = cleanText(hotelName, 'hotel name', 200, { required: true });
  const existing = await ctx.tx.hotels.findCurrentByName(name);
  if (existing) return existing;

  const now = toIstSql(ctx.deps.clock.now());
  const id = await ctx.tx.hotels.insert({
    name, reviewStatus: 'pending', createdByUserId: ctx.user.id, updatedByUserId: ctx.user.id, createdAt: now, updatedAt: now,
  });
  await ctx.recordAudit({ action: 'hotels.create_pending', entityType: 'hotel', entityId: String(id), details: { new: { name } } });
  return ctx.tx.hotels.findById(id);
}

async function loadHotel(ctx) {
  const id = Number(ctx.params.id);
  ctx.audit.entityType = 'hotel';
  ctx.audit.entityId = ctx.params.id;
  const hotel = Number.isInteger(id) ? await ctx.tx.hotels.findById(id) : null;
  if (!hotel) throw notFound('hotel_not_found', 'Hotel not found.');
  return hotel;
}

async function assertNameFree(tx, name, exceptId) {
  const clash = await tx.hotels.findCurrentByName(name);
  if (clash && clash.id !== exceptId) {
    throw conflict('hotel_exists', `${clash.name} is already on the list. Merge the duplicate into it instead.`);
  }
}

function hotelRoutes() {
  const router = express.Router();

  defineRoute(router, 'get', '/', { permission: 'hotels.read', audit: 'hotels.list' }, async (ctx) => {
    const includeArchived = ctx.query.includeArchived === '1' && can(ctx.user, 'hotels.manage');
    const hotels = await ctx.tx.hotels.list({ includeArchived });
    ctx.audit.entityType = 'hotel';
    ctx.audit.details.count = hotels.length;
    return { body: { hotels: hotels.map(publicHotel) } };
  });

  defineRoute(router, 'post', '/', { permission: 'hotels.manage', audit: 'hotels.create' }, async (ctx) => {
    const name = cleanText(ctx.body.name, 'hotel name', 200, { required: true });
    const city = cleanText(ctx.body.city, 'city', 100);
    await assertNameFree(ctx.tx, name, null);
    const now = toIstSql(ctx.deps.clock.now());
    const id = await ctx.tx.hotels.insert({
      name, city, reviewStatus: 'active', createdByUserId: ctx.user.id, updatedByUserId: ctx.user.id, createdAt: now, updatedAt: now,
    });
    ctx.audit.entityType = 'hotel';
    ctx.audit.entityId = id;
    ctx.audit.details.new = { name, city };
    return { status: 201, body: { hotel: publicHotel(await ctx.tx.hotels.findById(id)) } };
  });

  // Edit name or city, and/or complete a pending hotel (reviewStatus: 'active').
  defineRoute(router, 'patch', '/:id', { permission: 'hotels.manage', audit: 'hotels.update' }, async (ctx) => {
    const hotel = await loadHotel(ctx);
    if (hotel.archivedAt) throw conflict('hotel_archived', 'This hotel is archived.');
    const next = {
      name: 'name' in ctx.body ? cleanText(ctx.body.name, 'hotel name', 200, { required: true }) : hotel.name,
      city: 'city' in ctx.body ? cleanText(ctx.body.city, 'city', 100) : hotel.city,
      reviewStatus: hotel.reviewStatus,
    };
    if ('reviewStatus' in ctx.body) {
      if (ctx.body.reviewStatus !== 'active') throw badRequest('invalid_field', 'A hotel can only be marked as complete.');
      next.reviewStatus = 'active';
    }
    if (next.name !== hotel.name) await assertNameFree(ctx.tx, next.name, hotel.id);

    const changes = {};
    for (const key of Object.keys(next)) if (next[key] !== hotel[key]) changes[key] = { old: hotel[key], new: next[key] };
    ctx.audit.details.changes = changes;
    if (Object.keys(changes).length) {
      await ctx.tx.hotels.update(hotel.id, { ...next, updatedByUserId: ctx.user.id, updatedAt: toIstSql(ctx.deps.clock.now()) });
    }
    return { body: { hotel: publicHotel(await ctx.tx.hotels.findById(hotel.id)) } };
  });

  // Merge a duplicate into another hotel: its bookings move over and it is archived.
  defineRoute(router, 'post', '/:id/merge', { permission: 'hotels.manage', audit: 'hotels.merge' }, async (ctx) => {
    const hotel = await loadHotel(ctx);
    if (hotel.archivedAt) throw conflict('hotel_archived', 'This hotel is already archived or merged.');
    const targetId = Number(ctx.body.intoHotelId);
    const target = Number.isInteger(targetId) ? await ctx.tx.hotels.findById(targetId) : null;
    if (!target || target.archivedAt) throw badRequest('invalid_hotel', 'Choose the hotel to merge into.');
    if (target.id === hotel.id) throw badRequest('invalid_hotel', 'A hotel cannot be merged into itself.');

    const now = toIstSql(ctx.deps.clock.now());
    const moved = await ctx.tx.hotels.repointBookings(hotel.id, target.id);
    await ctx.tx.hotels.update(hotel.id, {
      mergedIntoHotelId: target.id, archivedAt: now, updatedByUserId: ctx.user.id, updatedAt: now,
    });
    ctx.audit.details = { from: { id: hotel.id, name: hotel.name }, into: { id: target.id, name: target.name }, bookingsMoved: moved };
    return { body: { hotel: publicHotel(await ctx.tx.hotels.findById(target.id)), bookingsMoved: moved } };
  });

  return router;
}

module.exports = { hotelRoutes, resolveHotel, publicHotel };
