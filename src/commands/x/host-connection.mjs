// ak host check-connection — the CLI twin of the dashboard's host-health
// dialog's paid connection check (ADR-0053). Reuses createHostReadinessReader
// so the CLI refuses for exactly the hosts and reasons the dashboard would
// (`canCheckConnection`, `connectionUnavailable`, `evidenceKey`). Consent is
// the point: nothing is sent without --yes or an interactive y/N, and
// --dry-run always stops before any request, even with --yes. Under --json,
// every path — success, every refusal and every operational failure — prints
// exactly one JSON object on stdout; every human line stays on stderr.
import readline from 'node:readline/promises';
import { createHostReadinessReader } from '../../lib/host-readiness.mjs';
import { CONNECTION_CHECK_DISCLOSURE } from '../../lib/host-connection-disclosure.mjs';
import { ok, fail, info, humanOutputToStderr } from '../../lib/output.mjs';

const NON_TTY_REFUSAL = 'the connection check sends a paid request; re-run with --yes to confirm';
const DECLINED_REFUSAL = 'cancelled — no request sent';

/** Mirrors sync.mjs's askCodexRepair in spirit — a TTY [y/N] prompt, refused
 * outright with no terminal to ask on — but returns the refusal reason
 * instead of printing it, so checkFlow stays the one place that decides what
 * reaches the terminal and what reaches a --json payload. */
async function askConsent(question) {
  if (!process.stdin.isTTY) return { consented: false, refused: NON_TTY_REFUSAL };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const yes = /^y(?:es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    return yes ? { consented: true } : { consented: false, refused: DECLINED_REFUSAL };
  } finally { rl.close(); }
}

/** "provider / model" when the reader resolved a target, else the
 * dashboard's own fallback wording (client/host-readiness.mjs's "Selection"
 * line), so the two surfaces never describe the target differently. */
function targetLabel(target) {
  if (!target) return 'native host default or unassessed';
  return [target.provider, target.model].filter(Boolean).join(' / ') || 'native host default';
}

/** A refusal before or at consent: printed once, and echoed verbatim into
 * the --json payload's `refused` field so a scripted caller never has to
 * parse a human sentence to learn why nothing was sent. */
function refuse(host, message, code = 2) {
  fail(message);
  return { code, payload: { host: host ?? null, connection: null, refused: message } };
}

/** An operational failure — reading local evidence or running the probe
 * itself threw — as opposed to a deliberate refusal. */
function errorOut(host, message, code = 1) {
  fail(message);
  return { code, payload: { host: host ?? null, connection: null, error: message } };
}

async function checkFlow({ flags, host, reader, confirm }) {
  let view;
  try { view = await reader({ force: true }); }
  catch (error) { return errorOut(host, error.message); }
  if (!view) return refuse(host, 'local host checks are unavailable');
  const entry = view.hosts?.[host];
  if (!entry) return refuse(host, `unknown host: ${host ?? '(none)'} (claude|codex|opencode)`);
  if (!entry.canCheckConnection) return refuse(host, entry.connectionUnavailable);
  info(`host: ${host}`);
  const target = targetLabel(entry.target);
  info(`target: ${target}`);
  info(CONNECTION_CHECK_DISCLOSURE);
  if (flags['dry-run']) {
    info('dry run — no request sent');
    return { code: 0, payload: { host, dryRun: true, target, disclosure: CONNECTION_CHECK_DISCLOSURE, connection: null } };
  }
  const consent = flags.yes === true ? { consented: true } : await confirm('Run this connection check?');
  if (!consent.consented) return refuse(host, consent.refused ?? DECLINED_REFUSAL);
  let refreshed;
  try {
    refreshed = await reader.checkConnection({ host, confirm: true, evidenceKey: entry.evidenceKey });
  } catch (error) {
    return errorOut(host, error.message);
  }
  const connection = refreshed?.hosts?.[host]?.connection ?? {};
  (connection.state === 'pass' ? ok : fail)(`state: ${connection.state ?? 'unknown'}`);
  info(`reason: ${connection.reason ?? 'No reason reported.'}`);
  info(`model: ${connection.model ?? 'none'}`);
  return { code: connection.state === 'pass' ? 0 : 1, payload: { host, connection } };
}

/** @param {{ flags: Record<string, any>, positionals?: string[],
 * deps?: { createReader?: () => ReturnType<typeof createHostReadinessReader>,
 * confirm?: (question: string) => Promise<{consented: boolean, refused?: string}> } }} input */
export async function run({ flags, positionals, deps = {} }) {
  const host = positionals?.[0];
  const reader = deps.createReader?.() ?? createHostReadinessReader({ cwd: process.cwd() });
  const confirm = deps.confirm ?? askConsent;
  try {
    const outcome = flags.json
      ? await humanOutputToStderr(() => checkFlow({ flags, host, reader, confirm }))
      : await checkFlow({ flags, host, reader, confirm });
    if (flags.json) console.log(JSON.stringify(outcome.payload));
    return outcome.code;
  } finally {
    reader.close();
  }
}
