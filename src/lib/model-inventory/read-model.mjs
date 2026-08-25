import { immutable } from '../adapters/schema.mjs';
import { normalizeSnapshot } from './contracts.mjs';

/** @param {any} snapshotValue @param {{changes?: any[]|{changes?: any[]}}} [options] */
export function createModelReadModel(snapshotValue, options = {}) {
  const { changes } = options;
  const snapshot = normalizeSnapshot(snapshotValue);
  const changeRows = Array.isArray(changes) ? changes
    : Array.isArray(changes?.changes) ? changes.changes : snapshot.changes;
  const configuredBindings = snapshot.bindings.filter(({ configured }) => configured != null);
  const observed = snapshot.models.filter(({ dimensions }) => dimensions.observed.value === true);
  const migrations = snapshot.models.filter(({ lifecycle }) => lifecycle.replacement != null);
  const aliasChanges = changeRows.filter(({ kind }) => kind === 'alias-target-changed');
  const staleSources = snapshot.sources.filter(({ status }) => status !== 'complete');
  const driftedConsumers = snapshot.bindings.filter(({ drift }) => drift);
  const attention = [
    ...staleSources.map((source) => ({ kind: 'source', severity: 'warn', subject: source.id, reason: source.status })),
    ...migrations.map((model) => ({
      kind: 'migration', severity: 'warn', subject: model.identity,
      reason: `${model.lifecycle.state} → ${model.lifecycle.replacement}`,
    })),
    ...aliasChanges.map((entry) => ({ kind: 'alias', severity: entry.severity, subject: entry.subject, reason: entry.kind })),
    ...driftedConsumers.map((binding) => ({ kind: 'consumer', severity: 'warn', subject: binding.id, reason: 'projection drift' })),
  ];
  return immutable({
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    scope: snapshot.scope,
    counts: {
      models: snapshot.models.length,
      configured: configuredBindings.length,
      observed: observed.length,
      migrations: migrations.length,
      aliasChanges: aliasChanges.length,
      staleSources: staleSources.length,
      driftedConsumers: driftedConsumers.length,
    },
    sources: snapshot.sources,
    models: snapshot.models,
    bindings: snapshot.bindings,
    changes: changeRows,
    attention,
    diagnostics: snapshot.diagnostics,
  });
}

export function summarizeModelHealth(snapshotValue, options = {}) {
  const model = createModelReadModel(snapshotValue, options);
  const level = model.attention.some(({ severity }) => severity === 'fail') ? 'fail'
    : model.attention.length ? 'warn' : 'ok';
  const sourceAt = model.sources.map(({ capturedAt }) => capturedAt).filter(Boolean).sort().at(-1)
    ?? model.capturedAt;
  return immutable({
    level,
    message: `${model.counts.configured} configured · ${model.counts.observed} observed · `
      + `${model.counts.migrations} migrations · ${model.counts.aliasChanges} alias changes · catalog ${sourceAt}`,
    fix: model.counts.staleSources ? 'ak models refresh' : model.counts.migrations || model.counts.aliasChanges
      ? 'ak models diff' : null,
    counts: model.counts,
    capturedAt: model.capturedAt,
  });
}
