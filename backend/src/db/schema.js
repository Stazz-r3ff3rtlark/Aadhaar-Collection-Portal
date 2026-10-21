'use strict';

// Columns each repository may write, in camelCase. insert() and update() refuse any
// other key, so a request body can never reach an unexpected column.

const COLUMNS = {
  users: [
    'email', 'name', 'role', 'divisionId', 'passwordHash', 'passwordSetAt',
    'failedPasswordAttempts', 'lockedUntil', 'isActive', 'deactivatedAt', 'lastLoginAt',
    'createdByUserId', 'createdAt', 'updatedAt',
  ],
  divisions: ['name', 'archivedAt', 'createdAt', 'updatedAt'],
  hotels: [
    'name', 'city', 'reviewStatus', 'mergedIntoHotelId', 'defaultContacts', 'archivedAt',
    'createdByUserId', 'updatedByUserId', 'createdAt', 'updatedAt',
  ],
  bookings: [
    'divisionId', 'coordinatorUserId', 'hotelId', 'hotelName', 'eventName', 'location',
    'checkInDate', 'checkOutDate', 'deadlineAt', 'isShortNotice', 'status', 'statusChangedAt',
    'previousStatus', 'shareTokenHash', 'shareTokenVersion', 'finalisedAt', 'finalisedByUserId', 'cancelledAt',
    'cancelledByUserId', 'cancellationNote', 'filesDeletedAt', 'createdByUserId',
    'updatedByUserId', 'createdAt', 'updatedAt',
  ],
  booking_employees: [
    'bookingId', 'employeeCode', 'name', 'email', 'mobile', 'department', 'zone', 'hq',
    'isVacant', 'inviteStatus', 'inviteSentAt', 'inviteSentVia', 'openedAt', 'personalTokenHash',
    'submissionStatus', 'submittedAt', 'deadlineOverrideAt', 'verifiedAt', 'verifiedByType',
    'verifiedByUserId', 'cancelledAt', 'cancelledByUserId', 'cancellationNote',
    'cancellationCommunicatedAt', 'createdAt', 'updatedAt',
  ],
  employee_otp_codes: [
    'bookingEmployeeId', 'codeHash', 'attempts', 'requestIp', 'createdAt', 'expiresAt',
    'consumedAt', 'invalidatedAt',
  ],
  employee_sessions: [
    'tokenHash', 'bookingEmployeeId', 'ip', 'userAgent', 'createdAt', 'lastSeenAt', 'expiresAt', 'revokedAt',
  ],
  submissions: [
    'bookingEmployeeId', 'idType', 'cardType', 'consentAt', 'consentVersion', 'submittedAt',
    'supersededAt', 'filesDeletedAt', 'filesDeletedReason', 'filesDeletedByUserId', 'createdAt',
  ],
  submission_files: [
    'submissionId', 'bookingId', 'side', 'storageKey', 'mimeType', 'sizeBytes', 'pageCount',
    'createdAt', 'deletedAt',
  ],
  sessions: [
    'tokenHash', 'userId', 'authMethod', 'ip', 'userAgent', 'createdAt', 'lastSeenAt',
    'expiresAt', 'revokedAt', 'revokedReason',
  ],
  otp_codes: [
    'userId', 'purpose', 'codeHash', 'attempts', 'requestIp', 'createdAt', 'expiresAt',
    'consumedAt', 'invalidatedAt',
  ],
  audit_log: [
    'occurredAt', 'actorType', 'actorUserId', 'actorEmail', 'actorRole', 'actorLabel', 'action',
    'outcome', 'entityType', 'entityId', 'bookingId', 'ip', 'userAgent', 'requestId', 'details',
  ],
};

const BOOLEAN_COLUMNS = new Set(['isActive', 'isVacant', 'isShortNotice']);
const JSON_COLUMNS = new Set(['details', 'defaultContacts']);

const toSnake = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function pickColumns(table, fields) {
  const allowed = COLUMNS[table];
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) throw new Error(`Unknown column ${table}.${key}`);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

module.exports = { COLUMNS, BOOLEAN_COLUMNS, JSON_COLUMNS, toSnake, toCamel, pickColumns };
