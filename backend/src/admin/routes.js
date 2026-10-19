'use strict';

const express = require('express');
const { defineRoute } = require('../http/route');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { toIstSql, toIstIso } = require('../lib/time');
const { ALL_ROLES, ROLES } = require('../auth/policy');
const { normaliseEmail, requireCompanyEmail, publicUser } = require('../auth/auth-service');

// Admin console: the sign-in allow-list (users) and divisions (PRD "User and division rules").
//
// Users: every user has exactly one division. Users are deactivated rather than deleted;
// delete is only for accounts that never acted (e.g. created by mistake). Any change ends
// the user's sessions at once. Admins cannot deactivate, demote or delete themselves, and
// the last active admin can never be removed.

const USER_FIELDS = ['name', 'email', 'role', 'divisionId', 'isActive'];

function cleanName(value, max = 150) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > max) throw badRequest('invalid_name', `Enter a name (up to ${max} characters).`);
  return name;
}

function cleanRole(value) {
  if (!ALL_ROLES.includes(value)) throw badRequest('invalid_role', `Role must be one of: ${ALL_ROLES.join(', ')}.`);
  return value;
}

/** A division id that exists; it must be active unless it is the user's current one. */
async function cleanDivision(tx, divisionId, currentDivisionId) {
  const id = Number(divisionId);
  const division = Number.isInteger(id) ? await tx.divisions.findById(id) : null;
  if (!division) throw badRequest('invalid_division', 'Choose a division.');
  if (division.archivedAt && id !== currentDivisionId) {
    throw badRequest('division_archived', `The ${division.name} division is archived. Choose an active division.`);
  }
  return id;
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Refuses a change that would leave no active admin. Locks the admin rows so two
 * admins cannot remove each other at the same moment.
 */
async function guardLastAdmin(tx, target) {
  const activeAdmins = await tx.users.lockActiveAdmins();
  if (activeAdmins.length === 1 && activeAdmins[0] === target.id) {
    throw conflict('last_admin', 'This is the last active admin, so it cannot be removed, deactivated or demoted. Add or reactivate another admin first.');
  }
}

function publicDivision(d) {
  return {
    id: d.id,
    name: d.name,
    archived: Boolean(d.archivedAt),
    archivedAt: toIstIso(d.archivedAt),
    userCount: d.userCount ?? undefined,
    bookingCount: d.bookingCount ?? undefined,
  };
}

function adminRoutes() {
  const router = express.Router();

  // --- Users ---------------------------------------------------------------

  defineRoute(router, 'get', '/users', { permission: 'users.manage', audit: 'admin.users.list' }, async (ctx) => {
    const users = await ctx.tx.users.list();
    ctx.audit.entityType = 'user';
    ctx.audit.details.count = users.length;
    return { body: { users: users.map(publicUser) } };
  });

  defineRoute(router, 'post', '/users', { permission: 'users.manage', audit: 'admin.users.create' }, async (ctx) => {
    const email = normaliseEmail(ctx.body.email);
    requireCompanyEmail(ctx, email);
    const name = cleanName(ctx.body.name);
    const role = cleanRole(ctx.body.role);
    const divisionId = await cleanDivision(ctx.tx, ctx.body.divisionId, null);
    ctx.audit.entityType = 'user';
    ctx.audit.details.new = { email, name, role, divisionId };

    if (await ctx.tx.users.findByEmail(email)) throw conflict('user_exists', 'This email is already on the list.');

    const now = toIstSql(ctx.deps.clock.now());
    const id = await ctx.tx.users.insert({
      email, name, role, divisionId, isActive: true, createdByUserId: ctx.user.id, createdAt: now, updatedAt: now,
    });
    ctx.audit.entityId = id;
    return { status: 201, body: { user: publicUser(await ctx.tx.users.findById(id)) } };
  });

  defineRoute(router, 'patch', '/users/:id', { permission: 'users.manage', audit: 'admin.users.update' }, async (ctx) => {
    const id = parseId(ctx.params.id);
    ctx.audit.entityType = 'user';
    ctx.audit.entityId = ctx.params.id;
    const existing = id ? await ctx.tx.users.findById(id) : null;
    if (!existing) throw notFound('user_not_found', 'User not found.');

    const unknown = Object.keys(ctx.body).filter((k) => !USER_FIELDS.includes(k));
    if (unknown.length) throw badRequest('invalid_field', `These fields cannot be changed here: ${unknown.join(', ')}.`);

    const next = {
      name: 'name' in ctx.body ? cleanName(ctx.body.name) : existing.name,
      email: existing.email,
      role: 'role' in ctx.body ? cleanRole(ctx.body.role) : existing.role,
      isActive: 'isActive' in ctx.body ? ctx.body.isActive : existing.isActive,
      divisionId: 'divisionId' in ctx.body
        ? await cleanDivision(ctx.tx, ctx.body.divisionId, existing.divisionId)
        : existing.divisionId,
    };
    if (typeof next.isActive !== 'boolean') throw badRequest('invalid_active', 'isActive must be true or false.');
    if ('email' in ctx.body) {
      next.email = normaliseEmail(ctx.body.email);
      requireCompanyEmail(ctx, next.email);
      const holder = await ctx.tx.users.findByEmail(next.email);
      if (holder && holder.id !== id) throw conflict('user_exists', 'Another user already has this email.');
    }

    const removesAdmin = existing.role === ROLES.ADMIN && existing.isActive
      && (next.role !== ROLES.ADMIN || !next.isActive);
    if (removesAdmin) await guardLastAdmin(ctx.tx, existing);
    if (id === ctx.user.id && (removesAdmin || !next.isActive)) {
      throw badRequest('cannot_change_self', 'You cannot deactivate yourself or remove your own admin role.');
    }

    const changes = {};
    for (const key of Object.keys(next)) {
      if (next[key] !== existing[key]) changes[key] = { old: existing[key], new: next[key] };
    }
    ctx.audit.details.changes = changes;
    if (!Object.keys(changes).length) return { body: { user: publicUser(existing) } };

    const now = toIstSql(ctx.deps.clock.now());
    const update = { ...next, updatedAt: now };
    if (changes.isActive) update.deactivatedAt = next.isActive ? null : now;
    try {
      await ctx.tx.users.update(id, update);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('user_exists', 'Another user already has this email.');
      throw err;
    }

    // Any change signs the user out everywhere, so new details and permissions apply at once.
    const reason = changes.isActive && !next.isActive ? 'deactivated' : 'account_changed';
    ctx.audit.details.sessionsRevoked = await ctx.tx.sessions.revokeAllForUser(id, now, reason);
    return { body: { user: publicUser(await ctx.tx.users.findById(id)) } };
  });

  defineRoute(router, 'delete', '/users/:id', { permission: 'users.manage', audit: 'admin.users.delete' }, async (ctx) => {
    const id = parseId(ctx.params.id);
    ctx.audit.entityType = 'user';
    ctx.audit.entityId = ctx.params.id;
    const existing = id ? await ctx.tx.users.findById(id) : null;
    if (!existing) throw notFound('user_not_found', 'User not found.');
    ctx.audit.details.old = {
      email: existing.email, name: existing.name, role: existing.role, divisionId: existing.divisionId, isActive: existing.isActive,
    };

    if (existing.role === ROLES.ADMIN && existing.isActive) await guardLastAdmin(ctx.tx, existing);
    if (id === ctx.user.id) throw badRequest('cannot_change_self', 'You cannot delete your own account.');

    const activity = await ctx.tx.users.activity(id);
    const used = Object.values(activity).some((n) => Number(n) > 0);
    ctx.audit.details.activity = activity;
    const refuse = () => conflict(
      'user_has_history',
      'This account has been used in the system, so it cannot be deleted. Deactivate it instead; its history stays in the log.',
    );
    if (used) throw refuse();

    try {
      await ctx.tx.users.delete(id);
    } catch (err) {
      // Belt and braces: any row still pointing at the user means it was used.
      if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') throw refuse();
      throw err;
    }
    return { status: 204 };
  });

  // --- Divisions -----------------------------------------------------------

  defineRoute(router, 'get', '/divisions', { permission: 'divisions.manage', audit: 'admin.divisions.list' }, async (ctx) => {
    const divisions = await ctx.tx.divisions.list({ includeArchived: true });
    ctx.audit.entityType = 'division';
    ctx.audit.details.count = divisions.length;
    return { body: { divisions: divisions.map(publicDivision) } };
  });

  async function uniqueDivisionName(tx, value, exceptId) {
    const name = cleanName(value, 100);
    const clash = await tx.divisions.findByName(name);
    if (clash && clash.id !== exceptId) throw conflict('division_exists', `A division called ${clash.name} already exists.`);
    return name;
  }

  async function loadDivision(ctx) {
    const id = parseId(ctx.params.id);
    ctx.audit.entityType = 'division';
    ctx.audit.entityId = ctx.params.id;
    const division = id ? await ctx.tx.divisions.findById(id) : null;
    if (!division) throw notFound('division_not_found', 'Division not found.');
    return division;
  }

  defineRoute(router, 'post', '/divisions', { permission: 'divisions.manage', audit: 'admin.divisions.create' }, async (ctx) => {
    const name = await uniqueDivisionName(ctx.tx, ctx.body.name, null);
    const now = toIstSql(ctx.deps.clock.now());
    const id = await ctx.tx.divisions.insert({ name, createdAt: now, updatedAt: now });
    ctx.audit.entityType = 'division';
    ctx.audit.entityId = id;
    ctx.audit.details.new = { name };
    return { status: 201, body: { division: publicDivision(await ctx.tx.divisions.findById(id)) } };
  });

  defineRoute(router, 'patch', '/divisions/:id', { permission: 'divisions.manage', audit: 'admin.divisions.rename' }, async (ctx) => {
    const division = await loadDivision(ctx);
    const name = await uniqueDivisionName(ctx.tx, ctx.body.name, division.id);
    ctx.audit.details.changes = { name: { old: division.name, new: name } };
    await ctx.tx.divisions.update(division.id, { name, updatedAt: toIstSql(ctx.deps.clock.now()) });
    return { body: { division: publicDivision(await ctx.tx.divisions.findById(division.id)) } };
  });

  defineRoute(router, 'post', '/divisions/:id/archive', { permission: 'divisions.manage', audit: 'admin.divisions.archive' }, async (ctx) => {
    const division = await loadDivision(ctx);
    if (division.archivedAt) throw conflict('already_archived', 'This division is already archived.');
    const now = toIstSql(ctx.deps.clock.now());
    await ctx.tx.divisions.update(division.id, { archivedAt: now, updatedAt: now });
    ctx.audit.details.name = division.name;
    return { body: { division: publicDivision(await ctx.tx.divisions.findById(division.id)) } };
  });

  defineRoute(router, 'post', '/divisions/:id/restore', { permission: 'divisions.manage', audit: 'admin.divisions.restore' }, async (ctx) => {
    const division = await loadDivision(ctx);
    if (!division.archivedAt) throw conflict('not_archived', 'This division is not archived.');
    await ctx.tx.divisions.update(division.id, { archivedAt: null, updatedAt: toIstSql(ctx.deps.clock.now()) });
    ctx.audit.details.name = division.name;
    return { body: { division: publicDivision(await ctx.tx.divisions.findById(division.id)) } };
  });

  defineRoute(router, 'delete', '/divisions/:id', { permission: 'divisions.manage', audit: 'admin.divisions.delete' }, async (ctx) => {
    const division = await loadDivision(ctx);
    const usage = await ctx.tx.divisions.usage(division.id);
    ctx.audit.details = { name: division.name, usage };
    if (usage.users > 0 || usage.bookings > 0) {
      throw conflict(
        'division_in_use',
        `${division.name} has ${usage.users} user(s) and ${usage.bookings} booking(s), so it cannot be deleted. Archive it instead.`,
      );
    }
    await ctx.tx.divisions.delete(division.id);
    return { status: 204 };
  });

  return router;
}

/** Division names for every signed-in user (filters, forms). Not sensitive. */
function divisionRoutes() {
  const router = express.Router();
  defineRoute(router, 'get', '/', { auth: 'user', audit: 'divisions.list' }, async (ctx) => {
    const divisions = await ctx.tx.divisions.list({ includeArchived: ctx.query.includeArchived === '1' });
    ctx.audit.entityType = 'division';
    ctx.audit.details.count = divisions.length;
    return { body: { divisions: divisions.map(({ id, name, archivedAt }) => ({ id, name, archived: Boolean(archivedAt) })) } };
  });
  return router;
}

module.exports = { adminRoutes, divisionRoutes };
