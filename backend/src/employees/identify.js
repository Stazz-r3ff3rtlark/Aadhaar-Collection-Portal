'use strict';

const { randomOtp, hmacHex, safeEqualHex } = require('../lib/crypto');
const { toIstSql, fromIstSql, addMinutes, formatIstDateTime } = require('../lib/time');
const { startEmployeeSession } = require('./employee-session');

// Employee identification (PRD C1): the employee picks their name from the booking's
// list, and confirms with a six-digit code emailed to the address in the uploaded list.
// The code rules are the staff sign-in rules (config.otp): 10 minutes, 5 tries, once a
// minute, five an hour; plus a per-IP cap across all employees. Only an HMAC of the code
// is stored, and the code never reaches a log line or the audit log.

/** a***@alembic.co.in: first character of the mailbox, then the domain. */
function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!local || !domain) return '***';
  return `${local[0]}***@${domain}`;
}

function codeHash(config, employeeId, code) {
  return hmacHex(config.otpSecret, `employee:${employeeId}:${code}`);
}

/**
 * Emails a new code unless a limit applies.
 * @returns { status, body } for the route
 */
async function requestEmployeeCode(ctx, booking, employee) {
  const { config, clock, mailer } = ctx.deps;
  const now = clock.now();
  const maskedEmail = maskEmail(employee.email);

  const latest = await ctx.tx.employeeOtps.findLatest(employee.id);
  const waitSeconds = latest
    ? Math.ceil(config.otp.cooldownSeconds - (now - fromIstSql(latest.createdAt)) / 1000)
    : 0;
  const hourAgo = toIstSql(addMinutes(now, -60));
  const sentLastHour = await ctx.tx.employeeOtps.countSince(employee.id, hourAgo);
  const fromIp = ctx.ip ? await ctx.tx.employeeOtps.countFromIpSince(ctx.ip, hourAgo) : 0;

  let throttle = null;
  if (waitSeconds > 0) throttle = { reason: 'cooldown', message: `A code was sent a moment ago. You can ask for a new one in ${waitSeconds} seconds.` };
  else if (sentLastHour >= config.otp.maxPerHour) throttle = { reason: 'hourly_limit', message: 'Too many codes have been sent to your email in the last hour. Please try again later.' };
  else if (fromIp >= config.employee.maxCodesPerIpPerHour) throttle = { reason: 'ip_limit', message: 'Too many codes have been requested from this network. Please try again later.' };
  if (throttle) {
    ctx.audit.outcome = 'failure';
    ctx.audit.details.reason = throttle.reason;
    return { status: 429, body: { error: 'throttled', message: throttle.message, maskedEmail, retryInSeconds: Math.max(waitSeconds, 0) || null } };
  }

  await ctx.tx.employeeOtps.invalidateActive(employee.id, toIstSql(now));
  const code = randomOtp();
  const expires = addMinutes(now, config.otp.ttlMinutes);
  const otpId = await ctx.tx.employeeOtps.insert({
    bookingEmployeeId: employee.id,
    codeHash: codeHash(config, employee.id, code),
    requestIp: ctx.ip,
    createdAt: toIstSql(now),
    expiresAt: toIstSql(expires),
  });

  await mailer.send({
    to: employee.email,
    subject: 'Your code for the Aadhaar upload',
    text: [
      `Hi ${employee.name},`,
      '',
      `Your code to confirm your Aadhaar upload for ${booking.eventName} is ${code}`,
      '',
      `It expires at ${formatIstDateTime(expires)}. Do not share it with anyone.`,
      'If you did not ask for this code, you can ignore this email.',
      '',
      'Alembic Hospitality',
    ].join('\n'),
  });

  ctx.audit.details.otpId = otpId;
  return {
    status: 202,
    body: { ok: true, maskedEmail, message: `A code was sent to your registered email ${maskedEmail}.`, retryInSeconds: config.otp.cooldownSeconds },
  };
}

const WRONG_CODE = 'That code is not right. Check the latest email and try again.';
const EXPIRED = 'That code has expired or was already used. Ask for a new code.';
const EXHAUSTED = 'Too many wrong tries. Ask for a new code.';

/**
 * Checks the code; on success starts an employee session and marks the invitation opened.
 * A wrong code is answered (not thrown) so the attempt count is saved with the audit entry.
 */
async function verifyEmployeeCode(ctx, employee, rawCode) {
  const { config, clock } = ctx.deps;
  const now = clock.now();
  const nowSql = toIstSql(now);
  const fail = (reason, message, extra = {}) => {
    ctx.audit.outcome = 'failure';
    ctx.audit.details.reason = reason;
    Object.assign(ctx.audit.details, extra);
    return { status: 401, body: { error: 'invalid_code', message } };
  };

  const otp = await ctx.tx.employeeOtps.findLatestActive(employee.id, nowSql);
  if (!otp) {
    const latest = await ctx.tx.employeeOtps.findLatest(employee.id);
    if (!latest) return fail('no_code_requested', EXPIRED);
    if (latest.consumedAt) return fail('code_already_used', EXPIRED, { otpId: latest.id });
    if (latest.invalidatedAt && latest.attempts >= config.otp.maxAttempts) return fail('attempts_exhausted', EXHAUSTED, { otpId: latest.id });
    return fail(latest.expiresAt <= nowSql ? 'code_expired' : 'code_superseded', EXPIRED, { otpId: latest.id });
  }
  ctx.audit.details.otpId = otp.id;

  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  const matches = /^\d{6}$/.test(code) && safeEqualHex(codeHash(config, employee.id, code), otp.codeHash);
  if (!matches) {
    const attempts = otp.attempts + 1;
    const exhausted = attempts >= config.otp.maxAttempts;
    await ctx.tx.employeeOtps.update(otp.id, { attempts, invalidatedAt: exhausted ? nowSql : undefined });
    return fail(exhausted ? 'wrong_code_attempts_exhausted' : 'wrong_code', exhausted ? EXHAUSTED : WRONG_CODE, { attempts });
  }

  await ctx.tx.employeeOtps.update(otp.id, { consumedAt: nowSql });
  const sessionId = await startEmployeeSession(ctx, employee);
  const opened = employee.inviteStatus !== 'opened';
  await ctx.tx.employees.update(employee.id, {
    inviteStatus: 'opened',
    openedAt: employee.openedAt ?? nowSql,
    updatedAt: nowSql,
  });
  ctx.audit.employee = employee;
  ctx.audit.details.sessionId = sessionId;
  ctx.audit.details.firstOpen = opened;
  return { status: 200, body: { ok: true } };
}

module.exports = { maskEmail, requestEmployeeCode, verifyEmployeeCode };
