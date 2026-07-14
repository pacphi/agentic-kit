#!/usr/bin/env node
// ruflo-kit — porcelain: setup | status | sync | uninstall. Everything else is
// plumbing under `ruflo-kit x <cmd>`. Bare invocation = status + one hint.
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
  'mcp': () => import('../src/commands/x/mcp.mjs'),
  'reference': () => import('../src/commands/x/reference.mjs'),
  'verify': () => import('../src/commands/x/verify.mjs'),
};

const HELP = `ruflo-kit — machine-level setup, healing, and verification for ruflo + agentic-qe

Usage:
  ruflo-kit                 status + suggested next action
  ruflo-kit setup           first-time setup (machine and/or this project)
  ruflo-kit status          read-only dashboard: what's true, what's drifted  [--json] [--deep]
  ruflo-kit sync            converge to good: upgrade + heal + verify         [--dry-run] [--no-upgrade]
  ruflo-kit uninstall       leave cleanly                                     [--dry-run] [--purge]

  When in doubt: ruflo-kit sync

Every mutating command accepts --dry-run (prints the plan, changes nothing).
Plumbing (power users): ruflo-kit x <cmd>   — see: ruflo-kit --help --all`;

const HELP_ALL = `${HELP}

Plumbing commands:
  ruflo-kit x daemon-gc [--kill]      list/stop stale ruflo daemons
  ruflo-kit x mcp [pick|off|status]   MCP registration + tool-family deny rules
  ruflo-kit x reference [diff|sync]   CLAUDE.md managed-block inspection/reconcile
  ruflo-kit x verify [learning|security|aqe|all]   deep proofs (slow, spawns real CLIs)
  ruflo-kit x improvement-eval [...]  causal self-improvement eval (route Q-learner)`;

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

  let table = PORCELAIN;
  if (cmd === 'x') {
    table = PLUMBING;
    cmd = rest[0];
    rest = rest.slice(1);
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
        if (r.outdated) console.log(dim(`↑ ${r.pkg} ${r.latest} available (installed ${r.installed}) — run: ruflo-kit sync`));
      }
    } catch { /* nudge is best-effort */ }
  }
  return code ?? 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { fail(err?.stack ?? String(err)); process.exit(1); },
);
