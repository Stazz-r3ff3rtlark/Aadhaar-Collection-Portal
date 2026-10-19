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
 * @param options { method, body } for JSON, or { method, file, contentType } to upload raw bytes
 */
export async function api(path, { method = 'GET', body, file, contentType } = {}) {
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
    res = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers, body: payload });
  } catch {
    throw new ApiError(0, { message: 'Could not reach the server. Check your connection and try again.' });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A session ended mid-use (signed out, account changed): return to the sign-in screen.
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(res.status, data);
  }
  return data;
}
