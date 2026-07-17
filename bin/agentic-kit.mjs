#!/usr/bin/env node
// agentic-kit — porcelain: setup | status | sync | uninstall. Everything else is
// plumbing under `ak x <cmd>`. Bare invocation = status + one hint.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fail, dim } from '../src/lib/output.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORCELAIN = {
  status: () => import('../src/commands/status.mjs'),
  sync: () => import('../src/commands/sync.mjs'),
  setup: () => import('../src/commands/setup.mjs'),
  uninstall: () => import('../src/commands/uninstall.mjs'),
};

const PLUMBING = {
  'daemon-gc': () => import('../src/commands/x/daemon-gc.mjs'),
  'dashboard': () => import('../src/commands/x/dashboard.mjs'),
  'harvest': () => import('../src/commands/x/harvest.mjs'),
  'mcp': () => import('../src/commands/x/mcp.mjs'),
  'provider': () => import('../src/commands/x/provider.mjs'),
  'reference': () => import('../src/commands/x/reference.mjs'),
  'verify': () => import('../src/commands/x/verify.mjs'),
};

const HELP = `agentic-kit — machine-level setup, healing, and verification for ruflo + agentic-qe

Usage (ak = alias of agentic-kit):
  ak                 status + suggested next action
  ak setup           first-time setup (machine and/or this project)    [--project] [--minimal] [--yes]
  ak status          read-only dashboard: what's true, what's drifted  [--json] [--deep]
  ak sync            converge to good: upgrade + heal + verify          [--dry-run] [--no-upgrade]
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
  ak x daemon-gc [--kill]      list/stop stale ruflo daemons
  ak x dashboard [--port N]    read-only local health dashboard (localhost only)
  ak x harvest [--dry-run]     opt-in learning-write: replay experiences into the substrate
  ak x mcp [status|pick|off]   MCP registration + tool-family deny rules
  ak x provider [status|pick|off]   detect claude/codex CLIs; wire ruflo + aqe hosts/providers
  ak x reference [diff|sync]   CLAUDE.md managed-block inspection/reconcile
  ak x verify [learning|security|aqe|providers|all]   deep proofs (slow, spawns real CLIs)
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
  const code = await mod.run({ flags: values, positionals, pkgRoot: PKG_ROOT });

  // Drift nudge: one line, cached, never blocks (skipped in --json contexts).
  if (!values.json && cmd !== 'sync') {
    try {
      const { driftReport } = await import('../src/lib/versions.mjs');
      for (const r of await driftReport()) {
        if (r.outdated) console.log(dim(`↑ ${r.pkg} ${r.latest} available (installed ${r.installed}) — run: ak sync`));
      }
    } catch { /* nudge is best-effort */ }
  }
  return code ?? 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { fail(err?.stack ?? String(err)); process.exit(1); },
);
