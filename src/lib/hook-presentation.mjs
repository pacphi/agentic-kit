// Closed, release-versioned language for hook diagnostics. Audit providers own
// the machine facts; this module only turns known codes into user-facing copy.
// Unknown codes stay visible without echoing arbitrary diagnostic prose.

const FINDINGS = Object.freeze({
  'aqe-claude-timeout-unit-mismatch': Object.freeze({
    title: 'Timeout uses the wrong host units',
    explanation: 'The Agentic-QE definition uses a millisecond-shaped value where Claude expects seconds. The generated source must be corrected upstream.',
  }),
  'aqe-npx-hot-path-fallback': Object.freeze({
    title: 'Hook may resolve a package when it runs',
    explanation: 'No local Agentic-QE bundle was found, so this lifecycle definition can fall back to package resolution on the execution path.',
  }),
  'claude-projection-in-codex': Object.freeze({
    title: 'Claude-oriented hook is configured in Codex',
    explanation: 'The definition calls a Claude-oriented project helper from Codex. Its generator and intended host need to be established before changing it.',
  }),
  'consent-and-grants-not-inferred': Object.freeze({
    title: 'Adapter authority is not established',
    explanation: 'A valid adapter manifest does not prove consent, capability grants, reachability, or target-host compatibility.',
  }),
  'dynamic-shell': Object.freeze({
    title: 'Shell expansion needs review',
    explanation: 'This definition uses a shell wrapper, so expansion, working directory, and environment behavior need source-owner review.',
  }),
  'full-process-plugin': Object.freeze({
    title: 'Plugin runs inside the host process',
    explanation: 'Package source, installed version, and permissions require review because this OpenCode plugin runs with host-process authority.',
  }),
  'legacy-ruflo-project-hook': Object.freeze({
    title: 'Legacy helper is incompatible with this host',
    explanation: 'The audit recognized a legacy Ruflo Claude helper projection in Codex. Retirement requires exact source and replacement evidence.',
  }),
  'opaque-full-process-plugin': Object.freeze({
    title: 'Plugin behavior is opaque to this audit',
    explanation: 'Static event-name discovery cannot prove the behavior of a module that executes inside the OpenCode process.',
  }),
  'plugin-sessionend-budget-not-raised': Object.freeze({
    title: 'Plugin timeout does not raise the session budget',
    explanation: 'The plugin declaration cannot extend Claude’s settings-level SessionEnd budget, so effective runtime still depends on host configuration.',
  }),
  'probable-timeout-unit-mismatch': Object.freeze({
    title: 'Timeout units may be incorrect',
    explanation: 'The declared Claude timeout is unusually high and may have been authored as milliseconds instead of seconds.',
  }),
  'ruflo-codex-stop-output-not-json': Object.freeze({
    groupId: 'codex-stop-output-contract',
    title: 'Stop output is not host-compatible',
    explanation: 'This generated Ruflo AutoMemory handler writes human-readable status lines to Codex Stop stdout, where the host requires an empty response or one valid hook JSON object.',
  }),
  'session-end-timeout-clamped': Object.freeze({
    title: 'Declared timeout exceeds the host limit',
    explanation: 'Codex applies a lower effective timeout than this SessionEnd definition declares.',
  }),
  'sessionend-timeout-clamped': Object.freeze({
    title: 'Declared timeout exceeds the host limit',
    explanation: 'Claude applies a lower effective timeout than this SessionEnd definition declares.',
  }),
  'target-host-compatibility-unproven': Object.freeze({
    title: 'Target-host compatibility is not proven',
    explanation: 'The external adapter contract does not establish a compatible target host and version for this definition.',
  }),
  'trust-independent': Object.freeze({
    title: 'Runtime selection and trust are not established',
    explanation: 'Static configuration inspection does not prove that the host selected, trusted, or executed this definition.',
  }),
});

const UNKNOWN = Object.freeze({
  title: 'Unclassified configuration finding',
  explanation: 'The static audit recorded a finding that this dashboard does not yet describe. Inspect the referenced definition and use the code for support.',
});

export function presentHookFinding(code) {
  return FINDINGS[code] ?? UNKNOWN;
}

export function upstreamConstraintIdFor(code) {
  if ([
    'aqe-npx-hot-path-fallback', 'aqe-claude-timeout-unit-mismatch',
  ].includes(code)) return 'agentic-qe-3.14.0-stop-hook-generator';
  if (code === 'ruflo-codex-stop-output-not-json') return 'ruflo-3.38.20-stop-output-contract';
  return null;
}

export function hookSourceLabel(source = {}) {
  const kind = String(source.sourceKind ?? source.kind ?? 'unknown');
  if (kind === 'global' || kind === 'global-inline') return 'User configuration';
  if (kind === 'managed') return 'Managed configuration';
  if (kind.startsWith('project')) return 'Project configuration';
  if (kind.startsWith('plugin')) return source.pluginRef ? `Plugin ${String(source.pluginRef).slice(0, 64)}` : 'Plugin configuration';
  if (kind === 'external-adapter-manifest') return 'Adapter manifest';
  return 'Configuration source';
}

export function hookOwnerLabel(source = {}) {
  const owner = String(source.owner ?? '').trim();
  if (owner && owner !== 'unknown' && owner !== 'unknown-generator') return owner.slice(0, 64);
  const authority = String(source.authority ?? 'unknown');
  if (authority === 'user-owned') return 'User';
  if (authority === 'project-owned') return 'Project owner';
  if (authority === 'administrator-managed') return 'Administrator';
  if (authority === 'generated-runtime-copy') return 'Upstream generator';
  return 'Not established';
}
