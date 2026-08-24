// usage-telemetry.mjs — the host-neutral evidence contract for the usage
// scorecard. This module describes what a source can report; it does not
// reinterpret host wire events as a different kind of activity.
//
// The first implementation deliberately stops at prompts, responses, and
// parser coverage. Claude and OpenCode can expose normalized tool calls, but
// Codex's current rollout item families do not map one-to-one to that existing
// contract. Activity categories therefore remain explicit capabilities rather
// than being filled with host-specific guesses.

export const TELEMETRY_CAPABILITY_STATES = Object.freeze([
  'supported', 'unsupported', 'unavailable',
]);

/** Categories whose meanings are shared across transcript hosts. */
export const TELEMETRY_CATEGORIES = Object.freeze([
  'prompts', 'responses', 'toolCalls', 'commandExecutions',
  'fileChanges', 'mcpCalls', 'collaboration',
]);

/** Keep future wire-kind growth from becoming an unbounded diagnostics payload. */
export const MAX_TELEMETRY_UNKNOWN_KINDS = 32;

/**
 * Static capability matrix. `supported` means the source format carries
 * enough evidence for this category under the current parser contract;
 * `unsupported` means the category is intentionally not claimed. Runtime
 * source health can turn a supported category into `unavailable`.
 */
export const HOST_TELEMETRY_CAPABILITIES = Object.freeze({
  claude: Object.freeze({
    prompts: 'supported', responses: 'supported', toolCalls: 'supported',
    commandExecutions: 'unsupported', fileChanges: 'unsupported',
    mcpCalls: 'unsupported', collaboration: 'unsupported',
  }),
  codex: Object.freeze({
    prompts: 'supported', responses: 'supported', toolCalls: 'unsupported',
    commandExecutions: 'unsupported', fileChanges: 'unsupported',
    mcpCalls: 'unsupported', collaboration: 'unsupported',
  }),
  opencode: Object.freeze({
    prompts: 'supported', responses: 'supported', toolCalls: 'supported',
    commandExecutions: 'unsupported', fileChanges: 'unsupported',
    mcpCalls: 'unsupported', collaboration: 'unsupported',
  }),
});

/** Empty host-neutral parser diagnostics. */
export function emptyTelemetryDiagnostics() {
  return {
    unitsSeen: 0,
    unitsParsed: 0,
    unitsWithUsage: 0,
    unitsWithPrompts: 0,
    unitsWithResponses: 0,
    prompts: 0,
    responses: 0,
    warnings: [],
    unknownKinds: {},
    unknownKindOverflow: 0,
  };
}

/**
 * Add one discovered source unit to the common diagnostic envelope.
 * A unit is one candidate transcript session in the current scan window.
 * `session === null` records that discovery succeeded but parsing did not.
 */
export function recordTelemetryUnit(target, session) {
  if (!target || typeof target !== 'object') return target;
  target.unitsSeen++;
  if (!session) return target;
  target.unitsParsed++;
  if (Array.isArray(session.usage) && session.usage.length) target.unitsWithUsage++;
  if (Number(session.prompts) > 0) target.unitsWithPrompts++;
  if (Number(session.responses) > 0) target.unitsWithResponses++;
  target.prompts += Number(session.prompts) || 0;
  target.responses += Number(session.responses) || 0;
  return target;
}

/** Add bounded parser warnings and unknown wire kinds without duplicates. */
export function addTelemetryDiagnostics(target, {
  warnings = [], unknownKinds = {}, unknownKindOverflow = 0,
} = {}) {
  if (!target || typeof target !== 'object') return target;
  for (const warning of warnings) {
    if (typeof warning === 'string' && warning && !target.warnings.includes(warning)) {
      target.warnings.push(warning);
    }
  }
  for (const [kind, count] of Object.entries(unknownKinds ?? {})) {
    if (!kind) continue;
    if (Object.hasOwn(target.unknownKinds, kind)) {
      target.unknownKinds[kind] += Number(count) || 0;
    } else if (Object.keys(target.unknownKinds).length < MAX_TELEMETRY_UNKNOWN_KINDS) {
      target.unknownKinds[kind] = Number(count) || 0;
    } else {
      target.unknownKindOverflow += Number(count) || 0;
    }
  }
  target.unknownKindOverflow += Math.max(0, Number(unknownKindOverflow) || 0);
  return target;
}

/** Return a stable, JSON-safe copy of the common envelope. */
export function finalizeTelemetryDiagnostics(value) {
  const out = emptyTelemetryDiagnostics();
  if (!value || typeof value !== 'object') return out;
  for (const key of [
    'unitsSeen', 'unitsParsed', 'unitsWithUsage', 'unitsWithPrompts',
    'unitsWithResponses', 'prompts', 'responses',
  ]) out[key] = Math.max(0, Number(value[key]) || 0);
  out.warnings = [...new Set((Array.isArray(value.warnings) ? value.warnings : [])
    .filter((warning) => typeof warning === 'string' && warning))];
  for (const [kind, count] of Object.entries(value.unknownKinds ?? {})) {
    if (typeof kind === 'string' && kind
      && Object.keys(out.unknownKinds).length < MAX_TELEMETRY_UNKNOWN_KINDS) {
      out.unknownKinds[kind] = Math.max(0, Number(count) || 0);
    } else if (typeof kind === 'string' && kind) {
      out.unknownKindOverflow += Math.max(0, Number(count) || 0);
    }
  }
  out.unknownKindOverflow += Math.max(0, Number(value.unknownKindOverflow) || 0);
  return out;
}

/**
 * Resolve the runtime capability state for one host/source. A source that is
 * absent, unreadable, or partially degraded cannot claim a measured zero for
 * a category the parser supports; it is `unavailable` instead.
 */
export function telemetryCapabilities(host, sourceStatus = 'unavailable') {
  const base = HOST_TELEMETRY_CAPABILITIES[host];
  if (!base) return Object.fromEntries(TELEMETRY_CATEGORIES.map((key) => [key, 'unavailable']));
  return Object.fromEntries(TELEMETRY_CATEGORIES.map((key) => [
    key,
    base[key] === 'supported' && sourceStatus !== 'ok' ? 'unavailable' : base[key],
  ]));
}
