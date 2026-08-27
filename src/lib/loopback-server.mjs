// loopback-server.mjs — shared plumbing for every loopback-only HTTP server
// in this kit (dashboard-server.mjs, admin-server.mjs): token mint/compare,
// the listen/close lifecycle, and the standard JSON response shapes.
//
// Extracted from near-verbatim duplication across both servers (2026-08
// complexity audit, Finding 3): each server independently defined its own
// readJsonSafe, minted its own token the same way, wrote the same 401/404
// response headers, and repeated the same server.listen(...).then(resolve
// {url, urlWithToken, port, token, close}) boilerplate. dashboard-server.mjs
// also imported tokenMatches FROM admin-server.mjs — a security primitive
// with no business being homed in one specific server. Both servers now
// depend on this neutral module instead of on each other.
import crypto from 'node:crypto';
import fs from 'node:fs';

/** Read+parse a JSON file, or null on any failure (missing, malformed,
 *  unreadable). Was duplicated verbatim in dashboard-server.mjs and
 *  admin-server.mjs. */
export function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Mint a fresh per-session loopback auth token: 256-bit, URL-safe so it
 *  rides cleanly in a launch URL's `#` fragment (ADR-0007 §2, ADR-0014).
 *  Every loopback server in this kit mints one of these at startup — there
 *  is no unauthenticated mode. */
export function mintToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Constant-time token compare with a length guard. timingSafeEqual THROWS on
 *  unequal length, which is itself a length/timing oracle — the guard turns
 *  unequal length into a plain `false`. No secret ⇒ never open (fail-closed).
 *  Was homed in admin-server.mjs and imported from there by dashboard-server
 *  — a security primitive belongs in neither server specifically; both now
 *  import it from here (admin-server.mjs re-exports it for its existing
 *  callers/tests). */
export function tokenMatches(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** Write a JSON response with the standard no-store/nosniff headers every
 *  loopback API route in this kit uses. */
export function sendJson(res, status, payload) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

/** The standard 401 shape for a missing/wrong loopback token: JSON, no data
 *  fields (so a failed auth attempt can never fish for a payload shape),
 *  same headers as every other API response. */
export function sendUnauthorized(res, message) {
  sendJson(res, 401, { error: message });
}

/** The standard 404 for an unmatched route. */
export function sendNotFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

/**
 * Bind `server` to 127.0.0.1 — loopback ONLY, never expose a kit panel
 * beyond this machine — and resolve the standard shape every loopback
 * server in this kit returns. `close` is the caller's own close function
 * (dashboard's must also release SSE clients and background services;
 * admin's is a bare `server.close()`) — this owns only the listen/resolve
 * boilerplate around it, identical either way.
 * @param {import('node:http').Server} server
 * @param {{ port: number, token: string, close: () => Promise<void> }} opts
 * @returns {Promise<{ url: string, urlWithToken: string, port: number, token: string, close: () => Promise<void> }>}
 */
export function listenLoopback(server, { port, token, close }) {
  return new Promise((resolve, reject) => {
    server.on('error', reject); // EADDRINUSE bubbles to the caller
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = addr && typeof addr === 'object' ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}/`,
        urlWithToken: `http://127.0.0.1:${actual}/#token=${token}`,
        port: actual,
        token,
        close,
      });
    });
  });
}
