// ak run — host-neutral execution of the managed activity routing plan. `ak dual`
// remains the compatibility adapter for claude-flow-codex collaboration pipelines.
import { loadKitConfig } from '../lib/config.mjs';
import { fail, ok, dim, bold } from '../lib/output.mjs';
import { executeRunPlan } from '../lib/execution/runner.mjs';
import { DUAL_RUN_TEMPLATE_NAMES, materializeRunPlan, parseRouteSpecs } from '../lib/routing.mjs';

export const options = {
  route: { type: 'string', multiple: true },
  'dry-run': { type: 'boolean', default: false },
  'max-concurrent': { type: 'string' },
  timeout: { type: 'string' },
  json: { type: 'boolean', default: false },
};

export const help = `ak run — execute a host-neutral activity pipeline

Materializes the managed per-activity routing policy and runs each worker through
its host adapter. OpenCode is accepted only after its routing capability is enabled.

Usage:
  ak run <template> "<task>"

Templates: ${DUAL_RUN_TEMPLATE_NAMES.join(', ')}

Options:
  --route 'act:host[:model]'   per-run routing override (repeatable; not persisted)
  --dry-run                    print the host-neutral execution plan only
  --max-concurrent <n>         max concurrent workers (default 4)
  --timeout <ms>               per-worker timeout (default 120000)
  --json                       emit machine-readable plan/results

Examples:
  ak run feature "add token-bucket rate limiting" --dry-run
  ak run security "src/auth/" --route 'security-scan:opencode'`;

function positiveInt(value, name) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new TypeError(`${name} must be a positive integer`);
  return Number(value);
}

export function buildRunPlan(cfg, template, task, routeFlags = []) {
  let policy = { ...(cfg.providers?.dualRouting ?? {}) };
  if (routeFlags.length) {
    const { policy: overrides, warnings } = parseRouteSpecs(routeFlags);
    policy = { ...policy, ...overrides };
    return { plan: materializeRunPlan(policy, { template, task }), warnings };
  }
  return { plan: materializeRunPlan(policy, { template, task }), warnings: [] };
}

function printPlan(plan) {
  console.log(bold(`run: ${plan.template}`));
  for (const worker of plan.workers) {
    const dependency = worker.dependsOn?.length ? `after ${worker.dependsOn.join(', ')}` : 'start';
    console.log(`  ${worker.id.padEnd(12)} ${worker.host.padEnd(9)} ${(worker.configuredModel ?? '').padEnd(24)} ${dim(dependency)}`);
  }
}

function printResults(results) {
  for (const result of results) {
    const detail = result.failure?.reason ? ` — ${result.failure.reason}` : '';
    console.log(`  ${result.workerId.padEnd(12)} ${result.host.padEnd(9)} ${result.status} (${result.exitCategory})${dim(detail)}`);
  }
}

export async function run({ flags, positionals, executePlan = executeRunPlan }) {
  const template = positionals[0];
  const task = positionals.slice(1).join(' ').trim();
  if (!template || !DUAL_RUN_TEMPLATE_NAMES.includes(template)) {
    fail(`unknown template "${template ?? ''}" — expected: ${DUAL_RUN_TEMPLATE_NAMES.join(', ')}`);
    return 2;
  }
  if (!task) { fail('a task description is required: ak run <template> "<task>"'); return 2; }
  let plan;
  let warnings;
  try {
    ({ plan, warnings } = buildRunPlan(loadKitConfig(), template, task, flags.route ?? []));
  } catch (error) {
    fail(error.message);
    return 2;
  }
  for (const warning of warnings) console.error(`warning: ${warning}`);
  if (flags['dry-run']) {
    if (flags.json) console.log(JSON.stringify({ plan }, null, 2));
    else printPlan(plan);
    return 0;
  }
  let maxConcurrent;
  let timeoutMs;
  try {
    maxConcurrent = positiveInt(flags['max-concurrent'], 'max-concurrent');
    timeoutMs = positiveInt(flags.timeout, 'timeout');
  } catch (error) { fail(error.message); return 2; }
  if (!flags.json) printPlan(plan);
  const results = await executePlan(plan, { maxConcurrent, timeoutMs });
  if (flags.json) console.log(JSON.stringify({ plan, results }, null, 2));
  else printResults(results);
  // The human status line is gated on !json — a trailing "✓ run complete"
  // after the document makes `ak run --json` unparseable (qe-court B8).
  const succeeded = results.every((result) => result.status === 'succeeded');
  if (!flags.json) (succeeded ? ok : fail)(succeeded ? 'run complete' : 'run finished with one or more non-successful workers');
  return succeeded ? 0 : 1;
}
