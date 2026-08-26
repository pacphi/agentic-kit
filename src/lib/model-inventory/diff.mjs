import { isCompleteStableSnapshot, modelIdentityKey, normalizeSnapshot } from './contracts.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const evidenceRefs = (model, prefix) => model.evidence
  .filter((entry) => entry.field === prefix || entry.field.startsWith(`${prefix}.`))
  .map(({ id }) => id);

function change(kind, model, before, after, {
  severity = 'info', field = kind, provisional = false,
} = {}) {
  return {
    kind,
    subject: model.identity,
    before: structuredClone(before),
    after: structuredClone(after),
    severity,
    provisional,
    evidenceRefs: evidenceRefs(model, field),
  };
}

function aliasTargets(model) {
  return Object.fromEntries(model.aliases.map(({ name, resolvesTo }) => [name, resolvesTo]));
}

const lifecycleFacts = ({ state, replacement, notice, effectiveAt }) => (
  { state, replacement, notice, effectiveAt }
);
const pricingFacts = (pricing) => pricing == null ? null : ({
  basis: pricing.basis, input: pricing.input, output: pricing.output,
  currency: pricing.currency, effectiveAt: pricing.effectiveAt,
});
const edgeFacts = (edges) => edges.map(({ kind, from, to, provenance, scopeFingerprint }) => (
  { kind, from, to, provenance, scopeFingerprint }
));

function fieldChanges(before, after, provisional) {
  const out = [];
  const oldAliases = aliasTargets(before);
  const newAliases = aliasTargets(after);
  for (const name of new Set([...Object.keys(oldAliases), ...Object.keys(newAliases)])) {
    if (oldAliases[name] !== newAliases[name]) {
      out.push(change('alias-target-changed', after,
        { name, resolvesTo: oldAliases[name] ?? null },
        { name, resolvesTo: newAliases[name] ?? null },
        { severity: 'warn', field: 'aliases', provisional }));
    }
  }
  if (!equal(lifecycleFacts(before.lifecycle), lifecycleFacts(after.lifecycle))) {
    out.push(change('lifecycle-changed', after, before.lifecycle, after.lifecycle,
      { severity: after.lifecycle.state === 'removed' ? 'fail' : 'warn', field: 'lifecycle', provisional }));
  }
  if (before.visibility !== after.visibility) {
    out.push(change('visibility-changed', after, before.visibility, after.visibility,
      { severity: 'warn', field: 'visibility', provisional }));
  }
  const capabilityNames = new Set([
    ...Object.keys(before.capabilities), ...Object.keys(after.capabilities),
  ]);
  for (const field of capabilityNames) {
    if (!equal(before.capabilities[field], after.capabilities[field])) {
      out.push(change('capability-changed', after,
        { field, value: before.capabilities[field] ?? null },
        { field, value: after.capabilities[field] ?? null },
        { severity: 'warn', field: `capabilities.${field}`, provisional }));
    }
  }
  const variantNames = new Set([
    ...Object.keys(before.variant), ...Object.keys(after.variant),
  ]);
  for (const field of variantNames) {
    if (!equal(before.variant[field], after.variant[field])) {
      const kind = field === 'digest' ? 'digest-changed'
        : /reasoning/i.test(field) ? 'reasoning-changed'
          : /context/i.test(field) ? 'context-changed' : 'variant-changed';
      out.push(change(kind, after,
        { field, value: before.variant[field] ?? null },
        { field, value: after.variant[field] ?? null },
        { severity: 'warn', field: `variant.${field}`, provisional }));
    }
  }
  if (before.key.digest !== after.key.digest && !variantNames.has('digest')) {
    out.push(change('digest-changed', after, before.key.digest, after.key.digest,
      { severity: 'warn', field: 'key.digest', provisional }));
  }
  if (!equal(pricingFacts(before.pricing), pricingFacts(after.pricing))) {
    out.push(change('pricing-changed', after, before.pricing, after.pricing,
      { severity: 'info', field: 'pricing', provisional }));
  }
  if (!equal(edgeFacts(before.edges), edgeFacts(after.edges))) {
    out.push(change('edges-changed', after, before.edges, after.edges,
      { severity: 'info', field: 'edges', provisional }));
  }
  return out;
}

function sharedAlias(before, after) {
  const oldAliases = new Map(before.aliases.map((alias) => [alias.name, alias.resolvesTo]));
  return after.aliases.some((alias) => oldAliases.has(alias.name)
    && oldAliases.get(alias.name) !== alias.resolvesTo);
}

const baseIdentity = (model) => modelIdentityKey({ ...model.key, digest: null });

function pairModels(before, after) {
  const oldModels = new Map(before.models.map((model) => [model.identity, model]));
  const newModels = new Map(after.models.map((model) => [model.identity, model]));
  const usedOld = new Set();
  const usedNew = new Set();
  const pairs = [];
  for (const [identity, model] of newModels) {
    const prior = oldModels.get(identity);
    if (!prior) continue;
    pairs.push([prior, model]); usedOld.add(prior.identity); usedNew.add(model.identity);
  }
  for (const model of newModels.values()) {
    if (usedNew.has(model.identity)) continue;
    const prior = [...oldModels.values()].find((candidate) => !usedOld.has(candidate.identity)
      && (sharedAlias(candidate, model) || baseIdentity(candidate) === baseIdentity(model)));
    if (!prior) continue;
    pairs.push([prior, model]); usedOld.add(prior.identity); usedNew.add(model.identity);
  }
  return { oldModels, newModels, pairs, usedOld, usedNew };
}

export function diffSnapshots(beforeValue, afterValue, {
  absenceCounts = {}, authoritativeRemovals = [], removalThreshold = 2,
} = {}) {
  const before = normalizeSnapshot(beforeValue);
  const after = normalizeSnapshot(afterValue);
  if (before.scope.fingerprint !== after.scope.fingerprint) {
    return {
      comparable: false,
      reason: 'scope-changed',
      beforeSnapshotId: before.snapshotId,
      afterSnapshotId: after.snapshotId,
      changes: [],
      diagnostics: ['snapshot scopes differ; lifecycle comparison refused'],
    };
  }

  const complete = isCompleteStableSnapshot(before) && isCompleteStableSnapshot(after);
  const { oldModels, newModels, pairs, usedOld, usedNew } = pairModels(before, after);
  const changes = [];
  for (const [prior, model] of pairs) changes.push(...fieldChanges(prior, model, !complete));
  for (const [identity, model] of newModels) {
    if (!usedNew.has(identity)) {
      changes.push(change('model-added', model, null, model.key,
        { field: 'key', provisional: !complete }));
    }
  }
  if (complete) {
    const authoritative = new Set(authoritativeRemovals);
    for (const [identity, model] of oldModels) {
      if (!usedOld.has(identity)) {
        const absenceCount = Number(absenceCounts[identity] ?? 1);
        const removed = authoritative.has(identity) || absenceCount >= removalThreshold;
        changes.push(change(removed ? 'model-removed' : 'model-missing', model, model.key, null,
          { severity: 'warn', field: 'key', provisional: !removed }));
      }
    }
  }

  const diagnostics = [];
  if (!complete) diagnostics.push('incomplete or stale evidence suppressed model removals');
  if (changes.some(({ kind }) => kind === 'model-missing')) {
    diagnostics.push(`model absence is provisional until ${removalThreshold} complete same-scope snapshots`);
  }
  for (const source of after.sources.filter(({ status }) => status !== 'complete')) {
    diagnostics.push(`${source.id}: ${source.status}`);
  }
  return {
    comparable: true,
    reason: null,
    beforeSnapshotId: before.snapshotId,
    afterSnapshotId: after.snapshotId,
    changes,
    diagnostics: [...new Set(diagnostics)],
  };
}

/**
 * Compare two snapshots while carrying repeated-absence evidence across the
 * retained same-scope history. This lets a second complete absence become a
 * removal even though the immediately previous snapshot no longer contains the
 * model record.
 */
export function diffSnapshotHistory(beforeValue, afterValue, snapshots = [], options = {}) {
  const before = normalizeSnapshot(beforeValue);
  const after = normalizeSnapshot(afterValue);
  const result = diffSnapshots(before, after, options);
  if (!result.comparable || !isCompleteStableSnapshot(after)) return result;

  const ordered = snapshots
    .map((value, index) => ({ snapshot: normalizeSnapshot(value), index }))
    .filter(({ snapshot }) => snapshot.scope.fingerprint === after.scope.fingerprint
      && isCompleteStableSnapshot(snapshot)
      && Date.parse(snapshot.capturedAt) <= Date.parse(after.capturedAt))
    .sort((a, b) => Date.parse(a.snapshot.capturedAt) - Date.parse(b.snapshot.capturedAt)
      || a.index - b.index)
    .map(({ snapshot }) => snapshot);
  if (!ordered.some(({ snapshotId }) => snapshotId === after.snapshotId)) ordered.push(after);

  const identities = new Set(ordered.flatMap((snapshot) => snapshot.models.map((model) => model.identity)));
  const afterIds = new Set(after.models.map((model) => model.identity));
  const removalThreshold = Number(options.removalThreshold ?? 2);
  const authoritative = new Set(options.authoritativeRemovals ?? []);

  for (const identity of identities) {
    if (afterIds.has(identity)) continue;
    let lastKnown = null;
    let absenceCount = 0;
    for (const snapshot of ordered) {
      const present = snapshot.models.find((model) => model.identity === identity);
      if (present) {
        lastKnown = present;
        absenceCount = 0;
      } else if (lastKnown) absenceCount++;
    }
    if (!lastKnown || (!authoritative.has(identity) && absenceCount < removalThreshold)) continue;
    const aliasContinues = lastKnown.aliases.some((oldAlias) => after.models.some((model) =>
      model.aliases.some((alias) => alias.name === oldAlias.name)));
    if (aliasContinues) continue;
    const existing = result.changes.findIndex((entry) => entry.subject === identity
      && (entry.kind === 'model-missing' || entry.kind === 'model-removed'));
    const removal = change('model-removed', lastKnown, lastKnown.key, null,
      { severity: 'warn', field: 'key', provisional: false });
    if (existing >= 0) result.changes.splice(existing, 1, removal);
    else result.changes.push(removal);
  }
  if (!result.changes.some(({ kind }) => kind === 'model-missing')) {
    result.diagnostics = result.diagnostics.filter((message) => !message.startsWith('model absence is provisional'));
  }
  return result;
}
