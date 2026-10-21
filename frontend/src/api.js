// All API calls go to the relative path /api (same site as the frontend; see CLAUDE.md).
// Never hardcode a host or port here.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || 'Something went wrong. Please try again.');
    this.status = status;
    this.code = body?.error;
    this.body = body;
  }
}

/**
 * @param path    API path after /api
 * @param options { method, body } for JSON, or { method, file, contentType } to upload raw bytes;
 *                headers adds request headers (the employee page sends its link token this way)
 */
export async function api(path, { method = 'GET', body, file, contentType, headers: extraHeaders } = {}) {
  let headers = {};
  let payload;
  if (file) {
    headers = { 'Content-Type': contentType || 'application/octet-stream' };
    payload = file;
  } else if (body) {
    headers = { 'Content-Type': 'application/json' };
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { ...headers, ...extraHeaders }, body: payload });
  } catch {
    throw new ApiError(0, { message: 'Could not reach the server. Check your connection and try again.' });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A session ended mid-use (signed out, account changed): return to the sign-in screen.
    // Employee pages (/e/) handle their own sessions.
    if (res.status === 401 && !path.startsWith('/auth/') && !path.startsWith('/e/')) window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(res.status, data);
  }
  return data;
}
