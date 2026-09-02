// Context Budget Intelligence domain primitives. This module is deliberately
// pure: callers acquire evidence elsewhere and pass only normalized facts.
// It never turns bytes into observed tokens, trusts an adapter's self-claim,
// or substitutes a catalogue maximum for a smaller runtime guard.

export const CONTEXT_BUDGET_POLICY = Object.freeze({
  schemaVersion: 1,
  startupTargetBps: 500,
  startupWarningBps: 700,
  startupCriticalBps: 1_000,
  dynamicWarningBps: 6_000,
  dynamicCompactBps: 7_000,
  dynamicHandoffBps: 7_500,
  reserveBps: 2_500,
});

const TRUSTED_PROVENANCE = new Set([
  'runtime-observed',
  'host-configured',
  'provider-catalog',
  'adapter-declared',
  'configured-fallback',
]);

const CURRENT_STATUSES = new Set([undefined, null, 'current', 'observed']);
const positiveTokens = (value) => Number.isSafeInteger(value) && value > 0;

export function estimateTokensFromBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError('bytes must be a non-negative safe integer');
  }
  return Object.freeze({
    tokens: Math.ceil(bytes / 3),
    unit: 'estimated-tokens',
    method: 'utf8-bytes-div-3-ceil',
    sourceBytes: bytes,
  });
}

/** Resolve the conservative ceiling from fresh, applicable evidence. A
 * larger published maximum remains visible to callers in their fact set but
 * cannot override a smaller trusted guard. */
export function resolveEffectiveContextCeiling(facts = []) {
  const input = Array.isArray(facts) ? facts : [];
  const applicable = input.filter((fact) => fact && typeof fact === 'object'
    && positiveTokens(fact.tokens)
    && TRUSTED_PROVENANCE.has(fact.provenance)
    && CURRENT_STATUSES.has(fact.status));
  if (!applicable.length) {
    return Object.freeze({
      state: 'unknown', tokens: null, kind: null, provenance: null, source: null,
      considered: 0, rejected: input.length,
    });
  }
  const selected = applicable.reduce((lowest, fact) => fact.tokens < lowest.tokens ? fact : lowest);
  return Object.freeze({
    state: 'resolved',
    tokens: selected.tokens,
    kind: typeof selected.kind === 'string' ? selected.kind : 'unspecified',
    provenance: selected.provenance,
    source: typeof selected.source === 'string' ? selected.source.slice(0, 128) : 'unknown',
    considered: applicable.length,
    rejected: input.length - applicable.length,
  });
}

function pressureBps(tokens, ceilingTokens) {
  return Number.isSafeInteger(tokens) && tokens >= 0 && positiveTokens(ceilingTokens)
    ? Math.round(tokens * 10_000 / ceilingTokens) : null;
}

function atOrBelow(tokens, ceilingTokens, thresholdBps) {
  return tokens * 10_000 <= thresholdBps * ceilingTokens;
}

function startupLevel(tokens, ceilingTokens, policy) {
  if (!Number.isSafeInteger(tokens) || tokens < 0 || !positiveTokens(ceilingTokens)) return 'unknown';
  if (atOrBelow(tokens, ceilingTokens, policy.startupTargetBps)) return 'target';
  if (atOrBelow(tokens, ceilingTokens, policy.startupWarningBps)) return 'above-target';
  if (atOrBelow(tokens, ceilingTokens, policy.startupCriticalBps)) return 'warning';
  return 'critical';
}

function atOrAbove(tokens, ceilingTokens, thresholdBps) {
  return tokens * 10_000 >= thresholdBps * ceilingTokens;
}

function dynamicAction(tokens, ceilingTokens, policy) {
  if (!Number.isSafeInteger(tokens) || tokens < 0 || !positiveTokens(ceilingTokens)) return 'unknown';
  if (atOrAbove(tokens, ceilingTokens, policy.dynamicHandoffBps)) return 'handoff';
  if (atOrAbove(tokens, ceilingTokens, policy.dynamicCompactBps)) return 'compact';
  if (atOrAbove(tokens, ceilingTokens, policy.dynamicWarningBps)) return 'warn';
  return 'continue';
}

/** @param {{ceilingTokens?: number|null, startupTokens?: number|null,
 * currentTokens?: number|null, policy?: typeof CONTEXT_BUDGET_POLICY}} [input] */
export function evaluateContextBudget({
  ceilingTokens, startupTokens = null, currentTokens = null, policy = CONTEXT_BUDGET_POLICY,
} = {}) {
  const startupPressureBps = pressureBps(startupTokens, ceilingTokens);
  const dynamicPressureBps = pressureBps(currentTokens, ceilingTokens);
  if (!positiveTokens(ceilingTokens)) {
    return Object.freeze({
      state: 'unknown', ceilingTokens: null,
      startup: Object.freeze({ tokens: startupTokens, pressureBps: null, level: 'unknown' }),
      dynamic: Object.freeze({ tokens: currentTokens, pressureBps: null, action: 'unknown' }),
      reserve: Object.freeze({ tokens: null, remainingTokens: null, breached: null }),
    });
  }
  const reserveTokens = Math.ceil(ceilingTokens * policy.reserveBps / 10_000);
  const remainingTokens = Number.isSafeInteger(currentTokens) && currentTokens >= 0
    ? Math.max(0, ceilingTokens - currentTokens) : null;
  return Object.freeze({
    state: 'evaluated', ceilingTokens,
    startup: Object.freeze({
      tokens: startupTokens,
      pressureBps: startupPressureBps,
      level: startupLevel(startupTokens, ceilingTokens, policy),
    }),
    dynamic: Object.freeze({
      tokens: currentTokens,
      pressureBps: dynamicPressureBps,
      action: dynamicAction(currentTokens, ceilingTokens, policy),
    }),
    reserve: Object.freeze({
      tokens: reserveTokens,
      remainingTokens,
      breached: remainingTokens === null ? null : remainingTokens < reserveTokens,
    }),
  });
}
