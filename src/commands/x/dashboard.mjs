// x dashboard — local observations and guarded Maintenance actions.
//
// Boots a loopback-only HTTP server (127.0.0.1) that serves a single
// self-contained page, observation endpoints, and guarded Maintenance routes.
// The live view tails metadata from Claude/Codex and optional explicitly
// registered ruflo/AQE JSONL sources. Runs FOREGROUND and blocks until
// Ctrl-C; nothing is detached. Cache/scan writes and authorized maintenance are scoped.
import path from 'node:path';
import { startDashboard } from '../../lib/dashboard-server.mjs';
import { openInBrowser } from '../../lib/browser.mjs';
import { ok, info, dim, warn } from '../../lib/output.mjs';

export const options = {
  port: { type: 'string' },
  'no-open': { type: 'boolean', default: false },
  'live-source': { type: 'string', multiple: true },
};

export const help = `ak dashboard — local health and guarded maintenance dashboard (localhost only)  [alias: ak x dashboard]

Serves a self-contained web panel that visualizes the same subsystem rows
\`ak status\` reports — versions, natives, security, learning, providers, hosts,
mcp, ruvnet-brain, aqe — plus version drift, a learning-history sparkline, and
(on the Usage tab) full session transcripts. Bound to 127.0.0.1; health
polling defaults to 30s and the Observability tab streams metadata with SSE.
The browser uses same-origin API requests. Server-side status/version checks can
contact version services and persist caches; explicit Maintenance actions can
modify managed state after their plan/confirmation checks.

A per-session token is printed in the launch URL's # fragment. The page stores
it locally and sends a header for ordinary requests, or a query token for native
EventSource streams. API GET routes also accept a query token for compatibility;
prefer headers. Maintenance POST routes require header authentication. The token
is reusable for the server session, so protect the printed URL and local storage.

It opens in your default browser automatically. Runs in the foreground —
press Ctrl-C to stop.

Usage: ak x dashboard [options]

Options:
  --port N    port to bind on 127.0.0.1 (default 7431; 0 = ephemeral)
  --no-open   don't auto-open the browser (just print the URL — for headless use)
  --live-source 'surface=path'
              observe an explicit structured JSONL source; repeatable.
              surface is ruflo or aqe

Examples:
  ak x dashboard              serve + open http://127.0.0.1:7431
  ak x dashboard --port 8080  pick a port
  ak x dashboard --no-open    print the URL only (SSH / headless)
  ak x dashboard --live-source 'aqe=.agentic-qe/live-events.jsonl'`;

/** Parse explicit structured telemetry sources without guessing upstream stores. */
export function parseLiveSources(raw, cwd = process.cwd()) {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sources = [];
  for (const value of values) {
    const match = /^(ruflo|aqe)=(.+)$/.exec(String(value));
    if (!match || !match[2].trim()) {
      throw new TypeError(`invalid --live-source ${value}; expected ruflo|aqe=path`);
    }
    sources.push({ surface: match[1], file: path.resolve(cwd, match[2].trim()) });
  }
  return sources;
}

export async function run({ flags }) {
  let structuredSources;
  try {
    structuredSources = parseLiveSources(flags['live-source'], process.cwd());
  } catch (e) {
    warn(e.message);
    return 2;
  }
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
    server = await startDashboard({
      port,
      cwd: process.cwd(),
      liveOptions: { structuredSources },
    });
  } catch (e) {
    warn(`could not start dashboard: ${e.message}`);
    if (e.code === 'EADDRINUSE') info(`port ${port} is busy — try: ak x dashboard --port 0`);
    return 1;
  }

  ok(`dashboard live at ${server.url}`);
  info(dim('localhost only · guarded Maintenance actions · Ctrl-C to stop'));
  info('open this URL (it carries a session token in the # fragment):');
  info(`  ${server.urlWithToken}`);

  if (!flags['no-open']) {
    openInBrowser(server.urlWithToken);
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
