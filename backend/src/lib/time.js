'use strict';

// All times in this system are IST (Asia/Kolkata, UTC+05:30). India has no daylight
// saving, so a fixed offset is exact and we never depend on the server's timezone.
//
// Database DATETIME columns hold IST wall-clock time as 'YYYY-MM-DD HH:MM:SS.mmm'
// (the pool sets the session time_zone to '+05:30' and returns dates as strings).
// Values in that format sort and compare correctly as plain strings.

const IST_TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const pad = (n, width = 2) => String(n).padStart(width, '0');

function istParts(date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    ms: shifted.getUTCMilliseconds(),
  };
}

/** Date -> 'YYYY-MM-DD HH:MM:SS.mmm' in IST, for DATETIME(3) columns. */
function toIstSql(date) {
  const p = istParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(p.ms, 3)}`;
}

/** 'YYYY-MM-DD[ HH:MM:SS[.mmm]]' in IST -> Date. */
function fromIstSql(value) {
  if (value == null) return null;
  const [datePart, timePart = '00:00:00'] = String(value).trim().split(' ');
  return new Date(`${datePart}T${timePart}${IST_OFFSET}`);
}

/** Date or IST SQL string -> ISO 8601 with an explicit +05:30 offset, for API responses. */
function toIstIso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : fromIstSql(value);
  const p = istParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(p.ms, 3)}${IST_OFFSET}`;
}

/** DD/MM/YYYY in IST, for anything a person reads. */
function formatIstDate(value) {
  const date = value instanceof Date ? value : fromIstSql(value);
  const p = istParts(date);
  return `${pad(p.day)}/${pad(p.month)}/${p.year}`;
}

/** DD/MM/YYYY HH:MM IST, for anything a person reads. */
function formatIstDateTime(value) {
  const date = value instanceof Date ? value : fromIstSql(value);
  const p = istParts(date);
  return `${formatIstDate(date)} ${pad(p.hour)}:${pad(p.minute)} IST`;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

const systemClock = { now: () => new Date() };

module.exports = {
  IST_TIME_ZONE,
  IST_OFFSET,
  toIstSql,
  fromIstSql,
  toIstIso,
  formatIstDate,
  formatIstDateTime,
  addMinutes,
  systemClock,
};
