// x dashboard — a read-only local web dashboard for the kit's health.
//
// Boots a loopback-only HTTP server (127.0.0.1) that serves a single
// self-contained page plus a /api/status JSON endpoint mirroring
// `ak status --json` (plus version drift, improvement.json, and the health
// ring). Runs FOREGROUND and blocks until Ctrl-C; nothing is detached and
// nothing mutates state.
import { spawn } from 'node:child_process';
import { startDashboard } from '../../lib/dashboard-server.mjs';
import { ok, info, dim, warn } from '../../lib/output.mjs';

export const options = {
  port: { type: 'string' },
  'no-open': { type: 'boolean', default: false },
};

export const help = `ak dashboard — read-only local health dashboard (localhost only)  [alias: ak x dashboard]

Serves a self-contained web panel that visualizes the same subsystem rows
\`ak status\` reports — versions, natives, security, learning, providers, hosts,
mcp, ruvnet-brain, aqe — plus version drift and a learning-history sparkline.
Bound to 127.0.0.1; auto-refreshes every 5s. Read-only: it never changes state.
Nothing leaves your machine — the page is fully self-contained (no external
fetches, no internet). It opens in your default browser automatically.

Runs in the foreground — press Ctrl-C to stop.

Usage: ak x dashboard [options]

Options:
  --port N    port to bind on 127.0.0.1 (default 7431; 0 = ephemeral)
  --no-open   don't auto-open the browser (just print the URL — for headless use)

Examples:
  ak x dashboard              serve + open http://127.0.0.1:7431
  ak x dashboard --port 8080  pick a port
  ak x dashboard --no-open    print the URL only (SSH / headless)`;

/** Open a URL in the OS default browser, best-effort (never throws). Zero-dep:
 *  macOS `open`, Windows `cmd /c start`, else `xdg-open`. */
function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser / headless — URL is already printed */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function run({ flags }) {
  let port = 7431;
  if (flags.port !== undefined) {
    const p = Number(flags.port);
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      warn(`invalid --port ${flags.port}; using ${port}`);
    } else {
      port = p;
    }
  }

  let server;
  try {
    server = await startDashboard({ port, cwd: process.cwd() });
  } catch (e) {
    warn(`could not start dashboard: ${e.message}`);
    if (e.code === 'EADDRINUSE') info(`port ${port} is busy — try: ak x dashboard --port 0`);
    return 1;
  }

  ok(`dashboard live at ${server.url}`);
  info(dim('read-only · localhost only · Ctrl-C to stop'));

  if (!flags['no-open']) {
    openInBrowser(server.url);
    info(dim('opening your browser… (if it didn\'t, open the URL above; --no-open to disable)'));
  }

  // Block foreground until an interrupt, then close cleanly.
  return await new Promise((resolve) => {
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await server.close();
      console.log('');
      ok('dashboard stopped');
      resolve(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
