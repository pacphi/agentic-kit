// ak run — host-neutral execution of the managed activity routing plan.
import { loadKitConfig } from '../lib/config.mjs';
import { fail, ok, dim, bold } from '../lib/output.mjs';
import { executeRunPlan } from '../lib/execution/runner.mjs';
import { RUN_TEMPLATE_NAMES, materializeRunPlan, parseRouteSpecs } from '../lib/routing.mjs';

export const options = {
  route: { type: 'string', multiple: true },
  escalate: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  'max-concurrent': { type: 'string' },
  timeout: { type: 'string' },
  json: { type: 'boolean', default: false },
};

export const help = `ak run — execute a host-neutral activity pipeline

Materializes the managed per-activity routing policy and runs each worker through
its host adapter. OpenCode is accepted only after its routing capability is enabled.
Successful dependency outputs are threaded through runtime-only bounded handoffs at
runtime; dry-run prompts and public JSON results never contain those summaries.

Trust boundary: workers run with YOUR CLI trust posture in the target repo —
its opencode.json / .claude settings / AGENTS.md apply. Run this only in
repositories you would trust with your full user privileges (ADR-0018).

Usage:
  ak run <template> "<task>"

Templates: ${RUN_TEMPLATE_NAMES.join(', ')}

Options:
  --route 'act:host[:model]'   per-run routing override (repeatable; not persisted)
  --escalate                   on failure, advance the worker one rung of its
                               route's escalation ladder (bounded by the ladder;
                               permission/consent and uncertain results are
                               never escalated)
  --dry-run                    print the host-neutral execution plan only
  --max-concurrent <n>         max concurrent workers (default 4)
  --timeout <ms>               one absolute readiness→observe budget per attempt
                               (default 120000; teardown is separately bounded)
  --json                       emit machine-readable plan/results

Examples:
  ak run feature "add token-bucket rate limiting" --dry-run
  ak run security "src/auth/" --route 'security-scan:opencode'
  ak run feature "fix the flaky parser" --escalate`;

/** @param {string|undefined} value @param {string} name @param {{ ceiling?: number }} [opts] */
function positiveInt(value, name, { ceiling } = {}) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new TypeError(`${name} must be a positive integer`);
  const n = Number(value);
  // Node clamps setTimeout delays above 2^31-1 ms to ~1 ms — an uncapped
  // --timeout would turn a huge value into an instant timeout for every
  // worker (#88). Reject above the ceiling rather than silently mis-timing.
  if (ceiling && n > ceiling) throw new TypeError(`${name} must not exceed ${ceiling} (a larger value is clamped to ~1ms by Node's timer)`);
  return n;
}

/** A persisted routing.routes entry (kit.json is hand-editable — CLI routes are
 *  validated, file entries were not, and a bad one crashed plan *printing*
 *  far from the cause, #88). Returns an error string, or null when valid. */
function routeEntryError(activity, entry) {
  if (!entry || typeof entry !== 'object') return `route "${activity}" must be an object`;
  if (typeof entry.host !== 'string' || !entry.host) return `route "${activity}" requires a non-empty host string`;
  if (entry.model != null && typeof entry.model !== 'string') return `route "${activity}".model must be a string when present`;
  if (entry.escalation != null) {
    if (!Array.isArray(entry.escalation)) return `route "${activity}".escalation must be an array when present`;
    for (const [i, rung] of entry.escalation.entries()) {
      if (!rung || typeof rung.host !== 'string' || !rung.host) return `route "${activity}".escalation[${i}] requires a non-empty host string`;
      if (rung.model != null && typeof rung.model !== 'string') return `route "${activity}".escalation[${i}].model must be a string when present`;
    }
  }
  return null;
}

function validatePolicy(policy) {
  const errors = Object.entries(policy).map(([a, e]) => routeEntryError(a, e)).filter(Boolean);
  if (errors.length) throw new Error(`invalid routing policy: ${errors.join('; ')}`);
}

export function buildRunPlan(cfg, template, task, routeFlags = []) {
  let policy = { ...(cfg.routing?.routes ?? {}) };
  if (routeFlags.length) {
    const { policy: overrides, warnings } = parseRouteSpecs(routeFlags);
    policy = { ...policy, ...overrides };
    validatePolicy(policy);
    return { plan: materializeRunPlan(policy, { template, task }), warnings };
  }
  validatePolicy(policy);
  return { plan: materializeRunPlan(policy, { template, task }), warnings: [] };
}

function printPlan(plan) {
  console.log(bold(`run: ${plan.template}`));
  for (const worker of plan.workers) {
    const dependency = worker.dependsOn?.length ? `after ${worker.dependsOn.join(', ')}` : 'start';
    const ladder = worker.escalate?.length ? dim(`  ↑ ${worker.escalate.map((rung) => rung.host).join('→')}`) : '';
    console.log(`  ${worker.id.padEnd(12)} ${worker.host.padEnd(9)} ${(worker.configuredModel ?? '').padEnd(24)} ${dim(dependency)}${ladder}`);
  }
}

function printResults(results) {
  for (const result of results) {
    const detail = result.failure?.reason ? ` — ${result.failure.reason}` : '';
    // The escalation trail is visible, not silent: a success after advancing
    // rungs says where it started (ADR-0019).
    const trail = result.attempts?.length > 1 ? dim(` (escalated from ${result.attempts[0].host})`) : '';
    console.log(`  ${result.workerId.padEnd(12)} ${result.host.padEnd(9)} ${result.status} (${result.exitCategory})${trail}${dim(detail)}`);
  }
}

export async function run({ flags, positionals, executePlan = executeRunPlan, cfg = loadKitConfig() }) {
  const template = positionals[0];
  const task = positionals.slice(1).join(' ').trim();
  if (!template || !RUN_TEMPLATE_NAMES.includes(template)) {
    fail(`unknown template "${template ?? ''}" — expected: ${RUN_TEMPLATE_NAMES.join(', ')}`);
    return 2;
  }
  if (!task) { fail('a task description is required: ak run <template> "<task>"'); return 2; }
  let plan;
  let warnings;
  try {
    ({ plan, warnings } = buildRunPlan(cfg, template, task, flags.route ?? []));
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
    timeoutMs = positiveInt(flags.timeout, 'timeout', { ceiling: 2_147_483_647 });
  } catch (error) { fail(error.message); return 2; }
  if (!flags.json) printPlan(plan);
  const results = await executePlan(plan, { maxConcurrent, timeoutMs, escalate: !!flags.escalate });
  if (flags.json) console.log(JSON.stringify({ plan, results }, null, 2));
  else printResults(results);
  // The human status line is gated on !json — a trailing "✓ run complete"
  // after the document makes `ak run --json` unparseable (qe-court B8).
  const succeeded = results.every((result) => result.status === 'succeeded');
  if (!flags.json) (succeeded ? ok : fail)(succeeded ? 'run complete' : 'run finished with one or more non-successful workers');
  return succeeded ? 0 : 1;
}
