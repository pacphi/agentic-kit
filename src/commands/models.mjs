import { heading, info, ok, warn, dim } from '../lib/output.mjs';
import { loadKitConfig } from '../lib/config.mjs';
import { aqeRouterFile } from '../lib/providers.mjs';
import { readJson } from '../lib/settings.mjs';
import {
  appendModelSnapshot, collectModelSnapshot, createModelReadModel,
  diffSnapshotHistory, explainModel, latestSnapshot, modelInventoryPath, planModelChange,
  previousSnapshot, readModelStore, snapshotById, summarizeModelHealth,
} from '../lib/model-inventory/index.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  host: { type: 'string' },
  all: { type: 'boolean', default: false },
  online: { type: 'boolean', default: false },
  since: { type: 'string' },
  activity: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
};

export const help = `ak models — model lifecycle evidence, changes, and swap impact

Every command except refresh reads the private local snapshot cache and performs
no network requests. Refresh contacts only the named local/configured sources;
--online additionally permits OpenCode to refresh its catalog.

Usage:
  ak models status [--host claude|codex|opencode|ollama] [--json]
  ak models refresh [--host HOST|--all] [--online] [--dry-run]
  ak models diff [FROM_SNAPSHOT [TO_SNAPSHOT]] [--json]
  ak models explain HOST:MODEL [--json]
  ak models plan --activity ACTIVITY [--from HOST:MODEL] --to HOST:MODEL [--json]

The plan command is read-only. It may print a copyable canonical routing command,
but never changes routing, AQE, Ruflo, or provider configuration.

Examples:
  ak models refresh --all
  ak models status --host codex --json
  ak models diff models:before models:after
  ak models explain codex:gpt-5.6-terra
  ak models plan --activity testing --to codex:gpt-5.6-terra`;

const ALL_OWNERS = Object.freeze(['claude', 'codex', 'opencode', 'ollama']);

function selectedOwners(flags, cfg) {
  if (flags.host) {
    const owners = [...new Set(String(flags.host).split(',').map((value) => value.trim()).filter(Boolean))];
    for (const owner of owners) if (!ALL_OWNERS.includes(owner)) throw new TypeError(`unsupported model host: ${owner}`);
    return owners;
  }
  if (flags.all) return [...ALL_OWNERS];
  const enabled = Object.entries(cfg?.integrations?.hosts ?? {})
    .filter(([, value]) => value === true).map(([owner]) => owner).filter((owner) => ALL_OWNERS.includes(owner));
  return enabled.length ? enabled : ['claude'];
}

function printJson(value) { console.log(JSON.stringify(value, null, 2)); }

function visibleSnapshot(snapshot, host) {
  if (!snapshot || !host) return snapshot;
  return {
    ...snapshot,
    sources: snapshot.sources.filter((source) => source.owner === host),
    models: snapshot.models.filter((model) => model.key.host === host),
    bindings: snapshot.bindings.filter((binding) => binding.host === host),
  };
}

function selectedPair(store, positionals, flags) {
  const fromId = flags.from ?? positionals[1];
  const toId = flags.to ?? positionals[2];
  const after = toId ? snapshotById(store, toId) : latestSnapshot(store);
  const before = fromId ? snapshotById(store, fromId)
    : previousSnapshot(store, after);
  return { before, after, fromId, toId };
}

function noSnapshot(flags, cacheFile) {
  const result = { status: 'empty', cacheFile, snapshot: null, hint: 'ak models refresh' };
  if (flags.json) printJson(result);
  else {
    heading('ak models — offline lifecycle inventory');
    info('No local model snapshot yet.');
    info('Refresh explicitly: ak models refresh');
  }
  return 0;
}

/** `ak models refresh` — the only action that contacts sources / writes the
 *  cache; every other action is a pure read over the existing snapshot store. */
async function runRefresh(ctx) {
  const { flags, cfg, cacheFile, append, collect, deps } = ctx;
  const owners = selectedOwners(flags, cfg);
  const onlineContact = Boolean(flags.online && owners.includes('opencode'));
  if (flags['dry-run']) {
    const result = { dryRun: true, action: 'refresh', owners, online: onlineContact,
      onlineRequested: flags.online, network: false, writes: false, cacheFile };
    if (flags.json) printJson(result);
    else {
      heading('ak models — refresh plan (dry-run)');
      info(`Would inspect: ${owners.join(', ')}.`);
      info(onlineContact ? 'OpenCode catalog refresh would be permitted.'
        : 'No online catalog refresh would be contacted.');
      info(dim('No source was contacted and no file was written.'));
    }
    return 0;
  }
  const aqeConfig = (deps.readJson ?? readJson)((deps.aqeFile ?? aqeRouterFile)(process.cwd()));
  const snapshot = await collect({
    config: cfg, aqeConfig, rufloConfig: cfg, scope: { project: process.cwd() },
    discoveryOptions: { owners, online: flags.online, cwd: process.cwd() },
  });
  const store = append(snapshot, { file: cacheFile });
  const result = { status: 'refreshed', cacheFile, contacts: owners, online: onlineContact,
    onlineRequested: flags.online,
    snapshot: createModelReadModel(snapshot), retainedSnapshots: store.snapshots.length };
  if (flags.json) printJson(result);
  else {
    const health = summarizeModelHealth(snapshot);
    ok(`Model inventory refreshed: ${snapshot.models.length} model(s) · ${snapshot.sources.length} source(s)`);
    info(health.message);
    info(dim(`private cache: ${cacheFile}`));
  }
  return 0;
}

function runStatus(ctx) {
  const { flags, cacheFile, store, latest } = ctx;
  if (flags.host && !ALL_OWNERS.includes(flags.host)) {
    warn(`unsupported model host: ${flags.host}`);
    return 2;
  }
  const snapshot = visibleSnapshot(latest, flags.host);
  const since = flags.since ? Date.parse(flags.since) : null;
  const history = store.snapshots.filter((entry) => entry.scope.fingerprint === latest.scope.fingerprint
    && (!Number.isFinite(since) || Date.parse(entry.capturedAt) >= since));
  const result = { status: 'cached', cacheFile, health: summarizeModelHealth(snapshot),
    inventory: createModelReadModel(snapshot), history: history.map(({ snapshotId, capturedAt }) => ({ snapshotId, capturedAt })) };
  if (flags.json) printJson(result);
  else {
    heading('ak models — offline lifecycle inventory');
    const health = result.health;
    (health.level === 'ok' ? ok : warn)(health.message);
    for (const source of snapshot.sources) info(`${source.id}: ${source.status} · ${source.capturedAt}`);
    info(dim(`snapshot ${snapshot.snapshotId} · ${history.length} retained same-scope capture(s)`));
  }
  return 0;
}

function runDiff(ctx) {
  const { store, positionals, flags } = ctx;
  const { before, after, fromId, toId } = selectedPair(store, positionals, flags);
  if (!before || !after) {
    const missing = !before ? fromId ?? 'same-scope baseline' : toId ?? 'latest snapshot';
    if (flags.json) printJson({ comparable: false, reason: 'snapshot-not-found', missing });
    else warn(`Cannot diff: ${missing} not found.`);
    return 1;
  }
  const result = diffSnapshotHistory(before, after, store.snapshots);
  if (flags.json) printJson(result);
  else {
    heading(`ak models diff — ${before.snapshotId} → ${after.snapshotId}`);
    if (!result.comparable) warn(result.diagnostics.join('; '));
    else if (!result.changes.length) ok('No model lifecycle changes.');
    else for (const change of result.changes) info(`${change.kind}: ${change.subject}${change.provisional ? ' (provisional)' : ''}`);
    for (const message of result.diagnostics) info(dim(message));
  }
  return result.comparable ? 0 : 1;
}

function runExplain(ctx) {
  const { positionals, flags, latest } = ctx;
  const selector = positionals[1] ?? flags.to;
  if (!selector) { warn('usage: ak models explain HOST:MODEL'); return 2; }
  const result = explainModel(latest, selector);
  if (flags.json) printJson(result);
  else if (!result.found) warn(`Model not found: ${selector}`);
  else {
    heading(`ak models explain — ${selector}`);
    for (const match of result.matches) {
      info(`${match.key.host}${match.key.provider ? `/${match.key.provider}` : ''}: ${match.key.modelId}`);
      for (const [name, dimension] of Object.entries(match.dimensions)) info(`  ${name}: ${dimension.value ?? 'unknown'}`);
      info(`  lifecycle: ${match.lifecycle.state}${match.lifecycle.replacement ? ` → ${match.lifecycle.replacement}` : ''}`);
    }
  }
  return result.found ? 0 : 1;
}

function runPlan(ctx) {
  const { flags, positionals, latest } = ctx;
  const activity = flags.activity;
  const to = flags.to ?? positionals[1];
  if (!activity || !to) { warn('usage: ak models plan --activity ACTIVITY [--from HOST:MODEL] --to HOST:MODEL'); return 2; }
  const result = planModelChange(latest, { activity, from: flags.from, to });
  if (flags.json) printJson(result);
  else {
    heading(`ak models plan — ${activity}`);
    if (!result.plannable) warn(`No mechanical plan: ${result.reason ?? result.compatibility?.blockers?.join('; ')}`);
    else {
      ok('Mechanical compatibility is supported by current evidence. Quality equivalence remains unknown.');
      info(`Copy to apply explicitly: ${result.action.command}`);
    }
  }
  return result.plannable ? 0 : 1;
}

// Actions after 'refresh' are pure reads over the existing snapshot store —
// dispatched by name once that store/latest snapshot is in hand (below).
const READ_ACTIONS = { status: runStatus, diff: runDiff, explain: runExplain, plan: runPlan };

/** @param {{flags: Record<string, any>, positionals: string[], deps?: Record<string, any>}} input */
export async function run({ flags, positionals, deps = {} }) {
  const action = positionals[0] ?? 'status';
  const cacheFile = deps.cacheFile ?? modelInventoryPath();
  const readStore = deps.readStore ?? readModelStore;
  const append = deps.append ?? appendModelSnapshot;
  const collect = deps.collect ?? collectModelSnapshot;
  const loadConfig = deps.loadConfig ?? loadKitConfig;
  const cfg = loadConfig();
  const ctx = { flags, positionals, deps, cacheFile, readStore, append, collect, cfg };

  if (action === 'refresh') return runRefresh(ctx);

  const store = readStore({ file: cacheFile });
  const latest = latestSnapshot(store);
  if (!latest) return noSnapshot(flags, cacheFile);

  const handler = READ_ACTIONS[action];
  if (!handler) { warn('usage: ak models status|refresh|diff|explain|plan'); return 2; }
  return handler({ ...ctx, store, latest });
}
