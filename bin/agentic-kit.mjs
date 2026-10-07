#!/usr/bin/env node
// agentic-kit — porcelain: setup | status | sync | uninstall. Everything else is
// plumbing under `ak x <cmd>`. Bare invocation = status + one hint.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fail, dim, exitWhenFlushed, reportFailure } from '../src/lib/output.mjs';
import { nodeRuntimeError } from '../src/lib/node-runtime.mjs';
import { normalizeBareRefresh } from '../src/lib/refresh.mjs';

const runtimeError = nodeRuntimeError();
if (runtimeError) {
  console.error(runtimeError);
  process.exit(1);
}

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Object.create(null): a plain {} inherits Object.prototype, so `cmd in table`
// resolves 'toString'/'constructor'/'__proto__' etc. as legitimate commands —
// `ak toString` reached mod.run on Object.prototype.toString and threw a raw
// Node stack trace instead of "unknown command" (code-quality Finding 6).
// process.argv[2] is the most directly user-controlled string in this CLI;
// null-prototyping the dispatch tables makes `in` correct by construction,
// no call-site changes needed.
const PORCELAIN = Object.assign(Object.create(null), {
  status: () => import('../src/commands/status.mjs'),
  sync: () => import('../src/commands/sync.mjs'),
  setup: () => import('../src/commands/setup.mjs'),
  dashboard: () => import('../src/commands/x/dashboard.mjs'),
  admin: () => import('../src/commands/x/admin.mjs'),
  usage: () => import('../src/commands/usage.mjs'),
  telemetry: () => import('../src/commands/telemetry.mjs'),
  models: () => import('../src/commands/models.mjs'),
  system: () => import('../src/commands/system.mjs'),
  maintain: () => import('../src/commands/maintain.mjs'),
  about: () => import('../src/commands/about.mjs'),
  audit: () => import('../src/commands/audit.mjs'),
  heal: () => import('../src/commands/heal.mjs'),
  run: () => import('../src/commands/run.mjs'),
  host: () => import('../src/commands/x/host.mjs'),
  uninstall: () => import('../src/commands/uninstall.mjs'),
});

const PLUMBING = Object.assign(Object.create(null), {
  'aqe-embedding': () => import('../src/commands/x/aqe-embedding.mjs'),
  'admin': () => import('../src/commands/x/admin.mjs'),
  'aqe-store': () => import('../src/commands/x/aqe-store.mjs'),
  'daemon-gc': () => import('../src/commands/x/daemon-gc.mjs'),
  'dashboard': () => import('../src/commands/x/dashboard.mjs'),
  'harvest': () => import('../src/commands/x/harvest.mjs'),
  'mcp': () => import('../src/commands/x/mcp.mjs'),
  'host': () => import('../src/commands/x/host.mjs'),
  'reference': () => import('../src/commands/x/reference.mjs'),
  'ruflo-mcp': () => import('../src/commands/x/ruflo-mcp.mjs'),
  'skills': () => import('../src/commands/x/skills.mjs'),
  'codex-context': () => import('../src/commands/x/codex-context.mjs'),
  'statusline': () => import('../src/commands/x/statusline.mjs'),
});

const HELP = `agentic-kit — machine-level setup, healing, and verification for ruflo + agentic-qe

Usage (ak = alias of agentic-kit):
  ak                 status + suggested next action
  ak setup           first-time setup (machine and/or this project)    [--project] [--minimal] [--yes]
  ak status          read-only dashboard: what's true, what's drifted  [--json] [--refresh[=live|machine]]
  ak sync            converge to good: upgrade + heal + verify          [--dry-run] [--no-upgrade] [--skip SUBSYSTEM] [--retry-brain] [--json]
  ak dashboard       open the local web dashboard (localhost; auto-opens browser)  [--port N] [--no-open]
  ak admin           maintainer-only telemetry admin (localhost; GitHub/npm egress)  [--port N] [--no-open]
  ak usage           offline scorecard, prompt patterns, provider cache  [status|score|prompts|refresh openrouter]
  ak telemetry       export, validate and aggregate fleet evidence   [export|validate|aggregate|schema|metrics]
  ak models          inspect/refresh model lifecycle evidence  [status|refresh|diff|explain|plan]
  ak system          what this stack occupies on your machine   [--refresh[=live|machine]] [--json]
  ak maintain        findings, guidance, discovery, guarded one-action plans  [--refresh[=live|machine]] [inventory|guidance|plan|apply|...] [--json]
  ak about           what agentic-kit installs and configures, and why  [--category N]
  ak audit hooks     read-only host-neutral hook inventory + remediation plan [--host HOST] [--json]
  ak heal hooks      dry-run hook healing plan; explicit apply/verify/undo     [--host HOST] [--json]
  ak run             execute a host-neutral activity pipeline  [template "task"] [--dry-run]
  ak host            manage agent hosts, routing, and provider bindings  [status|pick|reset-routes|off|check-connection]
  ak uninstall       leave cleanly                                      [--this-project] [--purge]

  When in doubt: ak sync

Use --dry-run where offered to preview managed changes; consult command help for scope.
Any command accepts --help for its own flags + examples.

More:
  ak <cmd> --help    detailed help for one command (e.g. ak setup --help)
  ak --help --all    also list the plumbing commands (ak x <cmd>)
  ak --version       print the installed version`;

const HELP_ALL = `${HELP}

Plumbing (power users) — each takes --help:
  ak x aqe-embedding [status|configure|prepare|verify]   AQE semantic backend lifecycle
  ak x aqe-store [status|merge] [--yes]   merge stray AQE stores into the project store, then archive them
  ak x admin [--port N]        maintainer-only telemetry admin (localhost; GitHub/npm egress)
  ak x daemon-gc [--kill]      list/stop stale ruflo daemons
  ak x dashboard [--port N]    local health and guarded maintenance dashboard (localhost only)
  ak x harvest [--dry-run]     opt-in learning-write: replay experiences into the substrate
  ak x mcp [status|pick|off]   MCP registration + tool-family deny rules
  ak x host [status|pick|reset-routes|off|check-connection]   manage hosts, routing, and provider bindings
  ak x reference [diff|sync]   CLAUDE.md managed-block inspection/reconcile
  ak x skills plan             read-only project skill evidence + remediation plan
  ak x codex-context [status|max|off]   manage native Codex context capacities
  ak x statusline [status|codex native|codex extended|codex off]   manage Codex's native user status line
  ak x improvement-eval [...]  causal self-improvement eval (route Q-learner)`;

/** True if the arg list is asking for help rather than an action. */
const wantsHelp = (args) => args.includes('--help') || args.includes('-h');

/** A bare `--refresh` is the local refresh strength (ADR-0063). parseArgs
 *  cannot express an optional value, so for a command whose refresh option
 *  takes one the exact token becomes `--refresh=` before parsing. */
const refreshArgs = (mod, args) => (mod.options?.refresh?.type === 'string' ? normalizeBareRefresh(args) : args);

/** The tokens before a `--` terminator: everything after it is a positional,
 *  never an option (a `--json` there does not ask for JSON). */
const optionTokens = (args) => (args.includes('--') ? args.slice(0, args.indexOf('--')) : args);

/** A command's own help, or its flag list when it has none. */
const commandHelp = (cmd, mod) => mod.help ?? `ak ${cmd} — flags: ${
  Object.keys(mod.options ?? {}).map((o) => `--${o}`).join(' ') || '(none)'}`;

/** True once the command's options parsed with --json set, so a fatal error
 *  reported after that point still answers with one JSON object. */
let jsonRequested = false;

async function main() {
  const argv = process.argv.slice(2);
  let cmd = argv[0];
  let rest = argv.slice(1);

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(argv.includes('--all') ? HELP_ALL : HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === '-V') {
    const { readFileSync } = await import('node:fs');
    console.log(JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version);
    return 0;
  }

  /** @type {Record<string, () => Promise<any>>} */
  let table = PORCELAIN;
  if (cmd === 'x') {
    table = PLUMBING;
    cmd = rest[0];
    rest = rest.slice(1);
    // `ak x`, `ak x --help`, `ak x -h` → the plumbing index.
    if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP_ALL); return 0; }
    if (cmd === 'improvement-eval') {
      // raw passthrough — the eval tool owns its own flag parsing
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(process.execPath,
        [path.join(PKG_ROOT, 'src', 'tools', 'improvement-eval.mjs'), ...rest], { stdio: 'inherit' });
      return r.status ?? 1;
    }
    if (!cmd || !(cmd in table)) {
      fail(`unknown plumbing command: ${cmd ?? '(none)'}`);
      console.log(HELP_ALL);
      return 2;
    }
  } else if (cmd === undefined) {
    cmd = 'status';
    rest = ['--hint'];
  } else if (!(cmd in table)) {
    fail(`unknown command: ${cmd}`);
    console.log(HELP);
    return 2;
  }

  const mod = await table[cmd]();

  // Per-command help — intercepted BEFORE run() so mutating commands
  // (setup, sync, uninstall) never fire on `ak <cmd> --help`.
  if (wantsHelp(rest)) {
    console.log(commandHelp(cmd, mod));
    return 0;
  }

  // strict:true — a value-taking option must never swallow a following flag,
  // and unknown flags must fail loudly. A mistyped option that silently does
  // nothing is worse than one that says so.
  let parsed;
  try {
    parsed = parseArgs({
      args: refreshArgs(mod, rest),
      options: mod.options ?? {},
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    if (!String(err?.code ?? '').startsWith('ERR_PARSE_ARGS_')) throw err;
    if (cmd === 'telemetry') {
      const error = 'Telemetry failed: invalid command options.';
      console.error(error);
      console.log(JSON.stringify({ error, exitCode: 2 }));
      return 2;
    }
    // Under --json a rejected option still answers with one JSON object (the
    // command's own empty result when it defines one, as `ak sync` does); the
    // message and the help go to stderr. A retired spelling gets the parser's
    // generic message, with no hint (ADR-0063).
    reportFailure({
      json: Boolean(mod.options?.json) && optionTokens(rest).includes('--json'),
      payload: mod.jsonUsageError?.(err.message) ?? { error: err.message, exitCode: 2 },
      human: () => { fail(`ak ${cmd}: ${err.message}`); console.log(commandHelp(cmd, mod)); },
    });
    return 2;
  }
  const { values, positionals } = parsed;
  jsonRequested = values.json === true;

  const code = await mod.run({ flags: values, positionals, pkgRoot: PKG_ROOT });

  // Drift nudge: one line, cached, never blocks (skipped in --json contexts).
  // Also skipped under --dry-run: driftReport() shells `npm view`, which
  // writes to npm's own cache (~/.npm/_cacache, ~/.npm/_logs) as a side
  // effect of the network call — a real disk write that contradicts
  // "--dry-run: prints the plan, changes nothing" even though it never
  // touches an ak-managed path.
  // `ak usage status` promises a pure offline cache read. The explicit
  // `refresh` subcommand owns its one named network request; neither form may
  // silently add unrelated npm probes through the generic drift nudge.
  // setup and host own complete mutation/reporting flows. Running the generic
  // nudge after a declined trust preflight could write version-cache state and
  // violate their "before any changes" boundary.
  // Also skipped when the command itself refused to run (exit code 2, a
  // parser or command-level usage error): a rejected `ak status --refresh=bogus`
  // never got as far as doing anything, so it must not spend network calls a
  // parse error never used to.
  // uninstall is leaving: the nudge runs `npm view` and saves the version cache,
  // which writes a default kit.json back after `--purge` removed the config folder.
  if (code !== 2 && !values.json && !values['dry-run'] && !['sync', 'usage', 'telemetry', 'models', 'setup', 'host', 'audit', 'heal', 'maintain', 'ruflo-mcp', 'aqe-embedding', 'aqe-store', 'uninstall'].includes(cmd)) {
    try {
      const { driftReport } = await import('../src/lib/versions.mjs');
      for (const r of await driftReport()) {
        if (r.outdated) console.log(dim(`↑ ${r.pkg} ${r.latest} available (installed ${r.installed}) — run: ak sync`));
      }
    } catch { /* nudge is best-effort */ }
    // Local artifact drift (guidance blocks, codex MCP bridge, statusline) —
    // spawn-light file compares, so template/registration drift surfaces after
    // ANY command, not only when someone happens to run `ak status`. Skipped
    // where it would be pure noise: status/reference display the same drift
    // themselves, sync just healed it, uninstall is leaving.
    if (!['status', 'reference', 'uninstall'].includes(cmd)) {
      try {
        const { localDrift } = await import('../src/lib/nudge.mjs');
        const drifted = await localDrift({ pkgRoot: PKG_ROOT });
        if (drifted.length) console.log(dim(`↻ drifted: ${drifted.join(' · ')} — run: ak sync`));
      } catch { /* nudge is best-effort */ }
    }
  }
  return code ?? 0;
}

/** A command that threw. An unreadable kit.json gets its recovery commands;
 *  anything else its stack. Under --json stdout carries one JSON object,
 *  `{ error, exitCode: 1 }` plus `recovery` for kit.json, and the human lines
 *  go to stderr. The config module loads here, not at startup, so the bin
 *  stays cheap to start. */
async function reportFatal(err) {
  const config = await import('../src/lib/config.mjs').catch(() => null);
  const recovery = config?.configErrorRecovery(err) ?? null;
  reportFailure({
    json: jsonRequested,
    payload: { error: err?.message ?? String(err), exitCode: 1, ...(recovery ? { recovery } : {}) },
    human: () => {
      fail(recovery ? err.message : err?.stack ?? String(err));
      for (const line of recovery ? config.configRecoveryLines(recovery) : []) console.log(line);
    },
  });
}

main().then(
  (code) => exitWhenFlushed(code),
  (err) => reportFatal(err).finally(() => exitWhenFlushed(1)),
);
