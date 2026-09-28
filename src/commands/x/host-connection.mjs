// ak host check-connection — the CLI twin of the dashboard's host-health
// dialog's paid connection check (ADR-0053). Reuses createHostReadinessReader
// so the CLI refuses for exactly the hosts and reasons the dashboard would
// (`canCheckConnection`, `connectionUnavailable`, `evidenceKey`). Consent is
// the point: nothing is sent without --yes or an interactive y/N, and
// --dry-run always stops before any request, even with --yes.
import readline from 'node:readline/promises';
import { createHostReadinessReader } from '../../lib/host-readiness.mjs';
import { CONNECTION_CHECK_DISCLOSURE } from '../../lib/host-connection-disclosure.mjs';
import { ok, fail, info, humanOutputToStderr } from '../../lib/output.mjs';

/** Mirrors sync.mjs's askCodexRepair: a TTY [y/N] prompt, or a fail()ed
 * refusal when there is no terminal to ask on. */
async function askConsent(question) {
  if (!process.stdin.isTTY) {
    fail('the connection check sends a paid request; re-run with --yes to confirm');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(?:es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); }
  finally { rl.close(); }
}

/** "provider / model" when the reader resolved a target, else the
 * dashboard's own fallback wording (client/host-readiness.mjs's "Selection"
 * line), so the two surfaces never describe the target differently. */
function targetLabel(target) {
  if (!target) return 'native host default or unassessed';
  return [target.provider, target.model].filter(Boolean).join(' / ') || 'native host default';
}

async function checkFlow({ flags, host, reader }) {
  const view = await reader({ force: true });
  if (!view) { fail('local host checks are unavailable'); return { code: 2 }; }
  const entry = view.hosts?.[host];
  if (!entry) { fail(`unknown host: ${host ?? '(none)'} (claude|codex|opencode)`); return { code: 2 }; }
  if (!entry.canCheckConnection) { fail(entry.connectionUnavailable); return { code: 2 }; }
  info(`host: ${host}`);
  info(`target: ${targetLabel(entry.target)}`);
  info(CONNECTION_CHECK_DISCLOSURE);
  if (flags['dry-run']) { info('dry run — no request sent'); return { code: 0 }; }
  const consented = flags.yes === true || await askConsent('Run this connection check?');
  if (!consented) {
    // askConsent already printed the refusal reason on a non-TTY; an
    // interactive decline needs its own line so "nothing happened" is said.
    if (process.stdin.isTTY) info('cancelled — no request sent');
    return { code: 2 };
  }
  let refreshed;
  try {
    refreshed = await reader.checkConnection({ host, confirm: true, evidenceKey: entry.evidenceKey });
  } catch (error) {
    fail(error.message);
    return { code: 1 };
  }
  const connection = refreshed?.hosts?.[host]?.connection ?? {};
  (connection.state === 'pass' ? ok : fail)(`state: ${connection.state ?? 'unknown'}`);
  info(`reason: ${connection.reason ?? 'No reason reported.'}`);
  info(`model: ${connection.model ?? 'none'}`);
  return { code: connection.state === 'pass' ? 0 : 1, payload: { host, connection } };
}

/** @param {{ flags: Record<string, any>, positionals?: string[],
 * deps?: { createReader?: () => ReturnType<typeof createHostReadinessReader> } }} input */
export async function run({ flags, positionals, deps = {} }) {
  const host = positionals?.[0];
  const reader = deps.createReader?.() ?? createHostReadinessReader({ cwd: process.cwd() });
  try {
    const outcome = flags.json
      ? await humanOutputToStderr(() => checkFlow({ flags, host, reader }))
      : await checkFlow({ flags, host, reader });
    if (flags.json && outcome.payload) console.log(JSON.stringify(outcome.payload));
    return outcome.code;
  } finally {
    reader.close();
  }
}
