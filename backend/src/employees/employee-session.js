'use strict';

const { randomToken, sha256Hex } = require('../lib/crypto');
const { toIstSql, addMinutes } = require('../lib/time');
const { parseCookies } = require('../http/session');

// Employee sessions: started when an employee confirms their emailed code on the booking
// link, limited to that one employee on that one booking, and short (30 minutes by
// default). Kept apart from staff sessions: a different cookie and table, and the
// employee routes never accept a staff session (or the other way round).

function cookieName(config) {
  return config.session.cookieSecure ? '__Host-acp_employee' : 'acp_employee';
}

function cookieOptions(config) {
  return { httpOnly: true, secure: config.session.cookieSecure, sameSite: 'lax', path: '/' };
}

async function startEmployeeSession(ctx, employee) {
  const { config, clock } = ctx.deps;
  const now = clock.now();
  const token = randomToken();
  const expires = addMinutes(now, config.employee.sessionMinutes);
  // One live session per employee: a new confirmation ends any older one.
  await ctx.tx.employeeSessions.revokeAllForEmployee(employee.id, toIstSql(now));
  const id = await ctx.tx.employeeSessions.insert({
    tokenHash: sha256Hex(token),
    bookingEmployeeId: employee.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent?.slice(0, 255) ?? null,
    createdAt: toIstSql(now),
    lastSeenAt: toIstSql(now),
    expiresAt: toIstSql(expires),
  });
  ctx.setCookie(cookieName(config), token, { ...cookieOptions(config), maxAge: expires - now });
  return id;
}

function clearEmployeeCookie(ctx) {
  ctx.clearCookie(cookieName(ctx.deps.config), cookieOptions(ctx.deps.config));
}

/**
 * Resolves the employee cookie to { employee, booking, session } on req.employeeAuth.
 * Valid only while not revoked or expired, and while the employee is still an active
 * traveller on the booking (not vacant, cancelled or removed).
 */
function employeeSessionMiddleware(deps) {
  const { config, clock, store } = deps;
  return async (req, _res, next) => {
    req.employeeAuth = null;
    const token = parseCookies(req.headers.cookie)[cookieName(config)];
    if (!token || token.length > 128) return next();
    try {
      req.employeeAuth = await store.transaction(async (tx) => {
        const session = await tx.employeeSessions.findByTokenHash(sha256Hex(token));
        const nowSql = toIstSql(clock.now());
        if (!session || session.revokedAt || session.expiresAt <= nowSql) return null;
        const employee = await tx.employees.findByIdOnly(session.bookingEmployeeId);
        if (!employee || employee.isVacant || employee.cancelledAt) return null;
        const booking = await tx.bookings.findById(employee.bookingId);
        if (!booking) return null;
        await tx.employeeSessions.update(session.id, { lastSeenAt: nowSql });
        return { employee, booking, session };
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { startEmployeeSession, clearEmployeeCookie, employeeSessionMiddleware, cookieName };
