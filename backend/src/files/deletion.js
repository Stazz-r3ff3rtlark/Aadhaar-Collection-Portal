'use strict';

// Deleting Aadhaar files. The one place that removes them, so every path (replacing an
// upload, removing an employee, and later the retention job, manual deletion by
// hospitality and cancellations) deletes the same way.
//
// Which order:
//   - Whole-booking deletion (retention, "delete all") removes from disk FIRST, then
//     marks the rows. If the transaction then fails, the rows still say "present" and a
//     re-run finishes the job; a file can never outlive a row that says it was deleted.
//   - Removing a few files during a request (replace, employee removed) marks the rows and
//     removes from disk only after the change is saved, so a failed request loses nothing.
//     Anything a crash leaves behind sits in the booking's folder, which whole-booking
//     deletion removes in one go.

/**
 * Deletes every Aadhaar file of a booking, including anything left in its folder. The hook
 * for the nightly retention job (PRD A1, 02:00 IST the day after check-out), hospitality's
 * "delete all" (H6) and cancellations (CX4). Booking metadata and the audit log stay.
 *
 * Does not change employee statuses: the caller decides (manual deletion reverts to
 * pending unless the booking is completed; retention does not).
 *
 * @param tx        open transaction
 * @param fileStore src/files/file-store.js
 * @param options   { reason: 'retention' | 'manual' | 'cancellation', byUserId?: number, at: IST SQL string }
 * @returns { files, submissions } counts, for the caller's audit entry
 */
async function deleteBookingFiles(tx, fileStore, bookingId, { reason, byUserId = null, at }) {
  const files = await tx.files.listByBooking(bookingId);
  for (const file of files) await fileStore.remove(bookingId, file.storageKey);
  await fileStore.removeBooking(bookingId);
  await tx.files.markDeletedForBooking(bookingId, at);
  const submissions = await tx.submissions.markFilesDeletedForBooking(bookingId, at, reason, byUserId);
  return { files: files.length, submissions };
}

/** Marks these file rows deleted now, and removes them from disk once the request commits. */
async function discardFiles(ctx, bookingId, files, at) {
  if (!files.length) return 0;
  await ctx.tx.files.markDeleted(files.map((f) => f.id), at);
  ctx.afterCommit(async () => {
    for (const file of files) await ctx.deps.fileStore.remove(bookingId, file.storageKey);
  });
  return files.length;
}

/**
 * Before employees are deleted from a booking: drops everything hanging off them and
 * removes their files from disk once the request commits.
 * @returns number of files removed
 */
async function purgeEmployees(ctx, bookingId, employeeIds) {
  if (!employeeIds.length) return 0;
  const files = await ctx.tx.files.listByEmployees(employeeIds);
  await ctx.tx.employees.purgeRelated(employeeIds);
  ctx.afterCommit(async () => {
    for (const file of files) await ctx.deps.fileStore.remove(bookingId, file.storageKey);
  });
  return files.length;
}

module.exports = { deleteBookingFiles, discardFiles, purgeEmployees };
