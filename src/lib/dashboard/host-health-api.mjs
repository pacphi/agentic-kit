import { sendJson } from '../loopback-server.mjs';
import { readMaintenanceJson } from './maintenance-security.mjs';

export const HOST_HEALTH_POST_ROUTES = new Set(['/api/host-health/local', '/api/host-health/connection']);
const HOSTS = ['claude', 'codex', 'opencode'];

/** The server enforces token + same-origin before entering this handler.
 * Only a fixed host and server-issued observation token are accepted; callers
 * cannot supply a command, prompt, model, project path, timeout, or environment. */
export async function handleHostHealthPost(url, req, res, read) {
  try {
    const body = await readMaintenanceJson(req, { maxBytes: 4096 });
    if (!body || Array.isArray(body) || typeof body !== 'object'
      || Object.keys(body).some(key => !['host', 'confirm', 'evidenceKey'].includes(key))
      || !HOSTS.includes(body.host)) {
      sendJson(res, 400, { error: 'Invalid host health request.' }); return;
    }
    if (url === '/api/host-health/local') {
      sendJson(res, 200, await read({ force: true })); return;
    }
    if (body.confirm !== true || typeof body.evidenceKey !== 'string' || !/^[a-f0-9]{64}$/.test(body.evidenceKey)) {
      sendJson(res, 400, { error: 'Confirm the connection check using fresh health evidence.' }); return;
    }
    if (typeof read.checkConnection !== 'function') {
      sendJson(res, 503, { error: 'Connection checks unavailable.' }); return;
    }
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    try {
      const report = await read.checkConnection({ ...body, signal: controller.signal });
      sendJson(res, 200, report);
    } finally { res.off('close', abort); }
  } catch (error) {
    const code = error.status ?? error.statusCode;
    const status = [400, 409, 413, 415].includes(code) ? code : 503;
    const message = status === 409 ? 'Health evidence changed or a check is already running. Refresh and try again.'
      : status === 415 ? 'Health requests must use application/json.'
        : status === 413 ? 'Health request is too large.' : status === 400 ? 'Invalid health request.' : 'Health check unavailable.';
    sendJson(res, status, { error: message });
  }
}
