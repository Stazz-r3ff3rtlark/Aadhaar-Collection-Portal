'use strict';

const bcrypt = require('bcryptjs');
const { randomOtp, hmacHex, safeEqualHex } = require('../lib/crypto');
const { toIstSql, toIstIso, addMinutes, formatIstDateTime } = require('../lib/time');
const { badRequest } = require('../lib/errors');
const { startSession } = require('../http/session');

// Internal sign-in (PRD, "Sign-in for internal users"):
//   - only an @alembic.co.in email an admin has added (users table) and is active,
//   - by emailed one-time code or by password,
//   - passwords: bcrypt, at least 10 characters, 15-minute lock after 5 failures,
//     reset through an emailed code.
//
// Responses never reveal whether an email is on the allow-list. The audit entry
// records the real reason.
//
// All functions take the route context (ctx.tx is the open transaction).

// One neutral answer for every email: registered, unknown, deactivated or another domain.
const GENERIC_CODE_SENT = { ok: true, message: 'If this email is registered, a code has been sent.' };
const INVALID_CODE = { error: 'invalid_code', message: 'That code is not valid or has expired.' };
const INVALID_LOGIN = { error: 'invalid_credentials', message: 'Incorrect email or password.' };

const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

// Compared against when the user does not exist, so timing does not reveal the allow-list.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 4);

function normaliseEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Throws 400 unless the email is well-formed. */
function requireEmailFormat(email) {
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw badRequest('invalid_email', 'Enter a valid email address.');
  }
}

/** Throws 400 unless the email is well-formed and on the company domain (admin console). */
function requireCompanyEmail(ctx, email) {
  requireEmailFormat(email);
  const domain = ctx.deps.config.allowedEmailDomain;
  if (!email.endsWith(`@${domain}`)) {
    throw badRequest('email_domain_not_allowed', `Use your @${domain} email address.`);
  }
}

function validatePassword(config, password) {
  if (typeof password !== 'string' || password.length < config.password.minLength) {
    throw badRequest('weak_password', `Password must be at least ${config.password.minLength} characters.`);
  }
  if (Buffer.byteLength(password, 'utf8') > config.password.maxBytes) {
    throw badRequest('password_too_long', `Password must be at most ${config.password.maxBytes} characters.`);
  }
}

function otpHash(config, userId, purpose, code) {
  return hmacHex(config.otpSecret, `${userId}:${purpose}:${code}`);
}

/** Looks up an allow-listed, active user. Records the reason on the audit entry if not found. */
async function findAllowedUser(ctx, email) {
  ctx.audit.details.claimedEmail = email;
  // Other domains get the same neutral answer as unknown emails; only the audit log knows.
  if (!email.endsWith(`@${ctx.deps.config.allowedEmailDomain}`)) {
    ctx.audit.outcome = 'failure';
    ctx.audit.details.reason = 'email_domain_not_allowed';
    return null;
  }
  const user = await ctx.tx.users.findByEmail(email);
  if (!user) {
    ctx.audit.outcome = 'failure';
    ctx.audit.details.reason = 'not_on_allow_list';
    return null;
  }
  ctx.audit.entityType = 'user';
  ctx.audit.entityId = user.id;
  if (!user.isActive) {
    ctx.audit.outcome = 'failure';
    ctx.audit.details.reason = 'user_inactive';
    return null;
  }
  return user;
}

const OTP_EMAIL = {
  login: {
    subject: 'Your sign-in code',
    intro: 'Your sign-in code for the Aadhaar Collection Portal is',
  },
  password_reset: {
    subject: 'Your password reset code',
    intro: 'Your password reset code for the Aadhaar Collection Portal is',
  },
};

/** Issues and emails a one-time code. Always resolves to the same generic response. */
async function requestCode(ctx, rawEmail, purpose) {
  const { config, clock, mailer } = ctx.deps;
  const email = normaliseEmail(rawEmail);
  requireEmailFormat(email);
  ctx.audit.details.purpose = purpose;

  const user = await findAllowedUser(ctx, email);
  if (!user) return { status: 202, body: GENERIC_CODE_SENT };

  const now = clock.now();
  const latest = await ctx.tx.otps.findLatest(user.id, purpose);
  const cooldownStart = toIstSql(new Date(now.getTime() - config.otp.cooldownSeconds * 1000));
  const sentLastHour = await ctx.tx.otps.countCreatedSince(user.id, purpose, toIstSql(addMinutes(now, -60)));
  if ((latest && latest.createdAt > cooldownStart) || sentLastHour >= config.otp.maxPerHour) {
    ctx.audit.outcome = 'failure';
    ctx.audit.details.reason = 'throttled';
    return { status: 202, body: GENERIC_CODE_SENT };
  }

  await ctx.tx.otps.invalidateActive(user.id, purpose, toIstSql(now));
  const code = randomOtp();
  const expires = addMinutes(now, config.otp.ttlMinutes);
  const otpId = await ctx.tx.otps.insert({
    userId: user.id,
    purpose,
    codeHash: otpHash(config, user.id, purpose, code),
    requestIp: ctx.ip,
    createdAt: toIstSql(now),
    expiresAt: toIstSql(expires),
  });

  const copy = OTP_EMAIL[purpose];
  await mailer.send({
    to: user.email,
    subject: copy.subject,
    text: [
      `Hi ${user.name},`,
      '',
      `${copy.intro} ${code}`,
      '',
      `It expires at ${formatIstDateTime(expires)}. Do not share it with anyone.`,
      'If you did not ask for this code, you can ignore this email.',
      '',
      'Alembic Hospitality',
    ].join('\n'),
  });

  ctx.audit.details.otpId = otpId;
  return { status: 202, body: GENERIC_CODE_SENT };
}

/**
 * Checks a code for the user. Returns true and consumes it on success; otherwise counts
 * the attempt and invalidates the code after too many tries.
 */
async function consumeCode(ctx, user, purpose, rawCode) {
  const { config, clock } = ctx.deps;
  const nowSql = toIstSql(clock.now());
  const otp = await ctx.tx.otps.findLatestActive(user.id, purpose, nowSql);
  if (!otp) {
    ctx.audit.outcome = 'failure';
    ctx.audit.details.reason = 'no_active_code';
    return false;
  }
  ctx.audit.details.otpId = otp.id;
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  const matches = /^\d{6}$/.test(code) && safeEqualHex(otpHash(config, user.id, purpose, code), otp.codeHash);
  if (!matches) {
    const attempts = otp.attempts + 1;
    const exhausted = attempts >= config.otp.maxAttempts;
    await ctx.tx.otps.update(otp.id, { attempts, invalidatedAt: exhausted ? nowSql : undefined });
    ctx.audit.outcome = 'failure';
    ctx.audit.details.reason = exhausted ? 'wrong_code_attempts_exhausted' : 'wrong_code';
    ctx.audit.details.attempts = attempts;
    return false;
  }
  await ctx.tx.otps.update(otp.id, { consumedAt: nowSql });
  return true;
}

async function completeSignIn(ctx, user, method) {
  const nowSql = toIstSql(ctx.deps.clock.now());
  const sessionId = await startSession(ctx, user, method);
  await ctx.tx.users.update(user.id, { lastLoginAt: nowSql, updatedAt: nowSql });
  ctx.audit.actor = user;
  ctx.audit.details.method = method;
  ctx.audit.details.sessionId = sessionId;
  return { status: 200, body: { user: publicUser({ ...user, lastLoginAt: nowSql }) } };
}

async function signInWithCode(ctx, rawEmail, code) {
  const email = normaliseEmail(rawEmail);
  requireEmailFormat(email);
  const user = await findAllowedUser(ctx, email);
  if (!user || !(await consumeCode(ctx, user, 'login', code))) {
    return { status: 401, body: INVALID_CODE };
  }
  return completeSignIn(ctx, user, 'otp');
}

async function signInWithPassword(ctx, rawEmail, password) {
  const { config, clock } = ctx.deps;
  const email = normaliseEmail(rawEmail);
  requireEmailFormat(email);
  if (typeof password !== 'string' || !password) throw badRequest('password_required', 'Enter your password.');

  const user = await findAllowedUser(ctx, email);
  if (!user || !user.passwordHash) {
    await bcrypt.compare(password, DUMMY_HASH);
    if (user) {
      ctx.audit.outcome = 'failure';
      ctx.audit.details.reason = 'no_password_set';
    }
    return { status: 401, body: INVALID_LOGIN };
  }

  const now = clock.now();
  const nowSql = toIstSql(now);
  if (user.lockedUntil && user.lockedUntil > nowSql) {
    ctx.audit.outcome = 'denied';
    ctx.audit.details.reason = 'locked';
    return {
      status: 429,
      body: { error: 'locked', message: 'Too many attempts. Try again in 15 minutes, or sign in with an emailed code.' },
    };
  }

  if (!(await bcrypt.compare(password, user.passwordHash))) {
    const attempts = user.failedPasswordAttempts + 1;
    ctx.audit.outcome = 'failure';
    ctx.audit.details.attempts = attempts;
    if (attempts >= config.password.maxFailedAttempts) {
      const lockedUntil = toIstSql(addMinutes(now, config.password.lockMinutes));
      await ctx.tx.users.update(user.id, { failedPasswordAttempts: 0, lockedUntil, updatedAt: nowSql });
      ctx.audit.details.reason = 'wrong_password_locked';
      ctx.audit.details.lockedUntil = lockedUntil;
      return {
        status: 429,
        body: { error: 'locked', message: 'Too many attempts. Try again in 15 minutes, or sign in with an emailed code.' },
      };
    }
    await ctx.tx.users.update(user.id, { failedPasswordAttempts: attempts, updatedAt: nowSql });
    ctx.audit.details.reason = 'wrong_password';
    return { status: 401, body: INVALID_LOGIN };
  }

  await ctx.tx.users.update(user.id, { failedPasswordAttempts: 0, lockedUntil: null, updatedAt: nowSql });
  return completeSignIn(ctx, user, 'password');
}

/** Sets a new password with an emailed reset code. Works for first-time set-up too. Ends all sessions. */
async function resetPassword(ctx, rawEmail, code, newPassword) {
  const { config, clock } = ctx.deps;
  const email = normaliseEmail(rawEmail);
  requireEmailFormat(email);
  validatePassword(config, newPassword);

  const user = await findAllowedUser(ctx, email);
  if (!user || !(await consumeCode(ctx, user, 'password_reset', code))) {
    return { status: 401, body: INVALID_CODE };
  }

  const nowSql = toIstSql(clock.now());
  await ctx.tx.users.update(user.id, {
    passwordHash: await bcrypt.hash(newPassword, config.password.bcryptCost),
    passwordSetAt: nowSql,
    failedPasswordAttempts: 0,
    lockedUntil: null,
    updatedAt: nowSql,
  });
  const revoked = await ctx.tx.sessions.revokeAllForUser(user.id, nowSql, 'password_reset');
  ctx.audit.actor = user;
  ctx.audit.details.sessionsRevoked = revoked;
  return { status: 200, body: { ok: true, message: 'Password updated. Sign in with your new password.' } };
}

/** The user fields the API returns. Never includes hashes or lock counters. */
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    divisionId: user.divisionId ?? null,
    divisionName: user.divisionName ?? null,
    isActive: Boolean(user.isActive),
    hasPassword: Boolean(user.passwordHash),
    lastLoginAt: toIstIso(user.lastLoginAt),
    createdAt: toIstIso(user.createdAt),
  };
}

module.exports = {
  normaliseEmail,
  requireEmailFormat,
  requireCompanyEmail,
  validatePassword,
  requestCode,
  signInWithCode,
  signInWithPassword,
  resetPassword,
  publicUser,
};
