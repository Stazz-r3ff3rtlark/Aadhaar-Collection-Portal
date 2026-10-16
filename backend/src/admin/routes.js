'use strict';

const express = require('express');
const { defineRoute } = require('../http/route');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { toIstSql } = require('../lib/time');
const { ALL_ROLES, ROLES } = require('../auth/policy');
const { normaliseEmail, requireCompanyEmail, publicUser } = require('../auth/auth-service');

// Admin console, M0 part: the sign-in allow-list (internal users). Users are deactivated,
// never deleted (PRD admin console: "Deactivate only, so history keeps its author").

const EDITABLE_FIELDS = ['name', 'role', 'divisionId', 'isActive'];

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 150) throw badRequest('invalid_name', 'Enter a name (up to 150 characters).');
  return name;
}

function cleanRole(value) {
  if (!ALL_ROLES.includes(value)) throw badRequest('invalid_role', `Role must be one of: ${ALL_ROLES.join(', ')}.`);
  return value;
}

/** Coordinators need a division; other roles must not have one. */
async function cleanDivision(tx, role, divisionId) {
  if (role !== ROLES.COORDINATOR) return null;
  const id = Number(divisionId);
  if (!Number.isInteger(id) || !(await tx.divisions.findById(id))) {
    throw badRequest('invalid_division', 'Choose a division for this sales coordinator.');
  }
  return id;
}

function adminRoutes() {
  const router = express.Router();

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
    const divisionId = await cleanDivision(ctx.tx, role, ctx.body.divisionId);
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
    const id = Number(ctx.params.id);
    ctx.audit.entityType = 'user';
    ctx.audit.entityId = ctx.params.id;
    const existing = Number.isInteger(id) ? await ctx.tx.users.findById(id) : null;
    if (!existing) throw notFound('user_not_found', 'User not found.');

    const unknown = Object.keys(ctx.body).filter((k) => !EDITABLE_FIELDS.includes(k));
    if (unknown.length) throw badRequest('invalid_field', `These fields cannot be changed here: ${unknown.join(', ')}.`);

    const next = {
      name: 'name' in ctx.body ? cleanName(ctx.body.name) : existing.name,
      role: 'role' in ctx.body ? cleanRole(ctx.body.role) : existing.role,
      isActive: 'isActive' in ctx.body ? ctx.body.isActive : existing.isActive,
    };
    if (typeof next.isActive !== 'boolean') throw badRequest('invalid_active', 'isActive must be true or false.');
    next.divisionId = await cleanDivision(ctx.tx, next.role, 'divisionId' in ctx.body ? ctx.body.divisionId : existing.divisionId);

    if (id === ctx.user.id && (!next.isActive || next.role !== ROLES.ADMIN)) {
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
    await ctx.tx.users.update(id, update);

    // Deactivation and role changes end every session at once.
    if (changes.isActive || changes.role || changes.divisionId) {
      ctx.audit.details.sessionsRevoked = await ctx.tx.sessions.revokeAllForUser(
        id, now, changes.isActive ? 'deactivated' : 'role_changed',
      );
    }
    return { body: { user: publicUser(await ctx.tx.users.findById(id)) } };
  });

  defineRoute(router, 'get', '/divisions', { permission: 'users.manage', audit: 'admin.divisions.list' }, async (ctx) => {
    const divisions = await ctx.tx.divisions.list();
    ctx.audit.entityType = 'division';
    ctx.audit.details.count = divisions.length;
    return { body: { divisions: divisions.map(({ id, name }) => ({ id, name })) } };
  });

  return router;
}

module.exports = { adminRoutes };
