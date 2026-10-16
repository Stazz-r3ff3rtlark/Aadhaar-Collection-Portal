'use strict';

const { randomToken, sha256Hex } = require('../lib/crypto');
const { toIstSql, fromIstSql, addMinutes } = require('../lib/time');

// Server-side sessions in a host-only, HttpOnly, SameSite=Lax cookie. The API and the
// frontend are same-site behind nginx, so no cross-site cookie handling is needed.

const TOUCH_INTERVAL_MS = 60 * 1000;

function cookieName(config) {
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure, host-only and Path=/.
  return config.session.cookieSecure ? '__Host-acp_session' : 'acp_session';
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key && !(key in out)) out[key] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieOptions(config) {
  return {
    httpOnly: true,
    secure: config.session.cookieSecure,
    sameSite: 'lax',
    path: '/',
  };
}

/** Creates a session row and queues the cookie on the route context (sent only after commit). */
async function startSession(ctx, user, authMethod) {
  const { config, clock } = ctx.deps;
  const now = clock.now();
  const token = randomToken();
  const expires = addMinutes(now, config.session.absoluteHours * 60);
  const sessionId = await ctx.tx.sessions.insert({
    tokenHash: sha256Hex(token),
    userId: user.id,
    authMethod,
    ip: ctx.ip,
    userAgent: ctx.userAgent?.slice(0, 255) ?? null,
    createdAt: toIstSql(now),
    lastSeenAt: toIstSql(now),
    expiresAt: toIstSql(expires),
  });
  ctx.setCookie(cookieName(config), token, { ...cookieOptions(config), maxAge: expires - now });
  return sessionId;
}

function clearSessionCookie(ctx) {
  ctx.clearCookie(cookieName(ctx.deps.config), cookieOptions(ctx.deps.config));
}

/**
 * Express middleware: resolves the session cookie to { user, session } on req.auth.
 * A session is valid only if it is not revoked, not past its absolute or idle expiry,
 * and its user is still active. Deactivating a user therefore ends their sessions
 * immediately, even before the revoke runs.
 */
function sessionMiddleware(deps) {
  const { config, clock, store, audit } = deps;
  return async (req, _res, next) => {
    req.auth = null;
    const token = parseCookies(req.headers.cookie)[cookieName(config)];
    if (!token || token.length > 128) return next();
    try {
      req.auth = await store.transaction(async (tx) => {
        const session = await tx.sessions.findByTokenHash(sha256Hex(token));
        if (!session || session.revokedAt) return null;
        const now = clock.now();
        const nowSql = toIstSql(now);
        if (session.expiresAt <= nowSql) return null;

        const idleDeadline = addMinutes(fromIstSql(session.lastSeenAt), config.session.idleMinutes);
        if (idleDeadline <= now) {
          await tx.sessions.update(session.id, { revokedAt: nowSql, revokedReason: 'idle_timeout' });
          await audit.record(tx, {
            actorType: 'system',
            actorLabel: 'session',
            action: 'auth.session.expire',
            outcome: 'success',
            entityType: 'session',
            entityId: String(session.id),
            ip: req.ip,
            requestId: req.requestId,
            details: { userId: session.userId, reason: 'idle_timeout' },
          });
          return null;
        }

        const user = await tx.users.findById(session.userId);
        if (!user || !user.isActive) return null;

        if (now - fromIstSql(session.lastSeenAt) > TOUCH_INTERVAL_MS) {
          await tx.sessions.update(session.id, { lastSeenAt: nowSql });
        }
        return { user, session };
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { sessionMiddleware, startSession, clearSessionCookie, cookieName, parseCookies };
