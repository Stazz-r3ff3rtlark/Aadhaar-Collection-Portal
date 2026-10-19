'use strict';

/**
 * An error whose status and message are safe to return to the client.
 * auditOutcome overrides how the failed attempt is recorded ('failure' or 'denied'),
 * e.g. a 404 that hides another division's booking is still a denied access.
 */
class HttpError extends Error {
  constructor(status, code, message, { auditOutcome } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.auditOutcome = auditOutcome;
  }
}

const badRequest = (code, message) => new HttpError(400, code, message);
const unauthorized = (code = 'unauthenticated', message = 'Please sign in.') => new HttpError(401, code, message);
const forbidden = (code = 'forbidden', message = 'You do not have access to this.') => new HttpError(403, code, message);
const notFound = (code = 'not_found', message = 'Not found.', options) => new HttpError(404, code, message, options);
const conflict = (code, message) => new HttpError(409, code, message);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
