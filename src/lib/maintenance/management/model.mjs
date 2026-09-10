// ADR-0048 management projection contract (Maintenance Resource Management).
//
// This module is the single vocabulary shared by the projection, query,
// guidance, discovery, transaction, dashboard, and CLI slices. It owns closed
// enumerations, user-facing label policy, the opaque identifier grammar, and a
// structural validator for the versioned ManagementInventory. It never reads
// the filesystem, spawns a process, or grants mutation authority.
import { createHmac } from 'node:crypto';

import { deepFreeze } from '../model.mjs';

export { deepFreeze };

export const MANAGEMENT_SCHEMA_VERSION = 2;
export const MANAGEMENT_INVENTORY_SCHEMA = 'maintenance-management-inventory/v2';
export const MANAGEMENT_QUERY_SCHEMA = 'maintenance-management-query/v2';

// ── Environments and scopes ────────────────────────────────────────────────
export const ENVIRONMENT_KINDS = Object.freeze(['macos', 'linux', 'windows', 'wsl']);
/** Stored administrative scopes. `across` is a query lens and is never stored. */
export const ADMINISTRATIVE_SCOPES = Object.freeze(['system', 'machine', 'user', 'project']);
export const SCOPE_LENSES = Object.freeze([...ADMINISTRATIVE_SCOPES, 'across']);
export const SCOPE_LABELS = Object.freeze({
  system: 'System', machine: 'Machine', user: 'User', project: 'Projects', across: 'Across scopes',
});

// ── Resources, carriers, consumers ─────────────────────────────────────────
export const RESOURCE_KINDS = Object.freeze([
  'skill', 'mcp-registration', 'plugin', 'hook', 'instruction-context-file', 'agent',
  'command-prompt', 'host-adapter', 'executable', 'runtime', 'model', 'provider-configuration',
  'cache', 'credential-readiness', 'related-storage',
]);
export const RESOURCE_KIND_LABELS = Object.freeze({
  'skill': 'Skill',
  'mcp-registration': 'MCP registration',
  'plugin': 'Plugin',
  'hook': 'Hook',
  'instruction-context-file': 'Instruction file',
  'agent': 'Agent',
  'command-prompt': 'Command',
  'host-adapter': 'Host adapter',
  'executable': 'Executable',
  'runtime': 'Runtime',
  'model': 'Model',
  'provider-configuration': 'Provider configuration',
  'cache': 'Cache',
  'credential-readiness': 'Credential',
  'related-storage': 'Storage',
});
export const CARRIER_KINDS = Object.freeze([
  'file', 'config-selector', 'directory-tree', 'package-record', 'executable',
  'runtime-installation', 'cache-object', 'model-revision', 'storage-root',
]);
export const CONSUMER_KINDS = Object.freeze([
  'host', 'adapter', 'project', 'route', 'provider', 'model-runtime', 'tool',
]);
export const HOSTS = Object.freeze(['claude', 'codex', 'opencode', 'hermes', 'agentic-kit']);

// ── Evidence ───────────────────────────────────────────────────────────────
export const EVIDENCE_GRADES = Object.freeze(['verified', 'provider-declared', 'inferred']);
export const EVIDENCE_FIELDS = Object.freeze([
  'identity', 'placement', 'provenance', 'installedVersion', 'effectiveVersion', 'consumers',
  'dependencies', 'candidateSource', 'compatibility', 'recommendationAuthority', 'impact', 'remedy',
]);
export const EVIDENCE_FRESHNESS = Object.freeze(['fresh', 'stale']);
export const EVIDENCE_COMPLETENESS = Object.freeze(['complete', 'partial']);

// ── Versions and provenance ────────────────────────────────────────────────
export const VERSION_AXES = Object.freeze([
  'installed', 'effective', 'candidate', 'compatibleCandidate', 'recommendedCandidate',
  'producer', 'sourceRevision', 'cacheGeneration', 'contentDigest', 'pin', 'channel',
]);
export const CHANNELS = Object.freeze(['stable', 'prerelease', 'nightly']);
export const PROVENANCE_KINDS = Object.freeze([
  'host-installer', 'plugin-marketplace', 'package-manager', 'skills-installer',
  'managed-projection', 'provider-owned-configuration', 'manual-placement',
]);

// ── Dependencies and conflicts ─────────────────────────────────────────────
export const DEPENDENCY_KINDS = Object.freeze([
  'requires-executable', 'requires-runtime', 'requires-provider', 'requires-credential', 'loads',
  'configures', 'projects', 'consumes', 'stores-in', 'resolves-through', 'windows-hosts-wsl',
  'submodule-of',
]);
export const CONFLICT_KINDS = Object.freeze([
  'duplicate-placement', 'shadowed-override', 'same-name-different-definition',
  'equivalent-transport-registration', 'version-requirement-divergence',
  'dependency-resolution-collision', 'shared-artifact',
]);
/** Every conflict classification states what the evidence proves and what it does not. */
export const CONFLICT_EXPLANATIONS = Object.freeze({
  'duplicate-placement': {
    label: 'Duplicate placement',
    proves: 'Separate placements have equivalent verified definitions.',
    doesNotProve: 'Equality does not prove one is disposable.',
  },
  'shadowed-override': {
    label: 'Shadowed override',
    proves: 'A narrower scope takes precedence over a broader placement for a verified host.',
    doesNotProve: 'Precedence does not prove the broader placement is unused elsewhere.',
  },
  'same-name-different-definition': {
    label: 'Same name, different definition',
    proves: 'Names match but bounded definitions differ.',
    doesNotProve: 'The intended source cannot be inferred.',
  },
  'equivalent-transport-registration': {
    label: 'Equivalent MCP transport',
    proves: 'Registrations resolve to the same verified transport.',
    doesNotProve: 'Equal transport does not prove equal scope or health.',
  },
  'version-requirement-divergence': {
    label: 'Version requirement divergence',
    proves: 'Verified consumers require incompatible version ranges.',
    doesNotProve: 'Divergence does not prove which consumer should change.',
  },
  'dependency-resolution-collision': {
    label: 'Dependency resolution collision',
    proves: 'The resolved dependency differs from the placement\'s verified declaration.',
    doesNotProve: 'A collision does not prove the resolved dependency is wrong.',
  },
  'shared-artifact': {
    label: 'Shared artifact',
    proves: 'Several consumers intentionally use one physical artifact.',
    doesNotProve: 'This is not a duplicate and grants no removal authority.',
  },
});

// ── Conditions, guidance, dispositions ─────────────────────────────────────
export const PLACEMENT_CONDITIONS = Object.freeze([
  'healthy', 'disabled', 'missing-verified-dependency', 'update-candidate-present',
  'definitions-differ', 'superseded-revision', 'recovery-receipt-open',
  'credential-mechanism-not-checked', 'source-scan-incomplete', 'reproducible-cache',
  'orphaned-process',
  'host-alignment-required',
]);
export const CONDITION_LABELS = Object.freeze({
  'healthy': 'Healthy',
  'disabled': 'Disabled',
  'missing-verified-dependency': 'Missing verified dependency',
  'update-candidate-present': 'Update candidate present',
  'definitions-differ': 'Definitions differ',
  'superseded-revision': 'Superseded revision',
  'recovery-receipt-open': 'Recovery receipt open',
  'credential-mechanism-not-checked': 'Configured credential mechanism not checked',
  'source-scan-incomplete': 'Source scan incomplete',
  'reproducible-cache': 'Reproducible cache',
  'orphaned-process': 'Orphaned process',
  'host-alignment-required': 'Host realignment required',
});
export const GUIDANCE_LANES = Object.freeze(['apply', 'steps', 'decision', 'update', 'recovery']);
export const GUIDANCE_LANE_LABELS = Object.freeze({
  apply: 'Can apply here',
  steps: 'Steps available',
  decision: 'Decisions to make',
  update: 'Updates available',
  recovery: 'Recovery to finish',
});
/** Inventory sort groups. This is a sort, not a severity ladder. */
export const INVENTORY_GROUP_ORDER = Object.freeze([
  'recovery', 'apply', 'steps', 'decision', 'update', 'evidence-only', 'healthy',
]);
export const INVENTORY_GROUP_LABELS = Object.freeze({
  ...GUIDANCE_LANE_LABELS,
  'evidence-only': 'Inventory evidence only',
  'healthy': 'Healthy resources',
});
export const CURATED_VIEWS = Object.freeze([
  'all', 'can-apply', 'steps', 'decisions', 'updates', 'dependencies', 'conflicts', 'duplicates',
  'disabled', 'credentials-providers', 'models-runtimes', 'storage-caches', 'recently-changed',
  'evidence-only',
  'host-alignment',
]);
export const CURATED_VIEW_LABELS = Object.freeze({
  'all': 'All resources',
  'can-apply': 'Can apply here',
  'steps': 'Steps available',
  'decisions': 'Decisions to make',
  'updates': 'Updates available',
  'dependencies': 'Dependencies',
  'conflicts': 'Conflicts and overlaps',
  'duplicates': 'Duplicated placements',
  'disabled': 'Disabled resources',
  'credentials-providers': 'Credentials and providers',
  'models-runtimes': 'Models and runtimes',
  'storage-caches': 'Storage and caches',
  'recently-changed': 'Recently changed',
  'evidence-only': 'Inventory evidence only',
  'host-alignment': 'Host alignment',
});
export const FACETS = Object.freeze([
  'scope', 'environment', 'project', 'projectType', 'sessionOrigin', 'family', 'kind', 'adapter', 'consumer', 'carrier', 'provenance',
  'packageManager', 'versionState', 'guidance', 'dependencyRole', 'conflict',
  'credentialReadiness', 'channel', 'evidenceFields', 'recentlyChanged',
]);
export const SORT_ORDERS = Object.freeze(['guidance-first', 'name', 'recently-changed', 'kind']);
export const VERSION_STATES = Object.freeze([
  'installed-verified', 'effective-verified', 'candidate-present', 'compatible-candidate',
  'recommended-candidate', 'pinned', 'no-verified-version',
]);
export const DEPENDENCY_ROLES = Object.freeze(['depends-on', 'depended-on-by', 'none']);
export const ACTION_VERBS = Object.freeze([
  'update', 'disable', 'remove', 'repair-registration', 'relink-dependency', 'reinstall',
  'clean-cache', 'restore', 'snooze', 'acknowledge',
]);
export const DISPOSITION_KINDS = Object.freeze(['acknowledged', 'snoozed', 'ignored-exact-candidate']);
export const DISPOSITION_LABELS = Object.freeze({
  'acknowledged': 'Acknowledged',
  'snoozed': 'Snoozed',
  'ignored-exact-candidate': 'Ignored exact candidate',
});
export const DISPOSITION_INVALIDATIONS = Object.freeze([
  'expiry', 'candidate-change', 'installed-version-change', 'dependency-change',
  'source-fingerprint-drift', 'security-severity-increase',
]);

// ── Credentials ────────────────────────────────────────────────────────────
export const CREDENTIAL_READINESS = Object.freeze([
  'not-configured', 'configured-not-checked', 'ready', 'check-failed', 'expired-renewal-needed',
]);
export const CREDENTIAL_READINESS_LABELS = Object.freeze({
  'not-configured': 'Not configured',
  'configured-not-checked': 'Configured but not checked',
  'ready': 'Ready',
  'check-failed': 'Check failed',
  'expired-renewal-needed': 'Expired or renewal needed',
});
export const CREDENTIAL_MECHANISMS = Object.freeze([
  'environment-variable', 'keychain-entry', 'credentials-file', 'host-login',
]);

// ── Discovery and scans ────────────────────────────────────────────────────
export const SOURCE_TYPES = Object.freeze(['automatic', 'exact-project', 'collection-root']);
export const SOURCE_COVERAGE_STATES = Object.freeze(['not-scanned', 'complete', 'scanning', 'paused', 'stopped', 'failed']);
export const SOURCE_COVERAGE_LABELS = Object.freeze({
  'not-scanned': 'Not scanned yet',
  'complete': 'Complete',
  'scanning': 'Scanning',
  'paused': 'Paused',
  'stopped': 'Stopped',
  'failed': 'Failed',
});
export const SCAN_STATES = Object.freeze([
  'configured', 'queued', 'scanning', 'checkpointed', 'paused', 'complete', 'published',
  'stopped', 'failed',
]);
export const SCAN_TRANSITIONS = Object.freeze({
  configured: ['queued'],
  queued: ['scanning', 'stopped'],
  scanning: ['checkpointed', 'paused', 'complete', 'stopped', 'failed'],
  checkpointed: ['scanning', 'paused', 'stopped'],
  paused: ['scanning', 'stopped'],
  complete: ['published'],
  published: [],
  stopped: [],
  failed: ['queued'],
});
export const SAFETY_CEILINGS = Object.freeze([
  'depth', 'entries', 'file-size', 'memory', 'output', 'process-time', 'response-size',
]);
export const LIMITING_REASONS = Object.freeze([
  'work-slice', 'paused-by-user', 'stopped-by-user', 'safety-ceiling', 'permission-denied',
  'source-changed', 'io-failure',
]);
export const SCAN_CHECKPOINT_SCHEMA = 'maintenance-scan-checkpoint/v1';
export const SCAN_HISTORY_RETENTION = Object.freeze({ maxSummaries: 10, maxAgeDays: 90, checkpointDays: 7 });
export const SCAN_HISTORY_FLOORS = Object.freeze({ minSummaries: 1, minAgeDays: 1 });

// ── Recovery audit ─────────────────────────────────────────────────────────
export const AUDIT_RESULTS = Object.freeze([
  'no-action-started', 'matches-recorded-before-state', 'matches-verified-after-state',
  'differs-from-both-recorded-states', 'matching-inspection-provider-not-present',
  'receipt-integrity-check-failed', 'affected-catalog-refresh-did-not-complete',
]);
export const AUDIT_RESULT_LABELS = Object.freeze({
  'no-action-started': 'No action started',
  'matches-recorded-before-state': 'Matches recorded before state',
  'matches-verified-after-state': 'Matches verified after state',
  'differs-from-both-recorded-states': 'Differs from both recorded states',
  'matching-inspection-provider-not-present': 'Matching inspection provider is not present',
  'receipt-integrity-check-failed': 'Receipt integrity check failed',
  'affected-catalog-refresh-did-not-complete': 'Affected catalog refresh did not complete',
});
/** Conclusive audit results and the single reconciliation write each enables. */
export const RECONCILE_OUTCOMES = Object.freeze(['record-no-change', 'record-completed', 'record-restored']);
export const RECONCILE_OUTCOME_LABELS = Object.freeze({
  'record-no-change': 'Record no change',
  'record-completed': 'Record completed',
  'record-restored': 'Record restored',
});
export const AUDIT_ACTION_LABEL = 'Audit interruption';

// ── Procedures, shells, package managers, recipes ──────────────────────────
export const SHELLS = Object.freeze(['bash', 'zsh', 'powershell', 'cmd', 'wsl']);
export const SHELL_LABELS = Object.freeze({
  bash: 'bash', zsh: 'zsh', powershell: 'PowerShell', cmd: 'cmd.exe', wsl: 'WSL shell',
});
export const PACKAGE_MANAGERS = Object.freeze([
  'homebrew', 'macports', 'apt', 'dnf', 'pacman', 'zypper', 'snap', 'npm', 'pnpm', 'yarn', 'bun',
  'pip', 'pipx', 'uv', 'cargo', 'mise', 'asdf', 'winget', 'chocolatey', 'scoop',
]);
export const PACKAGE_MANAGER_RELEASE_MODELS = Object.freeze({
  homebrew: 'rolling', macports: 'rolling', apt: 'os-coupled', dnf: 'os-coupled',
  pacman: 'rolling', zypper: 'os-coupled', snap: 'rolling', npm: 'semver', pnpm: 'semver',
  yarn: 'semver', bun: 'semver', pip: 'semver', pipx: 'semver', uv: 'semver', cargo: 'semver',
  mise: 'semver', asdf: 'semver', winget: 'semver', chocolatey: 'semver', scoop: 'rolling',
});
export const PRIVILEGE_REQUIREMENTS = Object.freeze(['none', 'elevated']);
export const NETWORK_REQUIREMENTS = Object.freeze(['none', 'required']);
export const RECIPE_SCHEMA = 'maintenance-procedure-recipe/v1';
export const RECIPE_STATES = Object.freeze(['active', 'pending-acceptance', 'withdrawn']);

// ── User-facing language policy ────────────────────────────────────────────
export const NO_ACTION_REQUESTED = 'No action is requested.';
export const NO_ACTION_REQUESTED_DETAIL = 'No action is requested. Agentic Kit does not have a '
  + 'verified operation, procedure, or bounded decision to offer for this condition in the current '
  + 'environment.';
export const NO_CORRECTIVE_ACTION = 'No corrective action is offered.';
export const SOURCE_SCAN_INCOMPLETE = 'Source scan incomplete';
export const SOURCE_CHANGED_DURING_MEASUREMENT = 'The source changed during measurement.';
/** Labels that may never render as a standalone user-facing label, filter, group, or button. */
export const PROHIBITED_LABELS = Object.freeze([
  'unknown', 'unsupported', 'needs attention', 'review', 'fix', 'repair all', 'clean all',
]);
const PROHIBITED_LABEL_PATTERN = new RegExp(`^(?:${PROHIBITED_LABELS.map((label) => label.replace(/ /g, '\\s+')).join('|')})$`, 'iu');
const PROHIBITED_PHRASE_PATTERN = /\b(?:needs\s+attention|repair\s+all|clean\s+all)\b/iu;
const PROHIBITED_WORD_PATTERN = /\b(?:unknown|unsupported)\b/iu;

/** True when a label is an exact prohibited label or carries a prohibited status word.
 *  Sentences that explain evidence (for example "cannot be inferred") remain allowed. */
export function isProhibitedLabel(label) {
  const value = String(label ?? '').trim();
  if (!value) return false;
  return PROHIBITED_LABEL_PATTERN.test(value)
    || PROHIBITED_PHRASE_PATTERN.test(value)
    || PROHIBITED_WORD_PATTERN.test(value);
}

/** Throw when a user-facing label violates the language policy. */
export function assertLabelAllowed(label, field = 'label') {
  if (isProhibitedLabel(label)) throw new TypeError(`${field} uses a prohibited user-facing label: ${label}`);
  return label;
}

// ── Domain events ──────────────────────────────────────────────────────────
export const DOMAIN_EVENTS = Object.freeze([
  'InventoryPublished', 'DiscoverySourceConfigured', 'DiscoverySourceStopped',
  'ScanProgressCheckpointed', 'ScanCompleted', 'GuidanceAdmitted', 'DispositionRecorded',
  'DispositionInvalidated', 'ActionPlanned', 'ActionApplied', 'ActionVerified',
  'InterruptionDetected', 'InterruptionAudited', 'ReceiptReconciled', 'RecipeRefreshed',
  'RecipeAccepted', 'RecipeWithdrawn',
]);

// ── Opaque identifiers ─────────────────────────────────────────────────────
export const ID_PREFIXES = Object.freeze({
  environment: 'env', resource: 'res', placement: 'plc', artifact: 'art', binding: 'bnd',
  edge: 'edg', conflict: 'cfl', guidance: 'gid', source: 'src', scan: 'scn', recipe: 'rcp',
  disposition: 'dsp', inventory: 'inv', preview: 'prv', exclusion: 'exc', project: 'prj',
  evidence: 'evd', checklist: 'chk',
});
export const OPAQUE_ID = /^(?:env|res|plc|art|bnd|edg|cfl|gid|src|scn|rcp|dsp|inv|prv|exc|prj|evd|chk)_[A-Za-z0-9_-]{16,64}$/;

/** Derive a stable, non-reversible opaque identifier. `key` is the installation
 *  key; `material` is any JSON-shaped identity tuple. Equal material yields the
 *  same id inside one installation; the id reveals nothing about the material. */
export function opaqueId(prefix, material, key) {
  if (!Object.values(ID_PREFIXES).includes(prefix)) throw new TypeError(`unknown opaque id prefix: ${prefix}`);
  if (typeof key !== 'string' || key.length < 16) throw new TypeError('opaque ids require an installation key');
  const digest = createHmac('sha256', key).update(canonicalJson(material)).digest('base64url');
  return `${prefix}_${digest.slice(0, 27)}`;
}

export function isOpaqueId(value, prefix = null) {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) return false;
  return prefix ? value.startsWith(`${prefix}_`) : true;
}

/** Canonical JSON with sorted keys for digests and fingerprints. */
export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value === undefined ? null : value;
}

// ── Structural validation ──────────────────────────────────────────────────
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512;
const LOCAL_PATH = /(?:^|[\s"'([{=:])(?:file:\/\/\/?|~[\\/]|[A-Za-z]:[\\/]|\\\\|\/(?!\/))/u;

function fail(field, message) {
  throw new TypeError(`ManagementInventory.${field}: ${message}`);
}

function assertList(inventory, field, check) {
  const list = inventory[field];
  if (!Array.isArray(list)) fail(field, 'must be an array');
  list.forEach((entry, index) => {
    if (!plain(entry)) fail(`${field}[${index}]`, 'must be an object');
    check(entry, `${field}[${index}]`);
  });
}

function assertNoLocalPath(value, field) {
  if (typeof value === 'string' && LOCAL_PATH.test(value)) fail(field, 'must not carry a local path');
  if (Array.isArray(value)) value.forEach((entry, index) => assertNoLocalPath(entry, `${field}[${index}]`));
  else if (plain(value)) for (const [key, entry] of Object.entries(value)) assertNoLocalPath(entry, `${field}.${key}`);
}

function assertEvidence(entry, field) {
  if (!isOpaqueId(entry.subjectId)) fail(`${field}.subjectId`, 'must be an opaque id');
  if (!EVIDENCE_FIELDS.includes(entry.field)) fail(`${field}.field`, `must be one of ${EVIDENCE_FIELDS.join(', ')}`);
  if (!EVIDENCE_GRADES.includes(entry.grade)) fail(`${field}.grade`, `must be one of ${EVIDENCE_GRADES.join(', ')}`);
  if (!text(entry.authority)) fail(`${field}.authority`, 'must name an authority');
  if (!text(entry.sourceRef)) fail(`${field}.sourceRef`, 'must reference a source');
  if (!Number.isFinite(Date.parse(entry.capturedAt))) fail(`${field}.capturedAt`, 'must be an ISO timestamp');
  if (!EVIDENCE_FRESHNESS.includes(entry.freshness)) fail(`${field}.freshness`, 'must be fresh or stale');
  if (!EVIDENCE_COMPLETENESS.includes(entry.completeness)) fail(`${field}.completeness`, 'must be complete or partial');
}

function assertScorecard(scorecard, field) {
  if (!plain(scorecard)) fail(field, 'must be an object');
  for (const [key, grade] of Object.entries(scorecard)) {
    if (!EVIDENCE_FIELDS.includes(key)) fail(`${field}.${key}`, 'is not an evidence field');
    if (!EVIDENCE_GRADES.includes(grade)) fail(`${field}.${key}`, 'must be an evidence grade');
  }
}

function assertPlacement(entry, field, ids) {
  if (!isOpaqueId(entry.placementId, 'plc')) fail(`${field}.placementId`, 'must be an opaque placement id');
  if (!ids.resources.has(entry.resourceId)) fail(`${field}.resourceId`, 'must reference a resource in this inventory');
  if (!ids.environments.has(entry.environmentId)) fail(`${field}.environmentId`, 'must reference an environment in this inventory');
  if (!ADMINISTRATIVE_SCOPES.includes(entry.administrativeScope)) fail(`${field}.administrativeScope`, 'must be a stored scope (never across)');
  if (entry.administrativeScope === 'project' && !isOpaqueId(entry.projectId, 'prj')) fail(`${field}.projectId`, 'project placements require an opaque project id');
  if (!Array.isArray(entry.locationBreadcrumb) || !entry.locationBreadcrumb.every(text)) fail(`${field}.locationBreadcrumb`, 'must be a list of segments');
  if ('exactLocatorRef' in entry) fail(`${field}.exactLocatorRef`, 'is owner-private and never enters the inventory');
  if (!Array.isArray(entry.artifactIds) || entry.artifactIds.some((id) => !ids.artifacts.has(id))) fail(`${field}.artifactIds`, 'must reference artifacts in this inventory');
  if (!Array.isArray(entry.consumerBindingIds) || entry.consumerBindingIds.some((id) => !ids.bindings.has(id))) fail(`${field}.consumerBindingIds`, 'must reference bindings in this inventory');
  if (!Array.isArray(entry.conditions) || !entry.conditions.every((value) => PLACEMENT_CONDITIONS.includes(value))) fail(`${field}.conditions`, 'must list placement conditions');
  assertScorecard(entry.evidenceScorecard, `${field}.evidenceScorecard`);
  if (entry.evidenceScorecard.identity !== 'verified' || entry.evidenceScorecard.placement !== 'verified') {
    fail(`${field}.evidenceScorecard`, 'inventory placements require verified identity and placement');
  }
  if (!text(entry.displayName)) fail(`${field}.displayName`, 'must be a non-empty string');
  assertLabelAllowed(entry.displayName, `${field}.displayName`);
  if (!RESOURCE_KINDS.includes(entry.kind)) fail(`${field}.kind`, 'must be a resource kind');
  if (entry.guidanceLane != null && !GUIDANCE_LANES.includes(entry.guidanceLane)) fail(`${field}.guidanceLane`, 'must be a guidance lane');
}

function assertGuidance(entry, field, ids) {
  if (entry.purpose != null && !['recommendation', 'optional-management'].includes(entry.purpose)) fail(`${field}.purpose`, 'must identify a recommendation or optional management action');
  if (!isOpaqueId(entry.guidanceId, 'gid')) fail(`${field}.guidanceId`, 'must be an opaque guidance id');
  if (!ids.placements.has(entry.placementId)) fail(`${field}.placementId`, 'must reference a placement in this inventory');
  if (!GUIDANCE_LANES.includes(entry.lane)) fail(`${field}.lane`, 'must be a guidance lane');
  if (!text(entry.outcome)) fail(`${field}.outcome`, 'must state a bounded outcome');
  assertLabelAllowed(entry.outcome, `${field}.outcome`);
  if (!Array.isArray(entry.verifiedPremises) || !entry.verifiedPremises.length) fail(`${field}.verifiedPremises`, 'must list at least one verified premise');
  if (!plain(entry.impact) || !text(entry.impact.summary)) fail(`${field}.impact`, 'must summarize impact');
  if (!Array.isArray(entry.preserved)) fail(`${field}.preserved`, 'must list preserved resources');
  if (!text(entry.dispositionIdentity)) fail(`${field}.dispositionIdentity`, 'must bind an exact disposition identity');
  assertGuidanceGrounding(entry, field);
}

const LANE_GROUNDING = Object.freeze({
  apply: ['providerCapabilityId', 'Can apply here requires a provider capability'],
  steps: ['procedureId', 'Steps available requires a procedure'],
  decision: ['choices', 'Decisions to make requires bounded choices'],
  update: ['candidateId', 'Updates available requires a candidate'],
  recovery: ['receiptId', 'Recovery to finish requires a receipt'],
});

function grounded(entry, key) {
  return key === 'choices' ? Array.isArray(entry.choices) && entry.choices.length > 0 : entry[key] != null;
}

function assertGuidanceGrounding(entry, field) {
  if (!Object.keys(LANE_GROUNDING).some((key) => grounded(entry, LANE_GROUNDING[key][0]))) {
    fail(field, 'must bind an operation, procedure, choice, candidate, or receipt audit');
  }
  const [key, message] = LANE_GROUNDING[entry.lane];
  if (!grounded(entry, key)) fail(field, message);
}

function assertConflict(entry, field, ids) {
  if (!isOpaqueId(entry.conflictId, 'cfl')) fail(`${field}.conflictId`, 'must be an opaque conflict id');
  if (!CONFLICT_KINDS.includes(entry.kind)) fail(`${field}.kind`, 'must be a conflict kind');
  const minimum = entry.kind === 'shared-artifact' ? 1 : 2;
  if (!Array.isArray(entry.placementIds) || entry.placementIds.length < minimum
      || entry.placementIds.some((id) => !ids.placements.has(id))) {
    fail(`${field}.placementIds`, `must reference at least ${minimum} placement(s)`);
  }
  if (entry.kind === 'shared-artifact' && (!Array.isArray(entry.artifactIds) || entry.artifactIds.length !== 1
      || !ids.artifacts.has(entry.artifactIds[0]))) {
    fail(`${field}.artifactIds`, 'a shared-artifact set names exactly one artifact in this inventory');
  }
  if (!text(entry.proves) || !text(entry.doesNotProve)) fail(field, 'must state what the evidence proves and does not prove');
}

function assertCoverage(entry, field, ids) {
  if (!isOpaqueId(entry.sourceId, 'src')) fail(`${field}.sourceId`, 'must be an opaque source id');
  if (!ids.environments.has(entry.environmentId)) fail(`${field}.environmentId`, 'must reference an environment');
  if (!SOURCE_COVERAGE_STATES.includes(entry.state)) fail(`${field}.state`, 'must be a coverage state');
  if (!Number.isInteger(entry.visited) || entry.visited < 0) fail(`${field}.visited`, 'must be a non-negative integer');
  if (!Number.isInteger(entry.completedPartitions) || !Number.isInteger(entry.pendingPartitions)) fail(field, 'must count partitions');
  if (entry.limitingReason != null && !LIMITING_REASONS.includes(entry.limitingReason)) fail(`${field}.limitingReason`, 'must be a limiting reason');
  if (entry.state === 'complete' && entry.pendingPartitions !== 0) fail(field, 'complete coverage cannot have pending partitions');
  if (entry.state === 'not-scanned' && (entry.visited !== 0 || entry.completedPartitions !== 0)) fail(field, 'a never-run source cannot report visited work');
}

/** Structural validation of a privacy-projected ManagementInventory. Throws a
 *  TypeError naming the first violation. Never mutates its argument. */
export function assertManagementInventory(inventory) {
  if (!plain(inventory)) throw new TypeError('ManagementInventory must be an object');
  if (inventory.schemaVersion !== MANAGEMENT_SCHEMA_VERSION) fail('schemaVersion', `must be ${MANAGEMENT_SCHEMA_VERSION}`);
  if (inventory.schema !== MANAGEMENT_INVENTORY_SCHEMA) fail('schema', `must be ${MANAGEMENT_INVENTORY_SCHEMA}`);
  if (!isOpaqueId(inventory.inventoryId, 'inv')) fail('inventoryId', 'must be an opaque inventory id');
  if (!Number.isFinite(Date.parse(inventory.capturedAt))) fail('capturedAt', 'must be an ISO timestamp');
  if (!text(inventory.sourceFingerprint)) fail('sourceFingerprint', 'must be present');
  const ids = {
    environments: new Set(), resources: new Set(), placements: new Set(),
    artifacts: new Set(), bindings: new Set(),
  };
  assertList(inventory, 'environments', (entry, field) => {
    if (!isOpaqueId(entry.environmentId, 'env')) fail(`${field}.environmentId`, 'must be an opaque environment id');
    if (!ENVIRONMENT_KINDS.includes(entry.kind)) fail(`${field}.kind`, 'must be an environment kind');
    if (!text(entry.displayLabel)) fail(`${field}.displayLabel`, 'must be present');
    if (entry.kind === 'wsl' && !isOpaqueId(entry.parentEnvironmentId, 'env')) fail(`${field}.parentEnvironmentId`, 'WSL requires its Windows host');
    ids.environments.add(entry.environmentId);
  });
  assertList(inventory, 'resources', (entry, field) => {
    if (!isOpaqueId(entry.resourceId, 'res')) fail(`${field}.resourceId`, 'must be an opaque resource id');
    if (!RESOURCE_KINDS.includes(entry.kind)) fail(`${field}.kind`, 'must be a resource kind');
    if (!text(entry.displayName)) fail(`${field}.displayName`, 'must be present');
    if (!Array.isArray(entry.placementIds)) fail(`${field}.placementIds`, 'must be an array');
    ids.resources.add(entry.resourceId);
  });
  assertList(inventory, 'artifacts', (entry, field) => {
    if (!isOpaqueId(entry.artifactId, 'art')) fail(`${field}.artifactId`, 'must be an opaque artifact id');
    if (!CARRIER_KINDS.includes(entry.carrier)) fail(`${field}.carrier`, 'must be a carrier kind');
    ids.artifacts.add(entry.artifactId);
  });
  assertList(inventory, 'consumerBindings', (entry, field) => {
    if (!isOpaqueId(entry.bindingId, 'bnd')) fail(`${field}.bindingId`, 'must be an opaque binding id');
    if (!CONSUMER_KINDS.includes(entry.consumerKind)) fail(`${field}.consumerKind`, 'must be a consumer kind');
    if (!text(entry.consumerLabel)) fail(`${field}.consumerLabel`, 'must be present');
    if (typeof entry.enabled !== 'boolean' && entry.enabled !== null) fail(`${field}.enabled`, 'must be boolean or null');
    ids.bindings.add(entry.bindingId);
  });
  assertList(inventory, 'placements', (entry, field) => {
    assertPlacement(entry, field, ids);
    ids.placements.add(entry.placementId);
  });
  for (const [index, resource] of inventory.resources.entries()) {
    if (resource.placementIds.some((id) => !ids.placements.has(id))) fail(`resources[${index}].placementIds`, 'must reference placements in this inventory');
  }
  assertList(inventory, 'sourceCoverage', (entry, field) => assertCoverage(entry, field, ids));
  assertList(inventory, 'provenanceAssertions', (entry, field) => {
    assertEvidence(entry, field);
    if (entry.field !== 'provenance') fail(`${field}.field`, 'must be provenance');
    if (!PROVENANCE_KINDS.includes(entry.value?.kind)) fail(`${field}.value.kind`, 'must be a provenance kind');
  });
  assertList(inventory, 'versionObservations', (entry, field) => {
    assertEvidence(entry, field);
    if (!VERSION_AXES.includes(entry.axis)) fail(`${field}.axis`, 'must be a version axis');
    if (!text(entry.value)) fail(`${field}.value`, 'must be present');
  });
  assertList(inventory, 'dependencyEdges', (entry, field) => {
    if (!isOpaqueId(entry.edgeId, 'edg')) fail(`${field}.edgeId`, 'must be an opaque edge id');
    if (!ids.placements.has(entry.fromPlacementId)) fail(`${field}.fromPlacementId`, 'must reference a placement');
    if (!isOpaqueId(entry.toId)) fail(`${field}.toId`, 'must be an opaque resource or placement id');
    if (!DEPENDENCY_KINDS.includes(entry.kind)) fail(`${field}.kind`, 'must be a dependency kind');
    if (!EVIDENCE_GRADES.includes(entry.grade)) fail(`${field}.grade`, 'must be an evidence grade');
  });
  assertList(inventory, 'conflictSets', (entry, field) => assertConflict(entry, field, ids));
  assertList(inventory, 'guidanceEntries', (entry, field) => assertGuidance(entry, field, ids));
  assertNoLocalPath(inventory, 'inventory');
  return inventory;
}

/** Build an empty, valid inventory envelope. */
export function emptyManagementInventory({ inventoryId, capturedAt, sourceFingerprint = 'empty' }) {
  return deepFreeze({
    schemaVersion: MANAGEMENT_SCHEMA_VERSION,
    schema: MANAGEMENT_INVENTORY_SCHEMA,
    inventoryId,
    capturedAt,
    sourceFingerprint,
    environments: [],
    sourceCoverage: [],
    resources: [],
    placements: [],
    artifacts: [],
    consumerBindings: [],
    provenanceAssertions: [],
    versionObservations: [],
    dependencyEdges: [],
    conflictSets: [],
    guidanceEntries: [],
  });
}

/** Claims an incomplete source can never support (MNT-DSC-014). */
export const INCOMPLETE_SOURCE_FORBIDDEN_CLAIMS = Object.freeze([
  'absence', 'complete-total', 'uniqueness', 'complete-conflicts',
  'complete-reverse-dependencies', 'reclaimable-total', 'completeness-dependent-action',
]);

/** True when every source that feeds the placement's environment is complete. */
export function sourceComplete(inventory, environmentId) {
  const coverage = (inventory?.sourceCoverage ?? []).filter((entry) => entry.environmentId === environmentId);
  return coverage.length > 0 && coverage.every((entry) => entry.state === 'complete');
}
