'use strict';

const { HttpError, badRequest } = require('../lib/errors');
const { ROLES, canEditBooking } = require('../auth/policy');

// Booking status model (PRD B4): Draft -> Collecting -> Finalised -> With hospitality ->
// Shared with hotel -> Completed -> Files deleted; Cancelled possible at any point.
//
// Each action lists the statuses it starts from, who may take it, and, for steps that
// depend on features from later stages, why it is not available yet. The table is the
// single source of truth: the API applies it and the UI shows its buttons from it.

const STATUSES = Object.freeze([
  'draft', 'collecting', 'finalised', 'with_hospitality', 'shared_with_hotel', 'completed', 'files_deleted', 'cancelled',
]);

const STATUS_LABELS = Object.freeze({
  draft: 'Draft',
  collecting: 'Collecting',
  finalised: 'Finalised',
  with_hospitality: 'With hospitality',
  shared_with_hotel: 'Shared with hotel',
  completed: 'Completed',
  files_deleted: 'Files deleted',
  cancelled: 'Cancelled',
});

// who: 'editor'      -> anyone who may edit the booking (coordinators of its division
//                       before finalise, hospitality at any time)
//      'coordinator' -> coordinators of its division
//      'hospitality' -> hospitality only
//      'system'      -> scheduled jobs only, never a person
const ACTIONS = Object.freeze({
  start_collecting: {
    label: 'Start collecting', from: ['draft'], to: 'collecting', who: 'editor',
  },
  finalise: {
    label: 'Finalise', from: ['collecting'], to: 'finalised', who: 'coordinator',
    laterStage: 'Finalising needs the six-item checklist, which comes in a later stage.',
  },
  hand_to_hospitality: {
    label: 'Take over', from: ['finalised'], to: 'with_hospitality', who: 'hospitality',
    laterStage: 'The hospitality hand-over comes with the checklist in a later stage.',
  },
  share_with_hotel: {
    label: 'Share with hotel', from: ['with_hospitality'], to: 'shared_with_hotel', who: 'hospitality',
    laterStage: 'Sharing with the hotel needs the hotel link, which comes in a later stage.',
  },
  complete: {
    label: 'Complete', from: ['shared_with_hotel'], to: 'completed', who: 'hospitality',
    laterStage: 'Completing needs emergency contacts, which come in a later stage.',
  },
  delete_files: {
    label: 'Delete files', from: ['completed'], to: 'files_deleted', who: 'system',
    laterStage: 'Files are deleted by the retention job, which comes in a later stage.',
  },
  reopen: {
    label: 'Reopen', from: ['finalised', 'with_hospitality', 'shared_with_hotel'], to: 'collecting', who: 'hospitality',
  },
  cancel: {
    label: 'Cancel booking',
    from: ['draft', 'collecting', 'finalised', 'with_hospitality', 'shared_with_hotel', 'completed'],
    to: 'cancelled',
    who: 'editor',
    noteRequired: true,
  },
  restore: {
    label: 'Restore booking', from: ['cancelled'], to: (booking) => booking.previousStatus || 'draft', who: 'hospitality',
  },
});

function mayTake(user, booking, action) {
  switch (action.who) {
    case 'editor': return canEditBooking(user, booking);
    case 'coordinator': return user.role === ROLES.COORDINATOR && canEditBooking(user, booking);
    case 'hospitality': return user.role === ROLES.HOSPITALITY && user.isActive;
    default: return false;
  }
}

/** Actions this user could take on the booking now, with availability, for the UI. */
function availableActions(user, booking) {
  return Object.entries(ACTIONS)
    .filter(([, a]) => a.from.includes(booking.status) && mayTake(user, booking, a))
    .map(([key, a]) => ({
      action: key,
      label: a.label,
      available: !a.laterStage,
      reason: a.laterStage ?? null,
      noteRequired: Boolean(a.noteRequired),
    }));
}

/**
 * Validates an action and returns { from, to }. Throws a client error explaining why
 * when the action is unknown, not allowed from this status or for this person, or not
 * built yet.
 */
function planTransition(user, booking, actionKey, { note } = {}) {
  const action = ACTIONS[actionKey];
  if (!action) throw badRequest('invalid_action', 'Unknown booking action.');
  if (!action.from.includes(booking.status)) {
    throw new HttpError(409, 'invalid_transition',
      `A booking that is ${STATUS_LABELS[booking.status]} cannot be changed with "${action.label}".`);
  }
  if (!mayTake(user, booking, action)) {
    throw new HttpError(403, 'forbidden', `You cannot "${action.label}" on this booking.`);
  }
  if (action.laterStage) throw new HttpError(409, 'not_available_yet', action.laterStage);
  const cleanNote = typeof note === 'string' ? note.trim() : '';
  if (action.noteRequired && !cleanNote) throw badRequest('note_required', 'Add a short note explaining why.');
  if (cleanNote.length > 500) throw badRequest('note_too_long', 'The note can be at most 500 characters.');
  const to = typeof action.to === 'function' ? action.to(booking) : action.to;
  return { from: booking.status, to, note: cleanNote || null };
}

module.exports = { STATUSES, STATUS_LABELS, ACTIONS, availableActions, planTransition };
