'use strict';

const { sanitize } = require('./sanitize');
const { toIstIso } = require('./time');

// JSON-lines logger for pm2. Rule: log IDs, statuses and counts only. Never pass
// request bodies, file data, OTPs, tokens or Aadhaar content; every field goes
// through sanitize() as a second line of defence.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function currentLevel() {
  return LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
}

function write(level, msg, fields) {
  if (LEVELS[level] < currentLevel()) return;
  const line = JSON.stringify({ time: toIstIso(new Date()), level, msg, ...sanitize(fields || {}) });
  (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
}

/**
 * Error fields safe to log. Error messages are dropped on purpose: driver and parser
 * messages can echo SQL parameters or request bodies. Only the name, code and stack
 * frames are kept.
 */
function errorFields(err) {
  if (!err) return {};
  const frames = typeof err.stack === 'string'
    ? err.stack.split('\n').slice(1, 11).map((line) => line.trim())
    : undefined;
  return {
    errName: err.name,
    errCode: err.code,
    sqlState: err.sqlState,
    stack: frames,
  };
}

module.exports = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
  errorFields,
};
