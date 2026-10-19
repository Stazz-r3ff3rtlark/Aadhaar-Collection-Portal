'use strict';

// Employee list rules (PRD B2 and "Vacant positions"):
//   - columns: name, employee code, email, mobile, department, zone, HQ, vacant
//   - every non-vacant row needs name, employee code, email and mobile (the OTP is emailed)
//   - vacant rows may leave name, email and mobile blank; vacant blank means "no"
//   - errors: duplicate employee codes, duplicate emails, bad email or mobile, missing
//     required values. Nothing is saved while any row has an error.
//
// The same validation runs for the import preview, the import itself, and single
// add / replace, so the rules cannot drift apart.

const COLUMNS = Object.freeze([
  { key: 'name', label: 'Name', aliases: ['name', 'employee name', 'full name'], max: 150 },
  { key: 'employeeCode', label: 'Employee code', aliases: ['employee code', 'emp code', 'employee id', 'emp id', 'code'], max: 50 },
  { key: 'email', label: 'Email', aliases: ['email', 'email id', 'e-mail', 'email address'], max: 254 },
  { key: 'mobile', label: 'Mobile', aliases: ['mobile', 'mobile number', 'mobile no', 'phone', 'phone number', 'contact number'], max: 20 },
  { key: 'department', label: 'Department', aliases: ['department', 'dept'], max: 100 },
  { key: 'zone', label: 'Zone', aliases: ['zone'], max: 100 },
  { key: 'hq', label: 'HQ', aliases: ['hq', 'headquarters', 'head quarters', 'head quarter'], max: 100 },
  { key: 'vacant', label: 'Vacant', aliases: ['vacant', 'is vacant'], max: 10 },
]);

const REQUIRED_COLUMNS = ['name', 'employeeCode', 'email', 'mobile'];
const MAX_ROWS = 2000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Header text -> column key, ignoring case, spacing, asterisks and anything in brackets. */
function columnForHeader(header) {
  const text = String(header ?? '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[*:]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, ' ');
  return COLUMNS.find((c) => c.aliases.includes(text))?.key ?? null;
}

const clean = (value) => (value == null ? '' : String(value).trim().replace(/\s+/g, ' '));

/** Indian mobile: 10 digits starting 6-9, optionally written with +91, 91 or 0 in front. */
function normaliseMobile(value) {
  let digits = value.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** 'yes'/'no'/blank (and y/n/true/false/1/0). Returns null if unreadable. */
function parseVacant(value) {
  if (typeof value === 'boolean') return value;
  const text = clean(value).toLowerCase();
  if (['', 'no', 'n', 'false', '0'].includes(text)) return false;
  if (['yes', 'y', 'true', '1'].includes(text)) return true;
  return null;
}

/**
 * Cleans one row and checks it on its own (not against other rows).
 * @param values { name, employeeCode, email, mobile, department, zone, hq, vacant | isVacant }
 */
function checkRow(values) {
  const errors = [];
  const row = {
    name: clean(values.name),
    employeeCode: clean(values.employeeCode),
    email: clean(values.email).toLowerCase(),
    mobile: clean(values.mobile),
    department: clean(values.department),
    zone: clean(values.zone),
    hq: clean(values.hq),
    isVacant: false,
  };

  const vacant = parseVacant(values.isVacant ?? values.vacant);
  if (vacant === null) errors.push('Vacant must be yes, no or blank.');
  row.isVacant = vacant === true;

  for (const column of COLUMNS) {
    if (column.key !== 'vacant' && row[column.key].length > column.max) {
      errors.push(`${column.label} is too long (at most ${column.max} characters).`);
    }
  }

  if (!row.isVacant) {
    if (!row.name) errors.push('Name is missing.');
    if (!row.employeeCode) errors.push('Employee code is missing.');
    if (!row.email) errors.push('Email is missing (needed for the sign-in code).');
    if (!row.mobile) errors.push('Mobile is missing.');
  }
  if (row.email && !EMAIL_PATTERN.test(row.email)) errors.push(`Email "${row.email}" is not a valid email address.`);
  if (row.mobile) {
    const mobile = normaliseMobile(row.mobile);
    if (mobile) row.mobile = mobile;
    else errors.push(`Mobile "${row.mobile}" is not a valid 10-digit Indian mobile number.`);
  }

  // Store blanks as NULL.
  for (const key of ['name', 'employeeCode', 'email', 'mobile', 'department', 'zone', 'hq']) {
    if (!row[key]) row[key] = null;
  }
  return { row, errors };
}

/**
 * Validates a list of rows together: each row on its own, then duplicate employee codes
 * and emails within the list and against employees already on the booking.
 *
 * @param inputs   [{ rowNumber?, ...values }]
 * @param existing employees already on the booking that the rows must not clash with
 * @returns { rows: [{ rowNumber, ...row, errors }], summary: { total, active, vacant, withErrors } }
 */
function validateRows(inputs, existing = []) {
  const rows = inputs.map((input, i) => {
    const { row, errors } = checkRow(input);
    return { rowNumber: input.rowNumber ?? i + 1, ...row, errors };
  });

  const markDuplicates = (key, label) => {
    const seen = new Map();
    for (const row of rows) {
      const value = row[key]?.toLowerCase();
      if (!value) continue;
      if (!seen.has(value)) seen.set(value, []);
      seen.get(value).push(row);
    }
    for (const [value, group] of seen) {
      if (group.length > 1) {
        for (const row of group) {
          const others = group.filter((r) => r !== row).map((r) => r.rowNumber).join(', ');
          row.errors.push(`Duplicate ${label} "${row[key]}" (also on row ${others}).`);
        }
      }
      const clash = existing.find((e) => e[key]?.toLowerCase() === value);
      if (clash) {
        for (const row of group) {
          row.errors.push(`${label[0].toUpperCase()}${label.slice(1)} "${row[key]}" is already on this booking (${clash.name || 'vacant position'}).`);
        }
      }
    }
  };
  markDuplicates('employeeCode', 'employee code');
  markDuplicates('email', 'email');

  const vacant = rows.filter((r) => r.isVacant).length;
  return {
    rows,
    summary: {
      total: rows.length,
      active: rows.length - vacant,
      vacant,
      withErrors: rows.filter((r) => r.errors.length).length,
    },
  };
}

module.exports = { COLUMNS, REQUIRED_COLUMNS, MAX_ROWS, columnForHeader, checkRow, validateRows, normaliseMobile, parseVacant };
