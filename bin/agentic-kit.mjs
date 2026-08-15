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
  system: () => import('../src/commands/system.mjs'),
  about: () => import('../src/commands/about.mjs'),
  run: () => import('../src/commands/run.mjs'),
  host: () => import('../src/commands/x/host.mjs'),
  uninstall: () => import('../src/commands/uninstall.mjs'),
});

const PLUMBING = Object.assign(Object.create(null), {
  'admin': () => import('../src/commands/x/admin.mjs'),
  'daemon-gc': () => import('../src/commands/x/daemon-gc.mjs'),
  'dashboard': () => import('../src/commands/x/dashboard.mjs'),
  'harvest': () => import('../src/commands/x/harvest.mjs'),
  'mcp': () => import('../src/commands/x/mcp.mjs'),
  'host': () => import('../src/commands/x/host.mjs'),
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
  ak system          what this stack occupies on your machine   [--deep] [--json]
  ak about           what agentic-kit installs and configures, and why  [--category N]
  ak run             execute a host-neutral activity pipeline  [template "task"] [--dry-run]
  ak host            manage agent hosts, routing, and provider bindings  [status|pick|refresh|off]
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

  // Experimental host-adapter bootstrap (Wave 4, adapter door) — the single
  // place every command passes through. Gated on the env var BEFORE anything
  // else runs so the default (flag unset) is truly zero calls, zero output,
  // zero behavior change: no dynamic import, no config read, nothing.
  // Refusals are warnings on stderr, never fatal — a bad external adapter
  // must never block a command that doesn't use it.
  if (process.env.AK_EXPERIMENTAL_HOST_ADAPTERS === '1') {
    try {
      const { loadKitConfig } = await import('../src/lib/config.mjs');
      const { bootstrapHostAdapters } = await import('../src/lib/adapters/admission.mjs');
      const { warnings } = await bootstrapHostAdapters({ cfg: loadKitConfig(), env: process.env });
      for (const w of warnings) {
        console.error(dim(`⚠ host adapter '${w.name}' not admitted (${w.reason}): ${w.detail ?? ''}`.trimEnd()));
      }
    } catch { /* experimental surface — never blocks a command */ }
  }

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
  if (!values.json && !values['dry-run'] && !['sync', 'usage', 'setup', 'host'].includes(cmd)) {
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

const shellQuote = (value) => process.platform === 'win32'
  ? `'${String(value).replaceAll("'", "''")}'`
  : `'${String(value).replaceAll("'", "'\"'\"'")}'`;

function reportFatal(err) {
  if (err?.name === 'KitConfigError' && typeof err.configPath === 'string') {
    const backup = `${err.configPath}.invalid`;
    fail(err.message);
    console.log('Recovery (the original is preserved):');
    if (process.platform === 'win32') {
      console.log(`  Move-Item -LiteralPath ${shellQuote(err.configPath)} -Destination ${shellQuote(backup)}`);
    } else {
      console.log(`  mv -- ${shellQuote(err.configPath)} ${shellQuote(backup)}`);
    }
    console.log('  ak status');
    console.log(`Then compare ${backup} with the regenerated defaults and restore only the intended values.`);
    return;
  }
  fail(err?.stack ?? String(err));
}

main().then(
  (code) => process.exit(code),
  (err) => { reportFatal(err); process.exit(1); },
);
