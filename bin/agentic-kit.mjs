#!/usr/bin/env node
// agentic-kit — porcelain: setup | status | sync | uninstall. Everything else is
// plumbing under `ak x <cmd>`. Bare invocation = status + one hint.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fail, dim } from '../src/lib/output.mjs';

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
  run: () => import('../src/commands/run.mjs'),
  dual: () => import('../src/commands/dual.mjs'),
  host: () => import('../src/commands/x/provider.mjs'),
  provider: () => import('../src/commands/x/provider.mjs'),
  uninstall: () => import('../src/commands/uninstall.mjs'),
});

const PLUMBING = Object.assign(Object.create(null), {
  'admin': () => import('../src/commands/x/admin.mjs'),
  'daemon-gc': () => import('../src/commands/x/daemon-gc.mjs'),
  'dashboard': () => import('../src/commands/x/dashboard.mjs'),
  'harvest': () => import('../src/commands/x/harvest.mjs'),
  'mcp': () => import('../src/commands/x/mcp.mjs'),
  'host': () => import('../src/commands/x/provider.mjs'),
  'provider': () => import('../src/commands/x/provider.mjs'),
  'reference': () => import('../src/commands/x/reference.mjs'),
  'statusline': () => import('../src/commands/x/statusline.mjs'),
  'verify': () => import('../src/commands/x/verify.mjs'),
});

const HELP = `agentic-kit — machine-level setup, healing, and verification for ruflo + agentic-qe

Usage (ak = alias of agentic-kit):
  ak                 status + suggested next action
  ak setup           first-time setup (machine and/or this project)    [--project] [--minimal] [--yes]
  ak status          read-only dashboard: what's true, what's drifted  [--json] [--deep]
  ak sync            converge to good: upgrade + heal + verify          [--dry-run] [--no-upgrade]
  ak dashboard       open the local web dashboard (localhost; auto-opens browser)  [--port N] [--no-open]
  ak admin           maintainer-only telemetry admin (localhost; GitHub/npm egress)  [--port N] [--no-open]
  ak usage           inspect/refresh offline provider analytics  [status|refresh openrouter]
  ak run             execute a host-neutral activity pipeline  [template "task"] [--dry-run]
  ak dual            deprecated compatibility wrapper; use ak run for new work
  ak host            manage agent hosts, routing, and provider bindings  [status|pick|refresh|off]
  ak provider        deprecated alias for ak host; removed before the stable release
  ak uninstall       leave cleanly                                      [--this-project] [--purge]

  When in doubt: ak sync

Every mutating command accepts --dry-run (prints the plan, changes nothing).
Any command accepts --help for its own flags + examples.

More:
  ak <cmd> --help    detailed help for one command (e.g. ak setup --help)
  ak --help --all    also list the plumbing commands (ak x <cmd>)
  ak --version       print the installed version`;

const HELP_ALL = `${HELP}

Plumbing (power users) — each takes --help:
  ak x admin [--port N]        maintainer-only telemetry admin (localhost; GitHub/npm egress)
  ak x daemon-gc [--kill]      list/stop stale ruflo daemons
  ak x dashboard [--port N]    read-only local health dashboard (localhost only)
  ak x harvest [--dry-run]     opt-in learning-write: replay experiences into the substrate
  ak x mcp [status|pick|off]   MCP registration + tool-family deny rules
  ak x host [status|pick|refresh|off]   manage hosts, routing, and provider bindings
  ak x provider [status|pick|refresh|off]   deprecated alias; removed before the stable release
  ak x reference [diff|sync]   CLAUDE.md managed-block inspection/reconcile
  ak x statusline [status|codex native|codex extended|codex off]   manage Codex's native user status line
  ak x verify [learning|security|aqe|providers|harvest|all]   deep proofs (slow, spawns real CLIs)
  ak x improvement-eval [...]  causal self-improvement eval (route Q-learner)`;

/** True if the arg list is asking for help rather than an action. */
const wantsHelp = (args) => args.includes('--help') || args.includes('-h');

async function main() {
  const argv = process.argv.slice(2);
  let cmd = argv[0];
  let rest = argv.slice(1);
  let deprecatedProvider = cmd === 'provider';
  const deprecatedDual = cmd === 'dual';

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
    deprecatedProvider = cmd === 'provider';
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

  if (deprecatedProvider) {
    const legacy = argv[0] === 'x' ? 'ak x provider' : 'ak provider';
    const canonical = argv[0] === 'x' ? 'ak x host' : 'ak host';
    console.error(`${legacy} is deprecated; use \`${canonical}\`. It will be removed before the stable release.`);
  }
  if (deprecatedDual) {
    console.error('ak dual is deprecated; use `ak run` for new execution work. It will be removed before the stable release.');
  }
  const mod = await table[cmd]();

  // Per-command help — intercepted BEFORE run() so mutating commands
  // (setup, sync, uninstall) never fire on `ak <cmd> --help`.
  if (wantsHelp(rest)) {
    console.log(mod.help ?? `ak ${cmd} — flags: ${
      Object.keys(mod.options ?? {}).map((o) => `--${o}`).join(' ') || '(none)'}`);
    return 0;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: mod.options ?? {},
    allowPositionals: true,
    strict: false,
  });
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
  if (!values.json && !values['dry-run'] && !['sync', 'usage'].includes(cmd)) {
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

main().then(
  (code) => process.exit(code),
  (err) => { fail(err?.stack ?? String(err)); process.exit(1); },
);
