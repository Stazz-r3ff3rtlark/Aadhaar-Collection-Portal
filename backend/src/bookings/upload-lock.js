'use strict';

const { toIstSql } = require('../lib/time');

// The one rule for "may this employee upload now?" (PRD business rules: Deadline,
// Extension, After deadline; CX3 for cancellations). Everything that accepts, reminds
// about or reports on employee uploads must use this function, so the rule cannot drift.
//
//   - Uploads are open only while the booking is Collecting. Draft bookings have not
//     started; Finalised and later are closed (hospitality reopens if needed).
//   - The employee's deadline is their own extension if hospitality set one, otherwise
//     the booking's deadline (23:59 IST on check-in minus 7 days, or the one hospitality
//     set for a short-notice booking).
//   - No deadline yet (short notice, not set by hospitality): closed until one is set.
//   - Vacant and cancelled rows never upload.

const MESSAGES = {
  booking_cancelled: 'This booking has been cancelled, so no Aadhaar upload is needed. If you think this is a mistake, contact your coordinator.',
  not_started: 'Aadhaar collection for this booking has not started yet. Please try again later or contact your coordinator.',
  closed: 'Aadhaar collection for this booking has closed. Please contact hospitality if you still need to submit.',
  no_deadline: 'Aadhaar collection for this booking is not open yet. Please contact hospitality.',
  deadline_passed: 'The deadline for this booking has passed, so uploads are closed. Please contact hospitality.',
  employee_cancelled: 'Your place on this booking has been cancelled, so no upload is needed. Contact hospitality if this is a mistake.',
  not_on_booking: 'This name is not on the booking. Contact your coordinator.',
};

/** The deadline that applies to this employee (IST SQL string), or null if none is set. */
function effectiveDeadline(booking, employee) {
  return employee?.deadlineOverrideAt || booking.deadlineAt || null;
}

/**
 * @param booking  booking row
 * @param employee booking_employees row, or null to check the booking as a whole
 * @param now      Date
 * @returns { open: boolean, reason: string | null, message: string | null, deadlineAt: string | null }
 */
function uploadWindow(booking, employee, now) {
  const deadlineAt = effectiveDeadline(booking, employee);
  const closed = (reason) => ({ open: false, reason, message: MESSAGES[reason], deadlineAt });

  if (booking.status === 'cancelled') return closed('booking_cancelled');
  if (booking.status === 'draft') return closed('not_started');
  if (booking.status !== 'collecting') return closed('closed');
  if (employee) {
    if (employee.isVacant || employee.bookingId !== booking.id) return closed('not_on_booking');
    if (employee.cancelledAt) return closed('employee_cancelled');
  }
  if (!deadlineAt) return closed('no_deadline');
  if (toIstSql(now) > deadlineAt) return closed('deadline_passed');
  return { open: true, reason: null, message: null, deadlineAt };
}

/**
 * The booking link page as a whole: open if the booking is open, or if its deadline has
 * passed (or is not set) but at least one active traveller has a personal extension
 * that is still running. Each employee is then checked with uploadWindow() on their own.
 * @param employees active travellers (employees.listActive)
 */
function bookingWindow(booking, employees, now) {
  const window = uploadWindow(booking, null, now);
  if (window.open || !['deadline_passed', 'no_deadline'].includes(window.reason)) return window;
  const extended = employees.some((e) => e.deadlineOverrideAt && uploadWindow(booking, e, now).open);
  return extended ? { open: true, reason: null, message: null, deadlineAt: window.deadlineAt } : window;
}

module.exports = { uploadWindow, bookingWindow, effectiveDeadline, UPLOAD_LOCK_MESSAGES: MESSAGES };
