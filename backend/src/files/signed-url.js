'use strict';

const { hmacHex, safeEqualHex } = require('../lib/crypto');

// Short-lived signed links to one Aadhaar file (PRD: "delivered only through
// authenticated, short-lived signed links"). A link is bound to the file, to who asked for
// it and to an expiry, and is only honoured together with that person's session, so a
// copied link is useless to anyone else and stops working within minutes.
//
// nginx logs the path only ($uri), never the query string that carries the signature.

function signature(secret, fileId, viewer, expires) {
  return hmacHex(secret, `file:${fileId}:${viewer}:${expires}`);
}

/**
 * @param viewer 'user:<id>' or 'employee:<id>'
 * @returns relative URL under /api, e.g. /api/files/12?exp=...&sig=...
 */
function signFileUrl(config, base, fileId, viewer, now) {
  const expires = Math.floor(now.getTime() / 1000) + config.upload.signedUrlSeconds;
  return `${base}/${fileId}?exp=${expires}&sig=${signature(config.linkSecret, fileId, viewer, expires)}`;
}

/** 'ok' | 'expired' | 'invalid' */
function checkFileSignature(config, fileId, viewer, query, now) {
  const expires = Number(query.exp);
  const sig = typeof query.sig === 'string' ? query.sig : '';
  if (!Number.isInteger(expires) || !/^[0-9a-f]{64}$/.test(sig)) return 'invalid';
  if (!safeEqualHex(signature(config.linkSecret, fileId, viewer, expires), sig)) return 'invalid';
  return expires * 1000 < now.getTime() ? 'expired' : 'ok';
}

module.exports = { signFileUrl, checkFileSignature };
