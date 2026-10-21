'use strict';

const { toIstSql, toIstIso } = require('../lib/time');
const { signFileUrl } = require('../files/signed-url');
const { discardFiles } = require('../files/deletion');

// One employee's Aadhaar submission (PRD C4, card rule):
//   - PVC card: front and back images, or one PDF covering the card;
//   - old vertical card: a front image, or one PDF.
// The employee chooses the card type and ticks consent; that starts a draft. Files fill
// the draft; once every required side is in, the draft becomes the submission on file,
// and any earlier one is replaced and its files deleted. Until then an earlier
// submission stays valid, so an abandoned replacement loses nothing.

const CARD_TYPES = Object.freeze({
  pvc: { label: 'PVC card', sides: ['front', 'back'] },
  old_vertical: { label: 'Old paper / vertical card', sides: ['front'] },
});

// Shown before the upload and stored by version with every submission (PRD, Consent).
const CONSENT_VERSION = 'v1';
function consentText(deletionDate) {
  return `I agree that Alembic's hospitality team, the sales coordinators of this booking and the hotel for this booking may see this copy of my Aadhaar, only to check me in at the hotel. It will be deleted after the trip${deletionDate ? ` (on ${deletionDate})` : ''}.`;
}

function isComplete(cardType, files) {
  const sides = new Set(files.map((f) => f.side));
  if (sides.has('document')) return true;
  return CARD_TYPES[cardType].sides.every((s) => sides.has(s));
}

/** Files to drop when a new file lands on a side: a PDF covers the whole card, an image clears the PDF. */
function displacedBy(side, files) {
  if (side === 'document') return files;
  return files.filter((f) => f.side === side || f.side === 'document');
}

function publicFile(ctx, file, viewer) {
  return {
    id: file.id,
    side: file.side,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    pageCount: file.pageCount,
    uploadedAt: toIstIso(file.createdAt),
    url: signFileUrl(ctx.deps.config, viewer.base, file.id, viewer.id, ctx.deps.clock.now()),
  };
}

/** What the employee page shows: the submission on file, and a replacement being filled in. */
async function submissionState(ctx, employee, viewer) {
  const describe = async (submission) => {
    if (!submission) return null;
    const files = await ctx.tx.files.listBySubmission(submission.id);
    return {
      id: submission.id,
      cardType: submission.cardType,
      submittedAt: toIstIso(submission.submittedAt),
      requiredSides: CARD_TYPES[submission.cardType].sides,
      files: files.map((f) => publicFile(ctx, f, viewer)),
    };
  };
  return {
    status: employee.submissionStatus,
    current: await describe(await ctx.tx.submissions.findCurrent(employee.id)),
    draft: await describe(await ctx.tx.submissions.findDraft(employee.id)),
  };
}

/** Starts a new draft with the chosen card type and consent, dropping any unfinished one. */
async function startDraft(ctx, employee, { cardType, consentAt }) {
  const nowSql = toIstSql(ctx.deps.clock.now());
  const old = await ctx.tx.submissions.findDraft(employee.id);
  if (old) {
    await discardFiles(ctx, employee.bookingId, await ctx.tx.files.listBySubmission(old.id), nowSql);
    await ctx.tx.submissions.update(old.id, { supersededAt: nowSql });
  }
  return ctx.tx.submissions.insert({
    bookingEmployeeId: employee.id,
    idType: 'aadhaar',
    cardType,
    consentAt,
    consentVersion: CONSENT_VERSION,
    createdAt: nowSql,
  });
}

/**
 * Makes the draft the submission on file once it is complete.
 * @returns { completed, replaced } replaced = an earlier submission was superseded
 */
async function completeIfReady(ctx, employee, draft) {
  const files = await ctx.tx.files.listBySubmission(draft.id);
  if (!isComplete(draft.cardType, files)) return { completed: false, replaced: false };
  const nowSql = toIstSql(ctx.deps.clock.now());
  const previous = await ctx.tx.submissions.findCurrent(employee.id);
  if (previous) {
    await discardFiles(ctx, employee.bookingId, await ctx.tx.files.listBySubmission(previous.id), nowSql);
    await ctx.tx.submissions.update(previous.id, { supersededAt: nowSql });
  }
  await ctx.tx.submissions.update(draft.id, { submittedAt: nowSql });
  await ctx.tx.employees.update(employee.id, { submissionStatus: 'submitted', submittedAt: nowSql, updatedAt: nowSql });
  return { completed: true, replaced: Boolean(previous), previousId: previous?.id ?? null };
}

module.exports = {
  CARD_TYPES, CONSENT_VERSION, consentText, isComplete, displacedBy, publicFile, submissionState, startDraft, completeIfReady,
};
