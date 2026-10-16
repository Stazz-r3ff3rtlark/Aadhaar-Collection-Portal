'use strict';

const path = require('node:path');

const BACKEND_DIR = path.resolve(__dirname, '..');

// Only emails on this domain can ever be added or sign in. The domain alone never
// grants access: the address must also be on the admin-managed allow-list (users table).
const ALLOWED_EMAIL_DOMAIN = 'alembic.co.in';

function int(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) throw new Error(`Expected an integer, got "${value}"`);
  return n;
}

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  const config = {
    nodeEnv,
    isProduction,
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 17101),
    // The public origin the frontend is served from; state-changing API calls from
    // any other origin are rejected.
    appOrigin: env.APP_ORIGIN || 'http://localhost:5173',
    allowedEmailDomain: ALLOWED_EMAIL_DOMAIN,
    // nginx runs on the same machine, so only loopback proxies are trusted for X-Forwarded-For.
    trustProxy: env.TRUST_PROXY || 'loopback',
    db: {
      host: env.DB_HOST || '127.0.0.1',
      port: int(env.DB_PORT, 3306),
      user: env.DB_USER || 'aadhaar_app',
      password: env.DB_PASSWORD || '',
      database: env.DB_NAME || 'aadhaar_portal',
      connectionLimit: int(env.DB_POOL_SIZE, 10),
    },
    migrationDb: {
      user: env.DB_MIGRATION_USER || env.DB_USER || 'aadhaar_migrator',
      password: env.DB_MIGRATION_PASSWORD ?? env.DB_PASSWORD ?? '',
    },
    otpSecret: env.OTP_SECRET || (isProduction ? '' : 'dev-only-otp-secret-change-me-0000000000'),
    session: {
      cookieSecure: isProduction || env.COOKIE_SECURE === 'true',
      idleMinutes: int(env.SESSION_IDLE_MINUTES, 120),
      absoluteHours: int(env.SESSION_ABSOLUTE_HOURS, 12),
    },
    otp: {
      ttlMinutes: 10,
      maxAttempts: 5,
      cooldownSeconds: 60,
      maxPerHour: 5,
    },
    password: {
      minLength: 10,
      // bcrypt only reads the first 72 bytes; refuse longer input rather than truncate silently.
      maxBytes: 72,
      bcryptCost: int(env.BCRYPT_COST, 12),
      maxFailedAttempts: 5,
      lockMinutes: 15,
    },
    mail: {
      transport: env.MAIL_TRANSPORT || (isProduction ? 'smtp' : 'file'),
      from: env.MAIL_FROM || 'Aadhaar Collection Portal <support@alembic.co.in>',
      smtp: {
        host: env.SMTP_HOST || 'smtp.hostinger.com',
        port: int(env.SMTP_PORT, 465),
        user: env.SMTP_USER || 'support@alembic.co.in',
        password: env.SMTP_PASSWORD || '',
      },
    },
    // Private storage inside the backend directory. nginx never serves this path.
    storageDir: path.resolve(BACKEND_DIR, env.STORAGE_DIR || 'storage'),
  };

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  const problems = [];
  if (config.otpSecret.length < 32) problems.push('OTP_SECRET must be at least 32 characters');
  if (config.isProduction) {
    if (!config.db.password) problems.push('DB_PASSWORD is required in production');
    if (config.mail.transport !== 'smtp') problems.push('MAIL_TRANSPORT must be smtp in production');
    if (!config.mail.smtp.password) problems.push('SMTP_PASSWORD is required in production');
    if (!config.appOrigin.startsWith('https://')) problems.push('APP_ORIGIN must be https in production');
  }
  if (!['smtp', 'file', 'memory'].includes(config.mail.transport)) {
    problems.push(`Unknown MAIL_TRANSPORT "${config.mail.transport}"`);
  }
  if (problems.length) {
    throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  }
}

module.exports = { loadConfig, BACKEND_DIR, ALLOWED_EMAIL_DOMAIN };
