'use strict';

const express = require('express');
const helmet = require('helmet');
const logger = require('./lib/logger');
const { randomUUID } = require('./lib/crypto');
const { sessionMiddleware } = require('./http/session');
const { authRoutes } = require('./auth/routes');
const { adminRoutes } = require('./admin/routes');
const { auditRoutes } = require('./audit/routes');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Request ID plus one access line per request: method, route pattern, status, timing. No URLs with tokens, no bodies. */
function requestLog(req, res, next) {
  req.requestId = randomUUID();
  res.set('X-Request-Id', req.requestId);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    logger.info('request', {
      requestId: req.requestId,
      method: req.method,
      route: req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched',
      status: res.statusCode,
      ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
      userId: req.auth?.user?.id,
    });
  });
  next();
}

/**
 * CSRF defence for the same-site setup: state-changing requests must come from our own
 * origin. Browsers send Origin on every cross-origin POST, and Sec-Fetch-Site on all
 * modern browsers. Blocked attempts are audited.
 */
function originGuard(deps) {
  return async (req, res, next) => {
    if (!MUTATING_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');
    const allowed = origin ? origin === deps.config.appOrigin : fetchSite !== 'cross-site';
    if (allowed) return next();
    try {
      await deps.store.transaction((tx) => deps.audit.record(tx, {
        actorType: 'anonymous',
        action: 'security.request_blocked',
        outcome: 'denied',
        ip: req.ip,
        userAgent: req.get('user-agent'),
        requestId: req.requestId,
        details: { reason: 'cross_origin', method: req.method, path: req.path, origin: origin || null },
      }));
    } catch (err) {
      logger.error('audit write failed', { action: 'security.request_blocked', ...logger.errorFields(err) });
    }
    return res.status(403).json({ error: 'forbidden_origin', message: 'Request blocked.' });
  };
}

/**
 * @param deps { config, store, audit, mailer, clock }
 */
function createApp(deps) {
  const app = express();
  app.locals.deps = deps;
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustProxy);

  app.use(helmet());
  app.use(requestLog);

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  api.use(originGuard(deps));
  api.use(sessionMiddleware(deps));

  // Liveness for pm2 or uptime monitoring. It touches no records and returns no data,
  // so it is the one endpoint that does not write to the audit log.
  api.get('/health', async (_req, res) => {
    try {
      await deps.store.healthCheck();
      res.set('Cache-Control', 'no-store').json({ ok: true });
    } catch (err) {
      logger.error('health check failed', logger.errorFields(err));
      res.status(503).json({ ok: false });
    }
  });

  api.use('/auth', authRoutes());
  api.use('/admin', adminRoutes());
  api.use('/audit', auditRoutes());

  api.use((_req, res) => res.status(404).json({ error: 'not_found', message: 'Not found.' }));

  app.use('/api', api);
  app.use((_req, res) => res.status(404).json({ error: 'not_found', message: 'Not found.' }));

  // Last-resort error handler. Never echoes the request or the error message.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(err.status || 400).json({ error: 'invalid_body', message: 'The request body could not be read.' });
    }
    logger.error('unhandled error', { requestId: req.requestId, ...logger.errorFields(err) });
    return res.status(500).json({ error: 'internal_error', message: 'Something went wrong. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
