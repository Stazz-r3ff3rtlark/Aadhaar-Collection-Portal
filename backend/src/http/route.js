'use strict';

const { HttpError } = require('../lib/errors');
const logger = require('../lib/logger');
const { can } = require('../auth/policy');

// Every API endpoint is declared through defineRoute(). It enforces, in one place:
//   - authentication ('public' or 'user'),
//   - the role permission, if any,
//   - the audit entry (CLAUDE.md rule 3). A route cannot be registered without an
//     audit action, and the entry is written in the same transaction as the handler's
//     changes, so an action never commits without its audit record.
// Denied and failed attempts are audited as well.
//
// Handlers receive a context and return { status?, body? }, or { file } for a download.
// They set ctx.audit fields
// (entityType, entityId, bookingId, details, outcome, actor) to describe what happened.

function createContext(req, deps, action) {
  const cookies = [];
  return {
    req,
    deps,
    user: req.auth?.user ?? null,
    session: req.auth?.session ?? null,
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
      entityType: null,
      entityId: null,
      bookingId: null,
      details: {},
    },
    cookies,
    setCookie: (name, value, options) => cookies.push({ name, value, options }),
    clearCookie: (name, options) => cookies.push({ name, clear: true, options }),
  };
}

function auditEntry(ctx, outcome, extraDetails) {
  const actor = ctx.audit.actor || ctx.user;
  return {
    actorType: actor ? 'user' : 'anonymous',
    actorUserId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    actorRole: actor?.role ?? null,
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

function send(res, ctx, status, body, file) {
  for (const c of ctx.cookies) {
    if (c.clear) res.clearCookie(c.name, c.options);
    else res.cookie(c.name, c.value, c.options);
  }
  res.set('Cache-Control', 'no-store');
  if (file) {
    res.status(status).type(file.contentType).attachment(file.filename).send(file.buffer);
  } else if (body === undefined) res.status(status).end();
  else res.status(status).json(body);
}

/**
 * @param router  express.Router
 * @param method  'get' | 'post' | 'patch' | 'put' | 'delete'
 * @param path    route path
 * @param options { auth: 'public' | 'user', permission?: string, audit: string }
 * @param handler async (ctx) => ({ status?, body? })
 */
function defineRoute(router, method, path, options, handler) {
  const { auth = 'user', permission, audit: action } = options;
  if (!action) throw new Error(`${method.toUpperCase()} ${path}: every route must declare an audit action`);
  if (!['public', 'user'].includes(auth)) throw new Error(`${method.toUpperCase()} ${path}: unknown auth "${auth}"`);
  if (permission) can({ isActive: true, role: 'admin' }, permission); // throws on a misspelt permission

  router[method](path, async (req, res, next) => {
    const deps = req.app.locals.deps;
    const ctx = createContext(req, deps, action);
    try {
      if (auth === 'user' && !ctx.user) {
        await recordStandalone(ctx, 'denied', { reason: 'unauthenticated' });
        return send(res, ctx, 401, { error: 'unauthenticated', message: 'Please sign in.' });
      }
      if (permission && !can(ctx.user, permission)) {
        await recordStandalone(ctx, 'denied', { reason: 'forbidden', permission });
        return send(res, ctx, 403, { error: 'forbidden', message: 'You do not have access to this.' });
      }

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
      return send(res, ctx, result.status, result.body, result.file);
    } catch (err) {
      ctx.tx = null;
      ctx.cookies.length = 0;
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
