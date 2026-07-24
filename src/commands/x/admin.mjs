// x admin — a maintainer-only local telemetry admin for the kit.
//
// Sibling of `ak x dashboard`, split along the network-egress line (ADR-0007):
// where the dashboard is offline-first and silent, admin exists TO call GitHub and
// npm and it touches a credential. Both are loopback-only and foreground-until-
// Ctrl-C; this one carries a fresh per-session token and prints a launch URL whose
// # fragment bootstraps that token into the page.
import { startAdmin } from '../../lib/admin-server.mjs';
import { openInBrowser } from '../../lib/browser.mjs';
import { ok, info, dim, warn } from '../../lib/output.mjs';

export const options = {
  port: { type: 'string' },
  'no-open': { type: 'boolean', default: false },
};

export const help = `ak admin — maintainer-only local telemetry admin (localhost only)  [alias: ak x admin]

Serves a self-contained web panel showing how the project is actually doing —
unique repo visitors, release-asset pulls, npm range, GitHub traffic, and the
humans who filed issues, opened PRs, or forked. Unlike \`ak dashboard\` (which is
offline-first and never leaves your machine), admin makes DELIBERATE network
egress: the server fetches GitHub + npm on your behalf and reads a GitHub
credential (GITHUB_TOKEN → GH_TOKEN → \`gh auth token\`, best-effort) at runtime.
That credential is never persisted and never reaches the page.

Bound to 127.0.0.1. A fresh session token is minted at startup and carried into
the browser in the launch URL's # fragment (never a query param, never logged);
the page moves it to localStorage and sends it only as a request header.

Runs in the foreground — press Ctrl-C to stop.

Usage: ak x admin [options]

Options:
  --port N    port to bind on 127.0.0.1 (default 7432; 0 = ephemeral)
  --no-open   don't auto-open the browser (just print the URL — for headless use)

Examples:
  ak x admin              serve + open http://127.0.0.1:7432
  ak x admin --port 0     pick an ephemeral port
  ak x admin --no-open    print the URL only (SSH / headless)`;

export async function run({ flags }) {
  let port = 7432;
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
    server = await startAdmin({ port });
  } catch (e) {
    warn(`could not start admin: ${e.message}`);
    if (e.code === 'EADDRINUSE') info(`port ${port} is busy — try: ak x admin --port 0`);
    return 1;
  }

  ok(`admin live at ${server.url}`);
  info(dim('maintainer-only · localhost only · deliberate GitHub/npm egress · Ctrl-C to stop'));
  info('open this URL (it carries a one-time session token in the # fragment):');
  info(`  ${server.urlWithToken}`);

  if (!flags['no-open']) {
    openInBrowser(server.urlWithToken);
    info(dim('opening your browser… (if it didn\'t, open the URL above; --no-open to disable)'));
  }

  // Block foreground until an interrupt, then close cleanly (like dashboard).
  return await new Promise((resolve) => {
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await server.close();
      console.log('');
      ok('admin stopped');
      resolve(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
