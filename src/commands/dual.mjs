// ak dual — run a Claude+Codex collaboration swarm using the managed per-activity
// routing policy. Materializes the dual-run config from providers.dualRouting and
// shells to `claude-flow-codex dual run --config` (ADR-0001 projection #2; ADR-0004
// escalation). Thin wrapper: ak owns the policy + retry, the adapter runs the swarm.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadKitConfig } from '../lib/config.mjs';
import { have } from '../lib/exec.mjs';
import { ok, warn, fail, info, dim, bold } from '../lib/output.mjs';
import {
  DUAL_RUN_TEMPLATES, DUAL_RUN_TEMPLATE_NAMES, policyToDualRunConfig, escalatePolicy, parseRouteSpecs,
} from '../lib/routing.mjs';

const ADAPTER = 'claude-flow-codex';

export const options = {
  route: { type: 'string', multiple: true },
  parallel: { type: 'boolean', default: false },
  escalate: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  'max-concurrent': { type: 'string' },
  timeout: { type: 'string' },
  json: { type: 'boolean', default: false },
};

export const help = `ak dual — run a Claude+Codex collaboration swarm

Uses your per-activity routing policy (from \`ak x provider\`) to assign each pipeline
step to the right host + model, then runs it via ${ADAPTER}.

Usage:
  ak dual run <template> "<task>"   run a collaboration pipeline
  ak dual templates                 list available templates

Templates: ${DUAL_RUN_TEMPLATE_NAMES.join(', ')}

Options (run):
  --route 'act:host[:model]'   per-run routing override (repeatable; not persisted)
  --parallel                   run independent workers in parallel (else sequential)
  --escalate                   on failure, retry once up the escalation ladder
  --dry-run                    print the materialized config + command, run nothing
  --max-concurrent <n>         max concurrent workers (default 4)
  --timeout <ms>               per-worker timeout

Examples:
  ak dual run feature "add token-bucket rate limiting"
  ak dual run security "src/auth/" --escalate
  ak dual run refactor "extract the payment module" --dry-run`;

/** Build the run-local policy (persisted policy + per-run --route overrides) and
 *  project it to a dual-run config. */
function buildConfig(cfg, template, task, routeFlags) {
  let policy = { ...(cfg.providers?.dualRouting ?? {}) };
  if (routeFlags?.length) {
    const { policy: overrides, warnings } = parseRouteSpecs(routeFlags);
    for (const w of warnings) warn(w);
    policy = { ...policy, ...overrides };
  }
  return { policy, config: policyToDualRunConfig(policy, { template, task }) };
}

/** Materialize the config as an ESM module and return its file:// URL. The adapter
 *  loads --config via `await import(path)` and reads the `workers` export, so a
 *  plain .json path fails (ERR_MODULE_NOT_FOUND / missing import assertion) — it
 *  must be an importable module referenced by absolute URL. (Verified against
 *  @claude-flow/codex dual-mode/cli.js.) */
export function writeConfigModule(config, task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dual-'));
  const file = path.join(dir, 'dual-run.config.mjs');
  fs.writeFileSync(file,
    `export const workers = ${JSON.stringify(config.workers, null, 2)};\n`
    + `export const taskContext = ${JSON.stringify(task)};\n`);
  return pathToFileURL(file).href;
}

/** Run the adapter with the swarm live (inherited stdio). Resolves to exit code. */
function runSwarm(configUrl, task, flags) {
  const args = ['dual', 'run', '--config', configUrl, '--task', task];
  if (flags.parallel) args.push('--parallel-workers');
  if (flags['max-concurrent']) args.push('--max-concurrent', flags['max-concurrent']);
  if (flags.timeout) args.push('--timeout', flags.timeout);
  // WORKAROUND (upstream @claude-flow/codex, ruvnet/ruflo#2766): the orchestrator
  // bootstraps shared memory via `npx ruflo@alpha memory init`, whose default DB path
  // differs from where the spawned workers read it → the whole run dies with "Database
  // not initialized". Pinning CLAUDE_FLOW_DB_PATH makes the init and the workers share
  // ONE db (verified: "✓ Shared memory initialized"). We only set it when the user
  // hasn't, and the adapter inherits it via its own spawn env. Remove once #2766 ships
  // (the adapter uses the local ruflo / a consistent path) — then re-verify a live run.
  const dbPath = process.env.CLAUDE_FLOW_DB_PATH ?? path.join(process.cwd(), '.claude-flow', 'dual-run-memory.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(ADAPTER, args, { stdio: 'inherit', env: { ...process.env, CLAUDE_FLOW_DB_PATH: dbPath } });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function printPlan(template, task, config) {
  console.log(bold(`dual run: ${template}`) + dim(`  "${task}"`));
  for (const w of config.workers) {
    const dep = w.dependsOn ? `after ${w.dependsOn.join(',')}` : 'start';
    console.log(`  ${w.id.padEnd(12)} ${w.platform.padEnd(7)} ${(w.model ?? '').padEnd(22)} ${dim(dep)}`);
  }
}

async function doRun({ positionals, flags }) {
  const template = positionals[1];
  const task = positionals.slice(2).join(' ').trim();
  if (!template || !DUAL_RUN_TEMPLATE_NAMES.includes(template)) {
    fail(`unknown template "${template ?? ''}" — expected: ${DUAL_RUN_TEMPLATE_NAMES.join(', ')}`);
    return 2;
  }
  if (!task) { fail('a task description is required: ak dual run <template> "<task>"'); return 2; }

  const cfg = loadKitConfig();
  if (Object.keys(cfg.providers?.dualRouting ?? {}).length === 0) {
    fail('no per-activity routing configured — enable dual-host first: ak x provider pick --host claude,codex');
    return 1;
  }

  const { policy, config } = buildConfig(cfg, template, task, flags.route);

  if (flags['dry-run'] || flags.json) {
    const cmd = `${ADAPTER} dual run --config <file> --task ${JSON.stringify(task)}${flags.parallel ? ' --parallel-workers' : ''}`;
    // --json emits ONLY the JSON object (no human table) so it stays pipeable.
    if (flags.json) { console.log(JSON.stringify({ template, task, config, command: cmd }, null, 2)); return 0; }
    printPlan(template, task, config);
    console.log(dim(`\ncommand: ${cmd}\nconfig:`)); console.log(JSON.stringify(config, null, 2));
    return 0;
  }

  printPlan(template, task, config);
  if (!(await have(ADAPTER))) {
    fail(`${ADAPTER} not found — enable dual-host to install the adapter: ak x provider pick --host claude,codex`);
    return 1;
  }

  // track the temp config-module dirs so we don't leak them (L3).
  const tmp = [];
  const mkConfig = (c) => { const url = writeConfigModule(c, task); tmp.push(path.dirname(fileURLToPath(url))); return url; };
  let code;
  try {
    code = await runSwarm(mkConfig(config), task, flags);
    // escalation: retry once up the (cross-vendor) ladder on failure (ADR-0004)
    if (code !== 0 && flags.escalate) {
      const overlay = escalatePolicy(policy);
      if (Object.keys(overlay).length) {
        warn(`run failed (exit ${code}) — escalating: ${Object.entries(overlay).map(([a, r]) => `${a}→${r.host}`).join(', ')}`);
        code = await runSwarm(mkConfig(policyToDualRunConfig({ ...policy, ...overlay }, { template, task })), task, flags);
      } else {
        warn('run failed and no escalation ladder is configured for these activities');
      }
    }
  } finally {
    for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }

  if (code === 0) { ok('dual run complete'); return 0; }
  fail(`dual run failed (exit ${code})`);
  // ak already pins CLAUDE_FLOW_DB_PATH to neutralize the upstream @claude-flow/codex
  // shared-memory bootstrap bug (ruvnet/ruflo#2766), so a failure here is usually a worker (auth, sandbox,
  // or model access) — not routing. The materialized config + host/model assignment
  // are ak's part and are correct.
  info('workers run as `claude -p` / `codex exec`; a failure here is typically host auth/sandbox/model access, not your routing. Re-run a single step with --route to isolate.');
  return code;
}

function listTemplates() {
  console.log(bold('dual-run templates') + dim('  (pipeline of activities; hosts come from your routing policy)'));
  for (const name of DUAL_RUN_TEMPLATE_NAMES) {
    const pipeline = DUAL_RUN_TEMPLATES[name].map((n) => n.activity).join(' → ');
    console.log(`  ${name.padEnd(10)} ${dim(pipeline)}`);
  }
}

export async function run({ flags, positionals }) {
  const sub = positionals[0] ?? 'help';
  if (sub === 'run') return doRun({ positionals, flags });
  if (sub === 'templates') { listTemplates(); return 0; }
  if (sub !== 'help') fail(`unknown dual subcommand: ${sub} (run|templates)`);
  else console.log(help);
  return sub === 'help' ? 0 : 2;
}
