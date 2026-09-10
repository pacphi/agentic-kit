// ADR-0048 Guidance admission (MNT-GUD-*, MNT-ACT-010..012, domain-model.md
// "Conditions, Guidance, and actions").
//
// `admitGuidance` is the ONLY place a verified condition becomes a
// GuidanceEntry. It is pure and synchronous: `providers` is the maintenance
// provider registry, `detections` are ALREADY-CALLED `detect()` facts keyed
// by provider id (this module never calls `detect()` itself), `receipts` are
// already-loaded receipts, `recipes` is the candidate procedure catalogue,
// `dispositions` is the ALREADY time-filtered active-dispositions list, and
// `mutationBlocks` are already-computed write blocks. It returns a NEW
// inventory (never mutates its argument) with `guidanceEntries` populated and
// each placement's `guidanceLane` set to its highest-priority admitted lane.
import {
  CONDITION_LABELS, CONFLICT_EXPLANATIONS, INVENTORY_GROUP_ORDER, NO_ACTION_REQUESTED_DETAIL,
  RESOURCE_KIND_LABELS, opaqueId,
} from './model.mjs';
import { findCompatibleRecipes } from './recipes.mjs';
import { UNFINISHED_MAINTENANCE_STATUSES } from '../transaction-store.mjs';
import { isOptionalManagement, recommendationEntries, normalizeGuidanceInventory } from './guidance-purpose.mjs';
import { inspectorRelationships } from './inspector-relationships.mjs';
import { guidanceCoverage } from './guidance-coverage.mjs';
import { hostAlignmentMatcher } from './host-alignment.mjs';

const DEPENDENCY_EDGE_KINDS = Object.freeze([
  'requires-executable', 'requires-runtime', 'requires-provider', 'requires-credential',
]);

// `unknown-recovery-required` is a separate sentinel (an unreadable/corrupt
// receipt row) that must still surface here alongside the mid-flight
// statuses transaction-store.mjs enumerates.
function isUnfinishedReceiptStatus(status) {
  return UNFINISHED_MAINTENANCE_STATUSES.has(status) || status === 'unknown-recovery-required';
}

const VERB_SENTENCE = Object.freeze({
  update: 'Update', disable: 'Disable', remove: 'Remove', reinstall: 'Reinstall',
  'clean-cache': 'Clean cache for', restore: 'Restore', archive: 'Archive',
  'apply-project-patch': 'Apply the project patch for',
});

/** No verified operation, procedure, or bounded decision exists for this
 *  condition (MNT-EVD-007, MNT-GUD-003). */
export function remedyFreeInspector() {
  return NO_ACTION_REQUESTED_DETAIL;
}

// ── Context indexes (built once per call) ──────────────────────────────────

function pushInto(map, key, value) {
  const arr = map.get(key);
  if (arr) arr.push(value); else map.set(key, [value]);
}

function buildGuidanceContext({ inventory, providers, detections, receipts, recipes, channelPolicy }) {
  const placementsById = new Map(inventory.placements.map((p) => [p.placementId, p]));
  const resourcesById = new Map(inventory.resources.map((r) => [r.resourceId, r]));
  const artifactsById = new Map(inventory.artifacts.map((a) => [a.artifactId, a]));
  const environmentsById = new Map(inventory.environments.map((e) => [e.environmentId, e]));
  const dependencyEdgesByFrom = new Map();
  for (const edge of inventory.dependencyEdges ?? []) pushInto(dependencyEdgesByFrom, edge.fromPlacementId, edge);
  const versionObsByPlacement = new Map();
  for (const observation of inventory.versionObservations ?? []) pushInto(versionObsByPlacement, observation.subjectId, observation);
  return {
    inventory, placementsById, resourcesById, artifactsById, dependencyEdgesByFrom,
    versionObsByPlacement, providers, detections, receipts, recipes, channelPolicy: channelPolicy ?? {},
    environmentFor: (placement) => environmentsById.get(placement.environmentId) ?? null,
  };
}

// ── Apply lane: provider-capability matchers ────────────────────────────────
// Each matcher answers "is THIS exact placement eligible for a verb, given
// already-detected `detect()` facts" using the REAL identity fields each
// provider's own `actionRequest`/`actionFor` checks — grounded in
// tests/kit/maintenance-provider-conformance.test.mjs,
// maintenance-owned-providers.test.mjs, maintenance-git-project-patch.test.mjs,
// and maintenance-model-removal.test.mjs, not the provider's JSDoc alone. A
// match requires detection `status:'available'` + `complete:true` PLUS an
// exact identity match on every field the provider itself checks (kind,
// host, scope, and a ref/name it can prove) — never a name-only guess. Every
// admitted candidate records `findingResourceKey: {kind, id, host, scope}`,
// the exact tuple the facade uses to locate the authoritative finding at
// plan time; this module never constructs a legacy finding object itself.

// claude-plugin's legacy scope vocabulary (user/project/local) predates and
// differs from ManagementInventory's administrativeScope (system/machine/
// user/project). 'system' has no established equivalent and is refused.
const LEGACY_SCOPE_FOR = Object.freeze({ user: 'user', project: 'project', machine: 'local' });

function refFor(placement, resource) {
  return resource?.namespace ? `${placement.displayName}@${resource.namespace}` : placement.displayName;
}

/** claude-plugin.mjs actionableRequest: kind==='plugin', host==='claude',
 *  a validPluginRef providerRef, and a validScope (user/project/local).
 *  Only `disable` is offered here — `update`/`remove` additionally require
 *  the legacy catalog-diff signal (`base.nextAction.operation`) this module
 *  does not independently recompute. */
function claudePluginMatcher(placement, facts, ctx) {
  if (placement.kind !== 'plugin' || !(placement.consumerHosts ?? []).includes('claude')) return null;
  if (facts?.status !== 'available' || facts.complete !== true) return null;
  const scope = LEGACY_SCOPE_FOR[placement.administrativeScope];
  if (!scope) return null;
  const ref = refFor(placement, ctx.resourcesById.get(placement.resourceId));
  const plugin = facts.plugins?.find((p) => p.ref === ref && p.scope === scope);
  if (!plugin || !plugin.enabled) return null;
  return {
    verb: 'disable', operation: 'disable',
    verifiedPremises: ['placement', 'installedVersion', 'consumers', 'impact'],
    impact: { summary: `Claude stops loading ${placement.displayName} until it is enabled again.` },
    preserved: ['Plugin data', 'Other plugins'],
    findingResourceKey: { kind: 'plugin', id: `plugin:claude:${ref}:${scope}`, host: 'claude', scope },
  };
}

/** codex-plugin.mjs actionFor: kind==='plugin', host==='codex', a
 *  validPluginRef, and `plugin.installed === true` (enabled state is NOT
 *  checked — removal is offered whether the plugin is enabled or not). The
 *  provider's only operation is `remove`. */
function codexPluginMatcher(placement, facts, ctx) {
  if (placement.kind !== 'plugin' || !(placement.consumerHosts ?? []).includes('codex')) return null;
  if (facts?.status !== 'available' || facts.complete !== true) return null;
  const ref = refFor(placement, ctx.resourcesById.get(placement.resourceId));
  const plugin = facts.plugins?.find((p) => p.ref === ref);
  if (!plugin || !plugin.installed) return null;
  return {
    verb: 'remove', operation: 'remove',
    verifiedPremises: ['placement', 'installedVersion'],
    impact: { summary: `Removes ${placement.displayName} from Codex.` },
    preserved: ['Other Codex plugins'],
    findingResourceKey: { kind: 'plugin', id: `plugin:codex:${ref}`, host: 'codex', scope: 'user' },
  };
}

/** codex-mcp.mjs actionFor: kind==='mcpServer', host==='codex',
 *  scope==='user' (hardcoded), and a registered server by exact name — no
 *  `enabled` gate for removal. The provider's only operation is `remove`. */
function codexMcpMatcher(placement, facts) {
  if (placement.kind !== 'mcp-registration' || !(placement.consumerHosts ?? []).includes('codex')) return null;
  if (placement.administrativeScope !== 'user') return null;
  if (facts?.status !== 'available' || facts.complete !== true) return null;
  const server = facts.servers?.find((s) => s.name === placement.displayName);
  if (!server) return null;
  return {
    verb: 'remove', operation: 'remove',
    verifiedPremises: ['placement', 'consumers'],
    impact: { summary: `Removes the ${placement.displayName} MCP registration from Codex.` },
    preserved: ['Every other MCP registration'],
    findingResourceKey: { kind: 'mcpServer', id: `mcp:codex:${placement.displayName}`, host: 'codex', scope: 'user' },
  };
}

/** Contract: `detections.get('agentic-kit-npx-cache')` → `{ status,
 *  complete, candidates: [{ resourceId, executable, sourceFingerprint,
 *  placementId }] }`. `resourceId` (format `stale-npx-env:<leaf>`) is
 *  derived from a storage candidate this module never sees directly, so
 *  matching correlates via an explicit `placementId` the facade must add
 *  once it links a cache placement to its storage candidate; `resourceId`
 *  is then copied verbatim into `findingResourceKey`, never reconstructed. */
function npxCacheMatcher(placement, facts) {
  if (placement.kind !== 'cache' || facts?.status !== 'available' || facts.complete !== true) return null;
  const candidate = facts.candidates?.find((c) => c.placementId === placement.placementId);
  if (!candidate || candidate.executable !== true) return null;
  return {
    verb: 'clean-cache', operation: 'clean',
    verifiedPremises: ['placement', 'impact'],
    impact: {
      summary: Number.isFinite(candidate.bytesReclaimable)
        ? `Reclaims about ${formatBytes(candidate.bytesReclaimable)}.`
        : 'Reclaims reproducible cached data.',
    },
    preserved: ['Other caches'],
    findingResourceKey: { kind: 'stale-npx-env', id: candidate.resourceId, host: 'agentic-kit', scope: 'machine' },
  };
}

/** Contract: `detections.get('ruflo-mcp-orphan')` → `{ status, complete,
 *  capability: { status }, orphans: [{ resourceId, pid, executable,
 *  placementId }] }`. `resourceId` (`ruflo-mcp-orphan:<pid>`) is copied
 *  verbatim once correlated via an explicit `placementId` the facade must
 *  add. */
function rufloOrphanMatcher(placement, facts) {
  if (!(placement.conditions ?? []).includes('orphaned-process')) return null;
  if (facts?.status !== 'available' || facts.complete !== true || facts.capability?.status !== 'available') return null;
  const orphan = facts.orphans?.find((o) => o.placementId === placement.placementId);
  if (!orphan || orphan.executable !== true) return null;
  return {
    verb: 'remove', operation: 'terminate',
    verifiedPremises: ['placement', 'impact'],
    impact: { summary: 'Terminates only this orphaned process; the registration it leaked from is unaffected.' },
    preserved: ['Every other process', 'The originating registration'],
    findingResourceKey: { kind: 'daemon', id: orphan.resourceId, host: 'ruflo', scope: 'machine' },
  };
}

/** Contract: `detections.get('agentic-kit-owned-skill')` → `{ status,
 *  complete, skills: [{ resourceId, scope, status, executable,
 *  sourceFingerprint, placementId }] }`. `owned-current` + `executable`
 *  mirrors the provider's own `findings()` admission gate exactly.
 *  `resourceId` (receipt-derived, opaque) is copied verbatim once
 *  correlated via an explicit `placementId` the facade must add. */
function ownedSkillMatcher(placement, facts) {
  if (placement.kind !== 'skill' || !['user', 'project'].includes(placement.administrativeScope)) return null;
  if (facts?.status !== 'available' || facts.complete !== true) return null;
  const skill = facts.skills?.find((s) => s.placementId === placement.placementId);
  if (!skill || skill.status !== 'owned-current' || skill.executable !== true) return null;
  return {
    verb: 'archive', operation: 'archive',
    verifiedPremises: ['placement', 'impact'],
    impact: { summary: `Archives the exact unchanged ${placement.displayName} skill tree; it can be restored later.` },
    preserved: [`${placement.displayName} restore point`],
    findingResourceKey: { kind: 'skill', id: skill.resourceId, host: 'agentic-kit', scope: skill.scope },
  };
}

/** Contract: `detections.get('git-project-patch')` → `{ status, complete,
 *  patches: [{ resourceId, status, placementId }] }`, where
 *  `status === 'matches-preimage'` is the only executable state (mirrors
 *  `actionFor`'s own gate). `resourceId` is externally configured and
 *  copied verbatim once correlated via an explicit `placementId` the
 *  facade must add. */
function gitProjectPatchMatcher(placement, facts) {
  if (placement.administrativeScope !== 'project') return null;
  if (facts?.status !== 'available' || facts.complete !== true) return null;
  const patch = facts.patches?.find((p) => p.placementId === placement.placementId);
  if (!patch || patch.status !== 'matches-preimage') return null;
  return {
    verb: 'apply-project-patch', operation: 'apply-project-patch',
    verifiedPremises: ['placement', 'impact'],
    impact: { summary: 'Applies a bounded patch to the exact target file; unrelated dirty files are unaffected.' },
    preserved: ['Unrelated project files', 'Git history'],
    findingResourceKey: { kind: 'project-file', id: patch.resourceId, host: 'agentic-kit', scope: 'project' },
  };
}

/** ollama-model-remove.mjs detect(): `{ status, complete, tags: [{ name,
 *  digest, sizeBytes }], loaded: [{ name }] }`. Identity is the exact model
 *  `name` (the provider's own resource id/name are both the model name);
 *  a placement-carried digest is cross-checked when present. A model
 *  present in `loaded` refuses removal (MNT-MDL-002). */
function ollamaModelMatcher(placement, facts, ctx) {
  if (placement.kind !== 'model' || facts?.status !== 'available' || facts.complete !== true) return null;
  const tag = facts.tags?.find((t) => t.name === placement.displayName);
  if (!tag) return null;
  if (placement.versions?.contentDigest && placement.versions.contentDigest !== tag.digest) return null;
  if (facts.loaded?.some((l) => l.name === placement.displayName)) return null;
  const artifact = ctx.artifactsById.get(placement.artifactIds?.[0]);
  const bytes = Number.isFinite(artifact?.physicalBytes) ? artifact.physicalBytes : tag.sizeBytes;
  return {
    verb: 'remove', operation: 'remove',
    verifiedPremises: ['placement', 'consumers', 'impact', 'installedVersion'],
    impact: {
      summary: Number.isFinite(bytes)
        ? `Removes one Ollama model. Reclaims about ${formatBytes(bytes)} physically; shared blobs are not counted twice.`
        : 'Removes one Ollama model.',
      irreversible: true, redownloadRequired: true,
    },
    preserved: ['Every other model', 'Ollama configuration'],
    findingResourceKey: { kind: 'model', id: placement.displayName, host: 'ollama', scope: 'user' },
  };
}

const APPLY_MATCHERS = Object.freeze({
  'host-alignment': hostAlignmentMatcher,
  'claude-plugin': claudePluginMatcher,
  'codex-plugin': codexPluginMatcher,
  'codex-mcp': codexMcpMatcher,
  'agentic-kit-npx-cache': npxCacheMatcher,
  'ruflo-mcp-orphan': rufloOrphanMatcher,
  'agentic-kit-owned-skill': ownedSkillMatcher,
  'git-project-patch': gitProjectPatchMatcher,
  'ollama-model': ollamaModelMatcher,
});

function formatBytes(bytes) {
  const gb = bytes / 1_000_000_000;
  return gb >= 0.1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

function defaultApplyOutcome(verb, placement) {
  const sentence = VERB_SENTENCE[verb] ?? 'Apply an operation to';
  return `${sentence} ${placement.displayName}`;
}

function computeApplyEntries(placement, ctx) {
  const entries = [];
  for (const [providerId, provider] of ctx.providers) {
    const matcher = APPLY_MATCHERS[providerId];
    if (!matcher) continue;
    const candidate = matcher(placement, ctx.detections.get(providerId), ctx);
    if (!candidate || !provider.operations.includes(candidate.operation)) continue;
    entries.push({
      lane: 'apply', placementId: placement.placementId, verb: candidate.verb,
      outcome: candidate.outcome ?? defaultApplyOutcome(candidate.verb, placement),
      verifiedPremises: candidate.verifiedPremises, impact: candidate.impact, preserved: candidate.preserved,
      providerCapabilityId: `${providerId}:${provider.version}:${candidate.operation}:${candidate.findingResourceKey.scope}`,
      findingResourceKey: candidate.findingResourceKey,
      dispositionIdentity: `${placement.placementId}:${candidate.verb}`,
    });
  }
  return entries;
}

// ── Steps lane ───────────────────────────────────────────────────────────────

const STEPS_TRIGGER_CONDITIONS = Object.freeze(['missing-verified-dependency', 'update-candidate-present']);

function missingDependencyEdge(placement, ctx) {
  return (ctx.dependencyEdgesByFrom.get(placement.placementId) ?? [])
    .find((edge) => edge.satisfied === false && DEPENDENCY_EDGE_KINDS.includes(edge.kind));
}

function computeStepsEntries(placement, ctx) {
  const condition = placement.conditions.find((value) => STEPS_TRIGGER_CONDITIONS.includes(value));
  if (!condition) return [];
  const edge = missingDependencyEdge(placement, ctx);
  const dependencyRequirement = condition === 'missing-verified-dependency' ? (edge?.requirement ?? null) : null;
  const compatible = findCompatibleRecipes(ctx.recipes, {
    placement, environment: ctx.environmentFor(placement), resourceKind: placement.kind,
    condition, dependencyRequirement,
  });
  return compatible.map((recipe) => ({
    lane: 'steps', placementId: placement.placementId,
    outcome: recipe.expectedEffect,
    verifiedPremises: ['placement', condition],
    impact: { summary: recipe.expectedEffect },
    preserved: [...recipe.preservedResources],
    procedureId: recipe.recipeId,
    dispositionIdentity: `${placement.placementId}:${condition}:${recipe.recipeId}`,
  }));
}

// ── Decision lane: missing dependency ────────────────────────────────────────

function choice(choiceId, label, changes, keeps, grounded, reason) {
  return { choiceId, label, changes, keeps, grounded, ...(grounded ? {} : { reason }) };
}

function findAlternateExecutable(ctx, requirement, placement) {
  for (const candidate of ctx.placementsById.values()) {
    if (candidate.placementId === placement.placementId) continue;
    if (candidate.kind === 'executable' && candidate.displayName === requirement) return candidate;
  }
  return null;
}

// Providers speak a legacy resourceKinds vocabulary ('plugin', 'mcpServer',
// 'stale-npx-env', 'daemon', 'skill', 'project-file', 'model') that predates
// and differs from ManagementInventory's RESOURCE_KINDS ('mcp-registration',
// etc.) — see the matcher block above, grounded in the real provider
// sources. This is the same translation, scoped to what "remove a
// registration" can mean for the missing-dependency decision choice.
const LEGACY_RESOURCE_KIND_FOR = Object.freeze({
  'mcp-registration': 'mcpServer', plugin: 'plugin',
});

function findRemovalProvider(ctx, placement) {
  const legacyKind = LEGACY_RESOURCE_KIND_FOR[placement.kind];
  if (!legacyKind) return null;
  const host = placement.hostNamespace ?? placement.consumerHosts?.[0];
  for (const provider of ctx.providers.values()) {
    if (provider.host === host && provider.resourceKinds.includes(legacyKind) && provider.operations.includes('remove')) {
      return provider;
    }
  }
  return null;
}

function hostLabel(placement) {
  const host = placement.hostNamespace ?? placement.consumerHosts?.[0] ?? 'the host';
  return host.charAt(0).toUpperCase() + host.slice(1);
}

function missingDependencyChoices(placement, ctx, edge, stepsAdmitted) {
  const requirement = edge.requirement;
  const alternate = findAlternateExecutable(ctx, requirement, placement);
  const removalProvider = findRemovalProvider(ctx, placement);
  return [
    choice('repair-registration', 'Repair command path', 'The exact registration command',
      'The registration and its environment', Boolean(alternate),
      'No verified alternative executable placement was found.'),
    choice('relink-dependency', 'Relink dependency', 'The dependency binding', 'The registration', false,
      'No verified compatible dependency was found.'),
    choice('reinstall', 'Reinstall dependency', `Installs ${requirement}`, 'The registration', stepsAdmitted,
      `No source-bound reinstall procedure was found for ${requirement}.`),
    choice('remove', 'Remove registration', 'Removes the exact registration', 'Every other registration',
      Boolean(removalProvider), `No ${hostLabel(placement)} removal provider is registered.`),
  ];
}

function computeDecisionEntries(placement, ctx) {
  if (!placement.conditions.includes('missing-verified-dependency')) return [];
  const edge = missingDependencyEdge(placement, ctx);
  if (!edge) return [];
  const stepsAdmitted = findCompatibleRecipes(ctx.recipes, {
    placement, environment: ctx.environmentFor(placement), resourceKind: placement.kind,
    condition: 'missing-verified-dependency', dependencyRequirement: edge.requirement,
  }).some((recipe) => recipe.dependencyRequirement === edge.requirement);
  return [{
    lane: 'decision', placementId: placement.placementId,
    outcome: `Decide how to resolve the missing ${edge.requirement} dependency`,
    verifiedPremises: ['placement', 'missing-verified-dependency'],
    impact: { summary: 'Each choice changes only the exact registration or its dependency.' },
    preserved: ['Other registrations'],
    choices: missingDependencyChoices(placement, ctx, edge, stepsAdmitted),
    dispositionIdentity: `${placement.placementId}:missing-verified-dependency:decision`,
  }];
}

// ── Update lane ──────────────────────────────────────────────────────────────

function channelAllowed(placement, ctx) {
  const channel = placement.versions?.channel ?? 'stable';
  if (channel === 'stable') return true;
  const enrolled = ctx.channelPolicy.enrolledPlacementIds?.includes?.(placement.placementId);
  const enabled = ctx.channelPolicy.enabledChannels?.includes?.(channel);
  return Boolean(enrolled || enabled);
}

function computeUpdateEntries(placement, ctx) {
  const scorecard = placement.evidenceScorecard ?? {};
  if (placement.versions?.candidate && placement.versions?.updateStatus === 'Update available' && scorecard.candidateSource === 'verified') {
    return [{ lane: 'update', placementId: placement.placementId, outcome: 'Update available: '+placement.versions.candidate,
      verifiedPremises: ['placement', 'candidateSource'], impact: { summary: 'Reported by '+placement.versions.source+'. Compatibility has not been verified.' }, preserved: ['Current installation until an exact update is selected'],
      candidateId: placement.versions.candidate, dispositionIdentity: placement.placementId+':update:'+placement.versions.candidate }];
  }
  if (scorecard.installedVersion !== 'verified' || scorecard.compatibility !== 'verified') return [];
  const candidateObs = (ctx.versionObsByPlacement.get(placement.placementId) ?? [])
    .find((observation) => observation.axis === 'candidate');
  if (!candidateObs) return [];
  if (!channelAllowed(placement, ctx)) return [];
  const recommended = scorecard.recommendationAuthority === 'verified';
  return [{
    lane: 'update', placementId: placement.placementId,
    outcome: recommended ? `Update to the recommended ${candidateObs.value}` : `Update candidate ${candidateObs.value} is available`,
    verifiedPremises: ['placement', 'installedVersion', 'candidateSource', 'compatibility', ...(recommended ? ['recommendationAuthority'] : [])],
    impact: { summary: `Changes the installed version from ${placement.versions?.installed ?? 'the current version'} to ${candidateObs.value}.` },
    preserved: ['Configuration', 'Other placements'],
    candidateId: candidateObs.value,
    ...(recommended ? { recommended: true } : {}),
    dispositionIdentity: `${placement.placementId}:update:${candidateObs.value}`,
  }];
}

// ── Recovery lane ────────────────────────────────────────────────────────────
// A receipt's action surfaces on a placement's row via either of two paths:
// (1) `action.placementId` — the primary path once T's one-action-per-plan
//     flow plans against `placementId` directly; or
// (2) `action.resourceIdentity` matching one of the placement's OWN possible
//     identity keys, for a legacy receipt predating (1). This fallback only
//     works for the four providers whose identity is independently
//     reconstructible from placement fields alone (claude-plugin,
//     codex-plugin, codex-mcp, ollama-model) — the four opaque-resourceId
//     providers (agentic-kit-npx-cache, ruflo-mcp-orphan,
//     agentic-kit-owned-skill, git-project-patch) still require (1); their
//     legacy receipts remain visible in Activity's own "Recovery to finish"
//     group (activity.mjs), which needs no such linkage.

function candidateIdentityKeys(placement, ctx) {
  const keys = [];
  const resource = ctx.resourcesById.get(placement.resourceId);
  const hosts = placement.consumerHosts ?? [];
  if (placement.kind === 'plugin' && hosts.includes('claude')) {
    const scope = LEGACY_SCOPE_FOR[placement.administrativeScope];
    if (scope) {
      const ref = refFor(placement, resource);
      keys.push({ kind: 'plugin', id: `plugin:claude:${ref}:${scope}`, host: 'claude', scope });
    }
  }
  if (placement.kind === 'plugin' && hosts.includes('codex')) {
    const ref = refFor(placement, resource);
    keys.push({ kind: 'plugin', id: `plugin:codex:${ref}`, host: 'codex', scope: 'user' });
  }
  if (placement.kind === 'mcp-registration' && hosts.includes('codex') && placement.administrativeScope === 'user') {
    keys.push({ kind: 'mcpServer', id: `mcp:codex:${placement.displayName}`, host: 'codex', scope: 'user' });
  }
  if (placement.kind === 'model') {
    keys.push({ kind: 'model', id: placement.displayName, host: 'ollama', scope: 'user' });
  }
  return keys;
}

function matchesResourceIdentity(resourceIdentity, key) {
  return Boolean(resourceIdentity) && resourceIdentity.kind === key.kind && resourceIdentity.id === key.id
    && resourceIdentity.host === key.host && resourceIdentity.scope === key.scope;
}

function computeRecoveryEntries(placement, ctx) {
  const identityKeys = candidateIdentityKeys(placement, ctx);
  return (ctx.receipts ?? [])
    .filter((receipt) => isUnfinishedReceiptStatus(receipt.status))
    .flatMap((receipt) => (receipt.actions ?? [])
      .filter((action) => action.placementId === placement.placementId
        || identityKeys.some((key) => matchesResourceIdentity(action.resourceIdentity, key)))
      .map((_action) => ({
        lane: 'recovery', placementId: placement.placementId,
        outcome: 'Audit this interrupted action before another change',
        verifiedPremises: ['placement', 'recovery-receipt-open'],
        impact: { summary: 'Auditing compares current evidence with the recorded receipt; it never retries or undoes the action.' },
        preserved: ['The resource in its current state'],
        receiptId: receipt.id,
        dispositionIdentity: `${placement.placementId}:recovery:${receipt.id}`,
      })));
}

// ── Mutation blocks ──────────────────────────────────────────────────────────

function blockedApplyPlacementIds(mutationBlocks, inventory) {
  const blocked = new Set();
  for (const block of mutationBlocks ?? []) {
    for (const id of block.placementIds ?? []) blocked.add(id);
    for (const id of block.dependents ?? []) blocked.add(id);
    if (block.broad) {
      for (const placement of inventory.placements) {
        if (placement.environmentId === block.environmentId) blocked.add(placement.placementId);
      }
    }
  }
  return blocked;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

function guidanceMaterial(candidate) {
  if (candidate.lane === 'apply') return { plc: candidate.placementId, lane: 'apply', verb: candidate.verb };
  if (candidate.lane === 'recovery') return { plc: candidate.placementId, lane: 'recovery', receiptId: candidate.receiptId };
  return { plc: candidate.placementId, lane: candidate.lane };
}

function finalizeEntry(candidate, installationKey) {
  const guidanceId = opaqueId('gid', guidanceMaterial(candidate), installationKey);
  const warning = candidate.impact?.irreversible
    ? { impact: candidate.impact.summary, containmentChoice: 'snooze' }
    : undefined;
  return { guidanceId, ...candidate, ...(isOptionalManagement(candidate) ? { purpose: 'optional-management' } : {}), ...(warning ? { warning } : {}) };
}

function primaryLane(entries) {
  if (!entries?.length) return null;
  let best = entries[0];
  for (const entry of entries) {
    if (INVENTORY_GROUP_ORDER.indexOf(entry.lane) < INVENTORY_GROUP_ORDER.indexOf(best.lane)) best = entry;
  }
  return best.lane;
}

function groupByPlacementId(entries) {
  const map = new Map();
  for (const entry of entries) pushInto(map, entry.placementId, entry);
  return map;
}

function suppressedIdentities(dispositions) {
  return new Set(
    (dispositions ?? [])
      .filter((record) => record.kind === 'snoozed' || record.kind === 'ignored-exact-candidate')
      .map((record) => record.dispositionIdentity),
  );
}

/**
 * Admit Guidance for every placement in `inventory`. Returns `{ inventory,
 * lanes, counts }`: `inventory` is a new object with `guidanceEntries` set
 * to every admitted entry and each placement's `guidanceLane` set to its
 * best admitted lane; `lanes` groups admitted entries by lane; `counts`
 * gives per-lane and total navigation-badge counts (MNT-GUD-003: remedy-free
 * placements contribute nothing to either).
 * @param {{ inventory: any, providers?: Map<string, any>, detections?: Map<string, any>, receipts?: any[], recipes?: any[], dispositions?: any[], mutationBlocks?: any[], now?: () => Date, channelPolicy?: any, installationKey: string }} options
 */
export function admitGuidance({
  inventory, providers = new Map(), detections = new Map(), receipts = [], recipes = [],
  dispositions = [], mutationBlocks = [], now = () => new Date(), channelPolicy = {},
  installationKey,
} = /** @type {any} */ ({})) {
  if (typeof installationKey !== 'string' || installationKey.length < 16) {
    throw new TypeError('admitGuidance requires an installationKey to derive opaque guidance ids');
  }
  void now; // reserved for time-bound admission rules (e.g. future snooze-aware filtering)
  const ctx = buildGuidanceContext({ inventory, providers, detections, receipts, recipes, channelPolicy });
  const blocked = blockedApplyPlacementIds(mutationBlocks, inventory);

  const candidates = [];
  for (const placement of inventory.placements) {
    candidates.push(...computeRecoveryEntries(placement, ctx));
    if (!blocked.has(placement.placementId)) candidates.push(...computeApplyEntries(placement, ctx));
    candidates.push(...computeStepsEntries(placement, ctx));
    candidates.push(...computeDecisionEntries(placement, ctx));
    candidates.push(...computeUpdateEntries(placement, ctx));
  }

  const finalized = candidates.map((candidate) => finalizeEntry(candidate, installationKey));
  const suppressed = suppressedIdentities(dispositions);
  const admitted = finalized.filter((entry) => !suppressed.has(entry.dispositionIdentity));

  const recommendations = recommendationEntries(admitted);
  const byPlacement = groupByPlacementId(recommendations);
  const nextPlacements = inventory.placements.map((placement) => ({
    ...placement, guidanceLane: primaryLane(byPlacement.get(placement.placementId)),
  }));
  const nextInventory = { ...inventory, placements: nextPlacements, guidanceEntries: admitted };
  nextInventory.guidanceCoverage = guidanceCoverage(nextInventory, providers, detections);

  const lanes = { apply: [], steps: [], decision: [], update: [], recovery: [] };
  for (const entry of recommendations) lanes[entry.lane].push(entry);
  const counts = {
    apply: lanes.apply.length, steps: lanes.steps.length, decision: lanes.decision.length,
    update: lanes.update.length, recovery: lanes.recovery.length, total: recommendations.length,
  };

  return { inventory: nextInventory, lanes, counts };
}

// ── Inspector (9-question object) ───────────────────────────────────────────

function firstCarrier(inventory, placement) {
  const artifact = inventory.artifacts.find((a) => a.artifactId === placement.artifactIds?.[0]);
  return artifact ? { value: artifact.carrier, label: artifact.label ?? null } : null;
}

function provenanceFor(inventory, placementId) {
  const assertion = inventory.provenanceAssertions.find((a) => a.subjectId === placementId);
  if (!assertion) return undefined;
  return { kind: assertion.value?.kind, label: assertion.value?.label ?? null, authority: assertion.authority, grade: assertion.grade };
}

function whoUsesIt(inventory, placement) {
  const bindings = inventory.consumerBindings.filter((b) => (placement.consumerBindingIds ?? []).includes(b.bindingId));
  const reverse = inventory.dependencyEdges.filter((e) => e.toId === placement.placementId || e.toId === placement.resourceId);
  return {
    consumers: bindings.map((b) => ({ consumerKind: b.consumerKind, consumerLabel: b.consumerLabel, enabled: b.enabled })),
    reverseDependencies: reverse.map((e) => ({ fromPlacementId: e.fromPlacementId, kind: e.kind })),
  };
}

function conflictsFor(inventory, placementId) {
  return inventory.conflictSets
    .filter((c) => c.placementIds.includes(placementId))
    .map((c) => ({
      kind: c.kind, label: CONFLICT_EXPLANATIONS[c.kind]?.label,
      proves: c.proves, doesNotProve: c.doesNotProve, placementIds: [...c.placementIds],
    }));
}

function historyFor(placement, receipts, dispositions, coverage, inventory) {
  const relatedReceipts = (receipts ?? []).filter((r) => (r.actions ?? []).some((a) => a.placementId === placement.placementId));
  const relatedDispositions = (dispositions ?? []).filter((d) => d.dispositionIdentity?.startsWith(`${placement.placementId}:`));
  const environmentCoverage = (coverage ?? inventory.sourceCoverage ?? []).filter((c) => c.environmentId === placement.environmentId);
  return {
    receipts: relatedReceipts.map((r) => ({ id: r.id, status: r.status })),
    dispositions: relatedDispositions,
    coverage: environmentCoverage,
  };
}

/**
 * The nine-question inspector object for one placement
 * (experience-specification.md "Resource inspector"). Never includes a
 * local path — `revealLocator` (the facade, owner-protected) is the only
 * path disclosure. `ctx.guidance` may be the full `admitGuidance` result or
 * a flat list of guidance entries.
 * @param {any} inventory
 * @param {string} placementId
 * @param {{ guidance?: any, receipts?: any[], dispositions?: any[], coverage?: any[] }} [ctx]
 */
export function inspectorFor(inventory, placementId, { guidance, receipts = [], dispositions = [], coverage } = /** @type {any} */ ({})) {
  inventory = normalizeGuidanceInventory(inventory);
  const placement = inventory.placements.find((p) => p.placementId === placementId);
  if (!placement) throw new TypeError(`unknown placement: ${placementId}`);
  const allEntries = Array.isArray(guidance) ? guidance : (guidance?.guidanceEntries ?? inventory.guidanceEntries ?? []);
  const entries = allEntries.filter((entry) => entry.placementId === placementId)
    .map((entry) => isOptionalManagement(entry) ? { ...entry, purpose: 'optional-management' } : entry);

  return {
    relationships: inspectorRelationships(inventory, placement),
    whatIsThis: {
      displayName: placement.displayName, kind: placement.kind, kindLabel: RESOURCE_KIND_LABELS[placement.kind],
      placementId, environmentId: placement.environmentId, conditions: [...placement.conditions],
      conditionLabels: placement.conditions.map((condition) => CONDITION_LABELS[condition]),
    },
    whereIsIt: {
      scope: placement.administrativeScope, breadcrumb: [...(placement.locationBreadcrumb ?? [])],
      carrier: firstCarrier(inventory, placement),
    },
    whereDidItComeFrom: provenanceFor(inventory, placementId),
    whatVersionIsHere: { ...(placement.versions ?? {}) },
    whoUsesIt: whoUsesIt(inventory, placement),
    whatChangedOrConflicts: conflictsFor(inventory, placementId),
    whatCanIAccomplish: entries.length ? entries : { detail: NO_ACTION_REQUESTED_DETAIL },
    whatProvesThis: { evidenceScorecard: { ...placement.evidenceScorecard }, technicalDetails: [...(placement.technicalDetails ?? [])] },
    whatHappenedBefore: historyFor(placement, receipts, dispositions, coverage, inventory),
  };
}
