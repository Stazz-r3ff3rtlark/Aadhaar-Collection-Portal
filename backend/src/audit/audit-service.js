'use strict';

const { sanitize } = require('../lib/sanitize');
const { toIstSql } = require('../lib/time');

// The audit log answers "who did what, to which record, when (IST), from where".
// CLAUDE.md rule 3: every create, read of Aadhaar or personal data, update, delete,
// extension, reopen, cancellation, login, OTP, download, hotel access and admin change
// writes an entry. HTTP routes get this automatically from defineRoute(); jobs and CLI
// scripts call record() directly.

const ACTOR_TYPES = new Set(['user', 'employee', 'hotel', 'system', 'anonymous']);
const OUTCOMES = new Set(['success', 'failure', 'denied']);
const ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

const clip = (value, max) => (value == null ? null : String(value).slice(0, max));

function createAuditService({ clock }) {
  function normalise(entry) {
    if (!ACTION_PATTERN.test(entry.action || '')) throw new Error(`Invalid audit action "${entry.action}"`);
    if (!ACTOR_TYPES.has(entry.actorType)) throw new Error(`Invalid audit actorType "${entry.actorType}"`);
    if (!OUTCOMES.has(entry.outcome)) throw new Error(`Invalid audit outcome "${entry.outcome}"`);
    const details = entry.details && Object.keys(entry.details).length ? sanitize(entry.details) : null;
    return {
      occurredAt: toIstSql(clock.now()),
      actorType: entry.actorType,
      actorUserId: entry.actorUserId ?? null,
      actorEmail: clip(entry.actorEmail, 254),
      actorRole: clip(entry.actorRole, 30),
      actorLabel: clip(entry.actorLabel, 200),
      action: entry.action,
      outcome: entry.outcome,
      entityType: clip(entry.entityType, 40),
      entityId: entry.entityId == null ? null : clip(entry.entityId, 64),
      bookingId: entry.bookingId ?? null,
      ip: clip(entry.ip, 45),
      userAgent: clip(entry.userAgent, 255),
      requestId: clip(entry.requestId, 36),
      details,
    };
  }

  return {
    /** Writes one entry inside the caller's transaction, so it commits or rolls back with the action. */
    async record(tx, entry) {
      const row = normalise(entry);
      row.id = await tx.audit.insert(row);
      return row;
    },
  };
}

/** Actor fields for an internal user. */
function userActor(user) {
  return { actorType: 'user', actorUserId: user.id, actorEmail: user.email, actorRole: user.role };
}

module.exports = { createAuditService, userActor };
