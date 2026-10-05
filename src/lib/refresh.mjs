// One refresh operation (ADR-0063, the refresh vocabulary). A bare `--refresh`
// and its `=live` and `=machine` strengths run one ordered stage table; every
// command that takes the flag runs the same stages with the same labels.
//
// Cheap to import: the bin normalizes a bare `--refresh` with this module
// before any command loads, so its only static import is the output helpers.
// Status, the live checks, the machine collector, Maintenance and the kit
// config load lazily, inside the CLI stage set, when a stage actually runs.
import { ok, warn, info, dim, withProgress } from './output.mjs';

/** Internal strength names: `local` is the bare `--refresh`. */
export const REFRESH_STRENGTHS = Object.freeze(['local', 'live', 'machine']);

/** The parseArgs options every command that takes the flag spreads in. */
export const REFRESH_OPTIONS = Object.freeze({
  refresh: { type: 'string' },
  'project-trees': { type: 'boolean', default: false },
  only: { type: 'string', multiple: true },
});

/** The names `--only` accepts (ADR-0055): the quick, free live checks the
 *  live stage runs by default, and the slow proofs that run only when named.
 *  They live here, not in live-checks.mjs, so a usage error is caught without
 *  loading the checks; live-checks.mjs re-exports them. */
export const LIVE_CHECK_IDS = Object.freeze(['aqe-embedding', 'mcp', 'providers', 'security', 'memory']);
export const SLOW_PROOF_IDS = Object.freeze(['learning', 'harvest', 'aqe', 'memory-routes']);
const CHECK_NAMES = new Set([...LIVE_CHECK_IDS, ...SLOW_PROOF_IDS]);

/** The stage table, in run order; `runsAt` lists the strengths that run each
 *  stage. `local` runs last so its status rows include fresh live results. */
export const REFRESH_STAGES = Object.freeze([
  { id: 'machine', label: 'Measuring the machine', runsAt: ['machine'] },
  { id: 'maintenance', label: 'Refreshing Maintenance evidence', runsAt: ['local', 'live', 'machine'] },
  { id: 'inventory', label: 'Rebuilding the inventory', runsAt: ['local', 'live', 'machine'] },
  { id: 'live', label: 'Running live checks', runsAt: ['live'] },
  { id: 'local', label: 'Re-checking local evidence and versions', runsAt: ['local', 'live', 'machine'] },
].map((stage) => Object.freeze({ ...stage, runsAt: Object.freeze(stage.runsAt) })));

const LABEL = Object.freeze(Object.fromEntries(REFRESH_STAGES.map(({ id, label }) => [id, label])));

/** Stages that read the machine measurement: a failed measurement skips them,
 *  the same dependency the dashboard applies after a failed deep scan. */
const MEASUREMENT_DEPENDENTS = new Set(['maintenance', 'inventory']);

const STRENGTH_OF_VALUE = new Map([['', 'local'], ['local', 'local'], ['live', 'live'], ['machine', 'machine']]);

/**
 * parseArgs cannot express an optional value, so the exact token `--refresh`
 * becomes `--refresh=` (the bare, `local` strength). It never consumes the
 * next token and leaves everything after a `--` terminator alone.
 * @param {string[]} args
 * @returns {string[]}
 */
export function normalizeBareRefresh(args) {
  const end = args.indexOf('--');
  return args.map((arg, i) => (arg === '--refresh' && (end === -1 || i < end) ? '--refresh=' : arg));
}

/**
 * The checks `--only` names: comma lists split, blanks dropped, repeats kept
 * once, in the order named. Returns an error for an unknown name.
 * @param {string|string[]|undefined} raw
 * @returns {{ only: string[] } | { error: string }}
 */
function onlyFromFlag(raw) {
  const only = [...new Set([].concat(raw).flatMap((value) => String(value).split(','))
    .map((name) => name.trim()).filter(Boolean))];
  if (only.length === 0) return { error: '--only needs a check name' };
  const unknown = only.find((name) => !CHECK_NAMES.has(name));
  if (unknown === undefined) return { only };
  return { error: `--only: unknown check '${unknown}'; the live checks are ${LIVE_CHECK_IDS.join(', ')}; `
    + `the slow proofs are ${SLOW_PROOF_IDS.join(', ')}` };
}

/**
 * The refresh a command was asked for. `refresh: true` (a programmatic
 * caller) is the bare strength, like `--refresh` and `--refresh=local`.
 * `--only` names live checks, so it needs the `live` strength.
 * @param {Record<string, any>} [flags]
 * @returns {{ strength: null|'local'|'live'|'machine', projectTrees: boolean, only: string[] } | { error: string }}
 */
export function refreshRequestFromFlags(flags = {}) {
  const raw = flags.refresh;
  let strength = null;
  if (raw === true) strength = 'local';
  else if (raw != null && raw !== false) {
    strength = typeof raw === 'string' ? STRENGTH_OF_VALUE.get(raw) ?? null : null;
    if (!strength) return { error: `--refresh=${raw} is not a refresh strength: use --refresh alone, =live or =machine` };
  }
  const projectTrees = flags['project-trees'] === true;
  if (projectTrees && strength !== 'machine') return { error: '--project-trees needs --refresh=machine' };
  if (flags.only == null || (Array.isArray(flags.only) && flags.only.length === 0)) return { strength, projectTrees, only: [] };
  if (strength !== 'live') return { error: '--only needs --refresh=live' };
  const named = onlyFromFlag(flags.only);
  return 'error' in named ? named : { strength, projectTrees, only: named.only };
}

/**
 * The stage ids a strength runs, in order (none for no strength).
 * @param {string|null} strength
 * @returns {string[]}
 */
export function stagesFor(strength) {
  return REFRESH_STAGES.filter(({ runsAt }) => runsAt.includes(strength)).map(({ id }) => id);
}

/** Run one stage; a throw is a failed stage carrying the error's message. */
async function runStage(fn, ctx) {
  try {
    const outcome = await fn(ctx);
    if (typeof outcome?.ok !== 'boolean') return { ok: false, detail: 'the stage reported no outcome' };
    return { ok: outcome.ok, detail: outcome.detail ?? null, result: outcome.result };
  } catch (error) {
    return { ok: false, detail: error?.message ?? String(error) };
  }
}

/**
 * Run a strength's stages in order. A failed `machine` stage marks
 * `maintenance` and `inventory` skipped; any other failure leaves later stages
 * running, and `local` always runs. `ok` is false when any stage failed.
 *
 * `stages` maps each id to `(ctx) => Promise<{ ok, detail?, result? }>`, where
 * ctx is `{ strength, projectTrees, only, results }` and `results` holds the
 * results of the stages before it by id. `onStage` receives
 * `{ id, label, state: 'running'|'done'|'failed'|'skipped', detail, elapsedMs }`.
 * @param {{ strength: string, projectTrees?: boolean, only?: string[],
 *   stages: Record<string, (ctx: any) => Promise<any>>, onStage?: (event: any) => void, now?: () => number }} options
 * @returns {Promise<{ strength: string, ok: boolean,
 *   stages: Array<{ id: string, label: string, state: string, detail: string|null, elapsedMs: number, result?: any }> }>}
 */
export async function runRefresh({
  strength, projectTrees = false, only = [], stages, onStage = () => {}, now = Date.now,
}) {
  if (!REFRESH_STRENGTHS.includes(strength)) throw new TypeError(`unknown refresh strength: ${strength}`);
  const ids = stagesFor(strength);
  const missing = ids.filter((id) => typeof stages?.[id] !== 'function');
  if (missing.length) throw new TypeError(`no refresh stage for: ${missing.join(', ')}`);

  const results = {};
  const reported = [];
  let measurementFailed = false;
  for (const id of ids) {
    const label = LABEL[id];
    if (measurementFailed && MEASUREMENT_DEPENDENTS.has(id)) {
      const skipped = { id, label, state: 'skipped', detail: 'the machine measurement failed', elapsedMs: 0 };
      reported.push(skipped);
      onStage({ ...skipped });
      continue;
    }
    onStage({ id, label, state: 'running', detail: null, elapsedMs: 0 });
    const started = now();
    const outcome = await runStage(stages[id], { strength, projectTrees, only, results: { ...results } });
    const event = { id, label, state: outcome.ok ? 'done' : 'failed', detail: outcome.detail, elapsedMs: now() - started };
    if (id === 'machine' && !outcome.ok) measurementFailed = true;
    if (outcome.result !== undefined) results[id] = outcome.result;
    reported.push(outcome.result === undefined ? event : { ...event, result: outcome.result });
    onStage({ ...event });
  }
  return { strength, ok: reported.every(({ state }) => state !== 'failed'), stages: reported };
}

/** Memoize one lazily built collaborator, so every stage shares one instance. */
function once(make) {
  let promise;
  return () => (promise ||= Promise.resolve().then(make));
}

/** "2 passed, 1 failed" for the live stage's line. */
function liveSummary(results) {
  if (!Array.isArray(results) || results.length === 0) return 'no live check applies';
  const counts = new Map();
  for (const { status } of results) counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts].map(([status, n]) => `${n} ${status}`).join(', ');
}

/**
 * The CLI's stages over one shared collector, Maintenance service and
 * management facade, each built on first use (as the dashboard does). `deps`
 * may inject `collector`, `maintenance`, `management`, `collect` (status's row
 * collector) and `runLive` (the live checks). `maintenance` and `management`
 * are injected together or not at all: either one built by default uses the
 * default control root, so a caller that replaced only the other half would
 * still write real state (the dashboard refuses the same composition).
 * @param {{ cwd?: string, pkgRoot?: string, deps?: Record<string, any> }} options
 * @returns {Record<string, (ctx: any) => Promise<{ ok: boolean, detail?: string|null, result?: any }>>}
 */
export function cliRefreshStages({ cwd = process.cwd(), pkgRoot, deps = {} }) {
  if ((deps.maintenance == null) !== (deps.management == null)) {
    throw new TypeError('cliRefreshStages: inject maintenance and management together, or neither');
  }
  const collector = once(async () => deps.collector
    ?? (await import('./footprint/index.mjs')).createSystemCollector({ cwd }));
  const maintenance = once(async () => deps.maintenance
    ?? (await import('./maintenance/service.mjs')).createMaintenanceService({ collector: await collector() }));
  const management = once(async () => deps.management
    ?? (await import('./maintenance/management/service.mjs')).createManagementService({
      collector: await collector(), maintenance: await maintenance(),
      hookEvidence: (await import('./maintenance/management/hook-evidence.mjs')).collectHookEvidence,
    }));

  return {
    async machine({ projectTrees }) {
      const measuring = await collector();
      const result = await withProgress(LABEL.machine,
        () => measuring.refreshDeep(projectTrees ? { includeProjectTrees: true } : undefined));
      const measured = result?.ok === true && result.persisted?.ok !== false;
      return { ok: measured, detail: measured ? null : result?.error ?? 'the measurement did not finish', result };
    },
    async maintenance() {
      const model = await (await maintenance()).scan({ deep: false });
      const { providersChecked, providersTotal } = model?.scan ?? {};
      const detail = Number.isInteger(providersChecked) && Number.isInteger(providersTotal)
        ? `checked ${providersChecked} of ${providersTotal} providers` : null;
      return { ok: true, detail, result: model };
    },
    async inventory({ strength }) {
      const facade = await management();
      // After a measurement every discovery source is walked before the rebuild.
      const result = strength === 'machine'
        ? await withProgress(LABEL.inventory, () => facade.rebuildAfterMeasurement())
        : await facade.refreshInventory({ deep: false });
      return { ok: true, detail: null, result };
    },
    async live({ only }) {
      const { loadKitConfig } = await import('./config.mjs');
      const runLive = deps.runLive ?? (await import('./live-checks.mjs')).runLiveChecks;
      const results = await runLive({ cfg: loadKitConfig(), cwd, only });
      return { ok: true, detail: liveSummary(results), result: results };
    },
    async local() {
      const collect = deps.collect ?? (await import('../commands/status.mjs')).collect;
      const rows = await collect({ pkgRoot, cwd, refresh: true });
      return { ok: true, detail: null, result: rows };
    },
  };
}

/** "40 ms", "3 s", "2 min 5 s". */
export function formatElapsed(ms) {
  const whole = Math.max(0, Math.round(ms));
  if (whole < 1000) return `${whole} ms`;
  const seconds = Math.round(whole / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/**
 * The CLI renderer for `onStage`: one line per finished stage. A failed stage
 * is a warning line; the command's exit code reports the failure. The live
 * checks can take a minute with nothing else on screen, so their start gets a
 * dim line of its own (the machine stages show an elapsed-time ticker instead).
 * @param {{ id?: string, label: string, state: string, detail?: string|null, elapsedMs?: number }} event
 */
export function printRefreshStage({ id, label, state, detail = null, elapsedMs = 0 }) {
  const tail = detail ? `: ${detail}` : '';
  if (state === 'running' && id === 'live') console.log(dim(`${label}…`));
  else if (state === 'done') ok(`${label} (${formatElapsed(elapsedMs)})${tail}`);
  else if (state === 'failed') warn(`${label} failed (${formatElapsed(elapsedMs)})${tail}`);
  else if (state === 'skipped') info(`${label} skipped${tail}`);
}
