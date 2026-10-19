'use strict';

const { addDays, daysBetween, istToday } = require('../lib/time');

// PRD business rules:
//   Deadline: 23:59 IST on (check-in date minus 7 days); same date for Aadhaar and rooming list.
//   Short notice: created fewer than 7 days before check-in -> flagged, and hospitality
//   sets the deadline (so none is calculated).

const DEADLINE_DAYS = 7;

/** End of the deadline day: the whole 23:59 minute counts as on time. */
const END_OF_DAY = '23:59:59.999';

/**
 * @param checkInDate 'YYYY-MM-DD' (IST calendar date)
 * @param now         Date, the moment the booking is created or its check-in changes
 * @returns { deadlineAt: IST DATETIME string | null, isShortNotice: boolean }
 */
function computeDeadline(checkInDate, now) {
  const isShortNotice = daysBetween(istToday(now), checkInDate) < DEADLINE_DAYS;
  return {
    isShortNotice,
    deadlineAt: isShortNotice ? null : `${addDays(checkInDate, -DEADLINE_DAYS)} ${END_OF_DAY}`,
  };
}

module.exports = { computeDeadline, DEADLINE_DAYS };
