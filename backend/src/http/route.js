'use strict';

const { HttpError } = require('../lib/errors');
const logger = require('../lib/logger');
const { can } = require('../auth/policy');

// Every API endpoint is declared through defineRoute(). It enforces, in one place:
//   - authentication ('public', 'user' for internal users, or 'employee' for a traveller
//     who confirmed their emailed code on the booking link),
//   - the role permission, if any,
//   - the audit entry (CLAUDE.md rule 3). A route cannot be registered without an
//     audit action, and the entry is written in the same transaction as the handler's
//     changes, so an action never commits without its audit record.
// Denied and failed attempts are audited as well.
//
// Handlers receive a context and return { status?, body? }, or { file } for a download.
// They set ctx.audit fields
// (entityType, entityId, bookingId, details, outcome, actor, employee) to describe what happened.
//
// Files on disk are not part of the database transaction. Handlers register
// ctx.afterCommit(fn) for removals that must only happen once the change is saved, and
// ctx.afterRollback(fn) to remove files written by a request that then failed.

function createContext(req, deps, action) {
  const cookies = [];
  return {
    req,
    deps,
    user: req.auth?.user ?? null,
    session: req.auth?.session ?? null,
    employee: req.employeeAuth?.employee ?? null,
    employeeSession: req.employeeAuth?.session ?? null,
    body: req.body ?? {},
    params: req.params,
    query: req.query,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId,
    tx: null,
    audit: {
      action,
      outcome: null,
      actor: null,
      employee: null,
      entityType: null,
      entityId: null,
      bookingId: null,
      details: {},
    },
    cookies,
    commitHooks: [],
    rollbackHooks: [],
    afterCommit: null,
    afterRollback: null,
    setCookie: (name, value, options) => cookies.push({ name, value, options }),
    clearCookie: (name, options) => cookies.push({ name, clear: true, options }),
  };
}

/** Who acted: an internal user, else an identified employee (shown by name), else anonymous. */
function actorFields(ctx) {
  const user = ctx.audit.actor || ctx.user;
  if (user) return { actorType: 'user', actorUserId: user.id, actorEmail: user.email, actorRole: user.role, actorLabel: null };
  const employee = ctx.audit.employee || ctx.employee;
  if (employee) {
    return { actorType: 'employee', actorUserId: null, actorEmail: null, actorRole: 'employee', actorLabel: employee.name };
  }
  return { actorType: 'anonymous', actorUserId: null, actorEmail: null, actorRole: null, actorLabel: null };
}

function auditEntry(ctx, outcome, extraDetails) {
  return {
    ...actorFields(ctx),
    action: ctx.audit.action,
    outcome,
    entityType: ctx.audit.entityType,
    entityId: ctx.audit.entityId == null ? null : String(ctx.audit.entityId),
    bookingId: ctx.audit.bookingId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    details: { ...ctx.audit.details, ...extraDetails },
  };
}

async function recordStandalone(ctx, outcome, extraDetails) {
  const { store, audit } = ctx.deps;
  await store.transaction((tx) => audit.record(tx, auditEntry(ctx, outcome, extraDetails)));
}

async function runHooks(ctx, hooks, when) {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (err) {
      logger.error('request hook failed', { action: ctx.audit.action, when, requestId: ctx.requestId, ...logger.errorFields(err) });
    }
  }
}

function send(res, ctx, status, body, file) {
  for (const c of ctx.cookies) {
    if (c.clear) res.clearCookie(c.name, c.options);
    else res.cookie(c.name, c.value, c.options);
  }
  res.set('Cache-Control', 'no-store');
  if (file) {
    res.status(status).type(file.contentType);
    if (file.inline) res.set('Content-Disposition', `inline; filename="${file.filename}"`);
    else res.attachment(file.filename);
    res.send(file.buffer);
  } else if (body === undefined) res.status(status).end();
  else res.status(status).json(body);
}

const UNAUTHENTICATED = {
  user: { error: 'unauthenticated', message: 'Please sign in.' },
  employee: { error: 'employee_session_required', message: 'Your session has ended. Open the booking link again and confirm your name.' },
};

/**
 * @param router  express.Router
 * @param method  'get' | 'post' | 'patch' | 'put' | 'delete'
 * @param path    route path
 * @param options { auth: 'public' | 'user' | 'employee', permission?: string, audit: string }
 * @param handler async (ctx) => ({ status?, body? })
 */
function defineRoute(router, method, path, options, handler) {
  const { auth = 'user', permission, audit: action } = options;
  if (!action) throw new Error(`${method.toUpperCase()} ${path}: every route must declare an audit action`);
  if (!['public', 'user', 'employee'].includes(auth)) throw new Error(`${method.toUpperCase()} ${path}: unknown auth "${auth}"`);
  if (permission && auth !== 'user') throw new Error(`${method.toUpperCase()} ${path}: permissions apply to internal users only`);
  if (permission) can({ isActive: true, role: 'admin' }, permission); // throws on a misspelt permission

  router[method](path, async (req, res, next) => {
    const deps = req.app.locals.deps;
    const ctx = createContext(req, deps, action);
    let committed = false;
    try {
      if ((auth === 'user' && !ctx.user) || (auth === 'employee' && !ctx.employee)) {
        await recordStandalone(ctx, 'denied', { reason: 'unauthenticated' });
        return send(res, ctx, 401, UNAUTHENTICATED[auth]);
      }
      if (permission && !can(ctx.user, permission)) {
        await recordStandalone(ctx, 'denied', { reason: 'forbidden', permission });
        return send(res, ctx, 403, { error: 'forbidden', message: 'You do not have access to this.' });
      }

      ctx.afterCommit = (fn) => ctx.commitHooks.push(fn);
      ctx.afterRollback = (fn) => ctx.rollbackHooks.push(fn);
      const result = await deps.store.transaction(async (tx) => {
        ctx.tx = tx;
        // A second audit entry in the same transaction, for side effects such as a
        // pending hotel created while saving a booking.
        ctx.recordAudit = (fields) => deps.audit.record(tx, {
          ...auditEntry(ctx, 'success'),
          entityType: null,
          entityId: null,
          bookingId: null,
          details: {},
          ...fields,
        });
        const out = (await handler(ctx)) || {};
        const status = out.status ?? 200;
        const outcome = ctx.audit.outcome || (status >= 400 ? 'failure' : 'success');
        await deps.audit.record(tx, auditEntry(ctx, outcome));
        return { status, body: out.body, file: out.file };
      });
      committed = true;
      await runHooks(ctx, ctx.commitHooks, 'commit');
      return send(res, ctx, result.status, result.body, result.file);
    } catch (err) {
      ctx.tx = null;
      ctx.cookies.length = 0;
      if (!committed) await runHooks(ctx, ctx.rollbackHooks, 'rollback');
      const known = err instanceof HttpError;
      const status = known ? err.status : 500;
      try {
        const outcome = err.auditOutcome || (status === 403 ? 'denied' : 'failure');
        await recordStandalone(ctx, outcome, { error: known ? err.code : 'internal_error' });
      } catch (auditErr) {
        logger.error('audit write failed', { action, requestId: ctx.requestId, ...logger.errorFields(auditErr) });
      }
      if (!known) {
        logger.error('request failed', { action, requestId: ctx.requestId, ...logger.errorFields(err) });
        return next(err);
      }
      return send(res, ctx, status, { error: err.code, message: err.message });
    }
  });
}

module.exports = { defineRoute };
