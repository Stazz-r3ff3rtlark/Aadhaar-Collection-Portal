'use strict';

// Role-based access rules for internal users, from the PRD roles table.
//
// Employees (sales staff travelling on a booking) and hotels never have accounts: they
// use tokenised links, which are authorised separately in later stages.
//
// Two layers:
//   1. can(user, permission): what a role may do at all.
//   2. Resource checks (canViewBooking, canViewAadhaar, ...): division scoping and
//      booking-status rules for coordinators.
// Everything not listed is denied.

const ROLES = Object.freeze({
  ADMIN: 'admin',
  HOSPITALITY: 'hospitality',
  COORDINATOR: 'coordinator',
  ANALYTICS_VIEWER: 'analytics_viewer',
});

const ALL_ROLES = Object.freeze(Object.values(ROLES));

const { ADMIN, HOSPITALITY, COORDINATOR, ANALYTICS_VIEWER } = ROLES;

const PERMISSIONS = Object.freeze({
  // Admin console (master data). Admins never see Aadhaar files.
  'users.manage': [ADMIN],
  'divisions.manage': [ADMIN],
  'hotels.manage': [ADMIN],
  'settings.manage': [ADMIN],
  'audit.read': [ADMIN],

  // Bookings. Coordinators are further limited to their division (see below).
  'bookings.create': [COORDINATOR],
  'bookings.read': [COORDINATOR, HOSPITALITY],
  'bookings.edit': [COORDINATOR, HOSPITALITY],
  'bookings.finalise': [COORDINATOR],
  'bookings.history.read': [ADMIN, HOSPITALITY],

  // Hospitality-only powers.
  'bookings.reopen': [HOSPITALITY],
  'deadlines.extend': [HOSPITALITY],
  'guests.cancel': [HOSPITALITY],
  'emergency_contacts.manage': [HOSPITALITY],
  'hotel_links.manage': [HOSPITALITY],
  'files.delete': [HOSPITALITY],
  'guests.verify': [HOSPITALITY],

  // Aadhaar images. Coordinators only before finalise, and only in their division.
  'aadhaar.view': [COORDINATOR, HOSPITALITY],

  // Segment-level analytics only; no individual employees and no Aadhaar data.
  'analytics.read': [ADMIN, ANALYTICS_VIEWER],
});

/** Statuses in which a coordinator still owns and can edit the booking. */
const COORDINATOR_EDITABLE_STATUSES = new Set(['draft', 'collecting']);

function isActiveUser(user) {
  return Boolean(user && user.isActive && ALL_ROLES.includes(user.role));
}

function can(user, permission) {
  const roles = PERMISSIONS[permission];
  if (!roles) throw new Error(`Unknown permission "${permission}"`);
  return isActiveUser(user) && roles.includes(user.role);
}

function inOwnDivision(user, booking) {
  return user.role === COORDINATOR && user.divisionId != null && booking.divisionId === user.divisionId;
}

function canViewBooking(user, booking) {
  if (!can(user, 'bookings.read')) return false;
  return user.role === HOSPITALITY || inOwnDivision(user, booking);
}

/** F2: after finalise the booking is read-only for the coordinator; hospitality can always edit. */
function canEditBooking(user, booking) {
  if (!can(user, 'bookings.edit')) return false;
  if (user.role === HOSPITALITY) return true;
  return inOwnDivision(user, booking) && COORDINATOR_EDITABLE_STATUSES.has(booking.status);
}

function canFinaliseBooking(user, booking) {
  return can(user, 'bookings.finalise') && inOwnDivision(user, booking) && COORDINATOR_EDITABLE_STATUSES.has(booking.status);
}

/** Coordinators lose image access once a booking is finalised; admins and analytics never have it. */
function canViewAadhaar(user, booking) {
  if (!can(user, 'aadhaar.view')) return false;
  if (booking.status === 'files_deleted') return false;
  if (user.role === HOSPITALITY) return true;
  return inOwnDivision(user, booking) && COORDINATOR_EDITABLE_STATUSES.has(booking.status);
}

module.exports = {
  ROLES,
  ALL_ROLES,
  PERMISSIONS,
  can,
  canViewBooking,
  canEditBooking,
  canFinaliseBooking,
  canViewAadhaar,
};
