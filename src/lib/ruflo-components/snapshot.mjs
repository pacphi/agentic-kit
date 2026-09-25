// ADR-0058: one state per component, combining config intent, ruflo version support,
// projection results and evidence into a single plain-language view.
import { cmpVersions } from '../versions.mjs';
import { COMPONENTS } from './catalogue.mjs';
import { describeState } from './states.mjs';
import { managedIntent } from './config.mjs';
import { supports, RC_KEYS } from './env.mjs';
import { EVIDENCE_STALE_MS, OUTRANKS_USER, readEvidenceCache } from './evidence.mjs';
import { readPolicy } from './policy.mjs';
import { reconcileClaudeComponentEnv } from '../claude-env-projection.mjs';

// The machine env key each RC-backed component projects — used to detect a
// user-set conflict (Claude host layer) and to know which components can go
// `partial` when a host is missing. Components without an entry here are
// either applied through other mechanisms (mcpGovernance's policy file,
// funnel's CLI toggle) or need no host at all (turnCredit, memoryFix2887).
const KEY_OF = { typesafePicker: RC_KEYS.typesafe, minilmPicker: RC_KEYS.embedder, learningProfile: RC_KEYS.mode };
// Every key ak writes into Claude settings for a component, governance's project key
// included — what ak actually wrote is judged before any evidence (ADR-0058 §2).
const PROJECTED_KEY_OF = { ...KEY_OF, mcpGovernance: RC_KEYS.enforce };

// Maps a component id to the probe key collectEvidence() records errors
// under (see evidence.mjs's `call(args, key)` sites). memoryFix2887 and
// mcpGovernance read from installed-package/audit-log evidence, not a ruflo
// probe, so they have no error reason to surface here.
const ERROR_KEY_OF = {
  typesafePicker: 'typesafe', minilmPicker: 'route', learningProfile: 'intelligence',
  turnCredit: 'metaharness', funnel: 'funnel',
};

const ev = (source, capturedAt, detail) => ({ source, capturedAt, detail });

const CONFIRMERS = {
  typesafePicker: (intent, e) => (e.typesafe?.doctor
    ? (e.typesafe.resolves && !/not installed|disabled/i.test(e.typesafe.doctor.detail))
    : null),
  minilmPicker: (intent, e) => (e.minilm?.embedder ? e.minilm.embedder === 'minilm' : null),
  learningProfile: (intent, e) => (e.learning?.mode ? e.learning.mode === intent : null),
  turnCredit: (intent, e) => e.turnCredit?.present ?? null,
  memoryFix2887: (intent, e) => (e.memoryFix?.version ? cmpVersions(e.memoryFix.version, '3.0.0-alpha.22') >= 0 : null),
  funnel: (intent, e) => (e.funnel ? e.funnel.enabled === false : null),
  // ADR-0058 §2: "active" means confirmed by ruflo's own evidence. A readable audit log
  // with zero calls in the last 24h is not evidence enforcement ran — only activity is.
  mcpGovernance: (intent, e) => (e.governance?.audit?.audited > 0 ? true : null),
};

const GOVERNANCE_UNOBSERVED_REASON = 'No ruflo MCP tool calls have been audited in the last 24 hours, so enforcement has not been observed yet.';
// Ruflo 3.44.0 and earlier keep the policy enforcer in MCPServerManager, which neither stdio
// entry point (bin/mcp-server.js, `ruflo mcp start`) reaches — upstream request 6.
const GOVERNANCE_NOT_WIRED = 'ruflo 3.44.0 and earlier do not enforce the policy on stdio MCP launches, so no audit records are expected until upstream request 6 lands.';
const governanceUnobservedReason = (rufloVersion) => (!rufloVersion || cmpVersions(rufloVersion, '3.44.0') <= 0
  ? `${GOVERNANCE_UNOBSERVED_REASON} ${GOVERNANCE_NOT_WIRED}` : GOVERNANCE_UNOBSERVED_REASON);

/** Returns true (confirmed), false (contradicted) or null (no evidence). */
function confirmed(id, intent, e) {
  const fn = CONFIRMERS[id];
  return fn ? fn(intent, e) : null;
}

const EVIDENCE_LINES = {
  typesafePicker: (e, at) => (e.typesafe?.doctor ? [ev('ruflo doctor', at, e.typesafe.doctor.detail)] : []),
  minilmPicker: (e, at) => (e.minilm?.embedder ? [ev('hooks route probe', at, `embedder=${e.minilm.embedder}`)] : []),
  learningProfile: (e, at) => {
    const l = e.learning ?? {};
    const engine = l.engineLoaded === false ? 'SONA engine not loaded — the profile has nothing to tune yet'
      : l.engineLoaded ? 'SONA engine loaded' : 'engine state unknown';
    return [ev('hooks intelligence stats', at, `mode ${l.mode ?? 'unknown'}; ${engine}; last training ${l.lastTrainingSeconds ?? '?'}s ago; ${l.trajectories ?? '?'} trajectories`)];
  },
  mcpGovernance: (e, at) => {
    const a = e.governance?.audit;
    return a
      ? [ev('MCP audit log (last 24 h)', at, `${a.audited} calls audited, ${a.refused} refused${a.reasons.length ? `; latest: ${a.reasons.at(-1)}` : ''}; shared log across all projects`)]
      : [ev('MCP audit log', at, 'no audit records yet; shared log across all projects')];
  },
  funnel: (e, at) => (e.funnel ? [ev('ruflo funnel status', at, `${e.funnel.enabled ? 'enabled' : 'disabled'} (decided by ${e.funnel.decidedBy})`)] : []),
  memoryFix2887: (e, at) => (e.memoryFix?.version ? [ev('@claude-flow/memory', at, e.memoryFix.version)] : []),
  turnCredit: (e, at) => (e.turnCredit?.present == null ? [] : [ev('ruflo doctor', at, e.turnCredit?.present ? '@metaharness/turn-credit resolves' : 'turn-credit not found')]),
};

function evidenceLines(id, e) {
  if (!e) return [];
  const fn = EVIDENCE_LINES[id];
  return fn ? fn(e, e.capturedAt) : [];
}

const withMeaning = (id, meaning) => ({ ...describeState(id), meaning });

// ADR-0059 has not shipped, so ak manages nothing here yet: an info row with no sync
// promise, and outside the "N of M active" count.
const ENCRYPTION_STATE = Object.freeze(describeState('not-managed-yet'));

/** An opted-out component is the user's — unless ak still holds a change it made while
 *  managing it; that is fixable, because the next sync releases it. */
function optOutState(id, cfg, projection) {
  if (id === 'funnel' && cfg?.integrations?.ownership?.rufloComponents?.funnelDisabled) {
    return withMeaning('not-applied', 'You set funnel to true, but the `ruflo funnel disable` ak ran earlier is still in force; ak sync re-enables the funnel.');
  }
  const key = PROJECTED_KEY_OF[id];
  if (key && projection?.claude?.keys?.[key]?.state === 'release') {
    return withMeaning('not-applied', `You opted out, but the ${key} value ak set earlier is still in Claude's settings; ak sync removes it.`);
  }
  return describeState('user-managed');
}

function governancePolicyState(projection) {
  if (projection?.policy === 'invalid') {
    return describeState('blocked', { reason: 'The policy file is invalid; ruflo\'s policy enforcer fails closed on an invalid file, so ak removed enforcement for this project.' });
  }
  if (projection?.policy === 'absent') return describeState('not-applied');
  if (projection?.policy === 'foreign') {
    const base = describeState('user-managed');
    return { ...base, meaning: `${base.meaning} This project has its own .harness/mcp-policy.json, so ak leaves enforcement off.` };
  }
  return null;
}

/** What ak actually wrote into Claude settings for this component, or null when that
 *  has converged (only then may evidence decide). */
function projectedState(id, projection) {
  const key = PROJECTED_KEY_OF[id];
  const k = key && projection?.claude?.keys?.[key];
  if (!k) return null;
  const base = describeState('user-managed');
  switch (k.state) {
    case 'blocked': return describeState('blocked', { reason: `Claude settings could not be updated: ${k.reason}.` });
    case 'foreign': return { ...base, meaning: `${base.meaning} Claude settings already hold your own ${key} value.` };
    case 'user-edited': return { ...base, meaning: `${base.meaning} You changed the ${key} value ak set in Claude settings.` };
    case 'write': return describeState('not-applied', { reason: `Claude settings do not have ${key} set to ak's value yet.` });
    case 'restore': return describeState('drifted', { reason: `${key} was removed from Claude settings.` });
    default: return null;
  }
}

/** The funnel's deciding source, when it is not ak's own user-tier disable. */
function funnelSourceState(funnel) {
  if (!funnel) return null;
  const base = describeState('user-managed');
  // ADR-305 precedence: env > enterprise-policy > user-config > project-config >
  // package-default. ak's own `ruflo funnel disable` always lands as the user-tier
  // ('user-config') source (apply.mjs's releaseFunnel gates its undo on the same
  // /user/i test). A funnel that reads disabled from any OTHER source is off, but
  // not by ak's hand — reported as user-managed (goal met, not an error) rather
  // than claiming credit ak didn't earn.
  if (funnel.enabled === false && !/user/i.test(funnel.decidedBy ?? '')) {
    return { ...base, meaning: `${base.meaning} Ruflo's funnel is already off, decided by ${funnel.decidedBy} — not ak's doing.` };
  }
  if (funnel.enabled && OUTRANKS_USER.test(funnel.decidedBy ?? '')) {
    return { ...base, meaning: `${base.meaning} Ruflo's funnel is on, decided by ${funnel.decidedBy}, which outranks the ruflo funnel disable ak would run.` };
  }
  return null;
}

function evidenceState(component, intent, { evidence, projection, now }) {
  const { id } = component;
  if (!evidence || now - Date.parse(evidence.capturedAt) > EVIDENCE_STALE_MS) return describeState('unknown');
  // ADR-0058 §4: a Node version switch can drop the global package; a restart cannot bring
  // it back, the next sync reinstalls it.
  if (id === 'typesafePicker' && evidence.typesafe?.resolves === false) {
    return describeState('not-applied', { reason: '@ruvector/typesafe no longer resolves from ruflo\'s install (for example after a Node version switch); ak sync reinstalls it.' });
  }
  const funnel = id === 'funnel' ? funnelSourceState(evidence.funnel) : null;
  if (funnel) return funnel;
  const result = confirmed(id, intent, evidence);
  if (id === 'memoryFix2887' && result === false) {
    return describeState('blocked', { reason: 'Run npm install -g ruflo@latest so ruflo resolves @claude-flow/memory 3.0.0-alpha.22 or newer.' });
  }
  if (result === null) {
    const reason = id === 'mcpGovernance' ? governanceUnobservedReason(evidence.rufloVersion) : evidence.errors?.[ERROR_KEY_OF[id]] ?? '';
    return describeState('unknown', { reason });
  }
  // A restart cannot turn the funnel off (outranking sources were handled above), but
  // `ruflo funnel disable` can: fixable, so sync re-disables it after a hand-back.
  if (result === false && id === 'funnel') {
    return describeState('not-applied', { reason: `Ruflo's funnel is on (decided by ${evidence.funnel.decidedBy}); ak sync runs ruflo funnel disable.` });
  }
  if (result === false) return describeState('applied-unverified');
  if (KEY_OF[id] && projection?.missingHosts?.length) return describeState('partial', { hosts: projection.missingHosts });
  return describeState('active');
}

function stateFor(component, ctx) {
  const { id, minRuflo } = component;
  const { cfg, rufloVersion, projection } = ctx;
  if (id === 'encryptionAtRest') return ENCRYPTION_STATE;
  const intent = managedIntent(cfg, id);
  if (!intent) return optOutState(id, cfg, projection);
  if (!supports(rufloVersion, minRuflo)) return describeState('needs-ruflo', { minRuflo });
  if (projection?.blocked?.[id]) return describeState('blocked', { reason: projection.blocked[id] });
  if (id === 'mcpGovernance') {
    const policy = governancePolicyState(projection);
    if (policy) return policy;
  }
  return projectedState(id, projection) ?? evidenceState(component, intent, ctx);
}

function valueOf(intent) {
  if (intent === true) return 'on';
  if (intent === 'off') return 'off';
  if (typeof intent === 'object' && intent) return `${intent.maxCallsPerMinute} calls/min, audit on`;
  return intent || 'not managed';
}

export function classifyComponent(component, ctx) {
  const intent = managedIntent(ctx.cfg, component.id);
  return {
    id: component.id,
    label: component.label,
    managed: Boolean(intent),
    value: valueOf(intent),
    state: stateFor(component, ctx),
    explain: component.explain,
    options: component.options ?? null,
    evidence: evidenceLines(component.id, ctx.evidence),
  };
}

export function componentSnapshot({ cfg, rufloVersion, evidence, projection, now = Date.now() }) {
  const components = COMPONENTS.map((c) => classifyComponent(c, { cfg, rufloVersion, evidence, projection, now }));
  return {
    rufloVersion,
    capturedAt: evidence?.capturedAt ?? null,
    components,
    summary: {
      active: components.filter((c) => c.state.id === 'active').length,
      total: components.filter((c) => c.state.id !== 'not-managed-yet').length,
    },
  };
}

/** Controller ruling 3: the ONE read-only projection every surface (status's own
 *  section, and Task 10's dashboard) builds a snapshot from — so none of them
 *  re-implements it. Never spawns anything and never writes: the Claude env read
 *  is a dry run, and the evidence comes from whatever is already cached (a
 *  caller wanting fresher evidence collects + writes it BEFORE calling this,
 *  e.g. `ak status --refresh`). `projectRoot` may be null (no repo at `cwd`),
 *  in which case policy state is reported as null rather than probed. */
export function rufloComponentsPayload({
  cfg, rufloVersion, projectRoot, evidenceFile, userSettingsFile = undefined, now = Date.now(),
}) {
  // Mirrors `ak status`'s one "ruflo not installed; nothing managed" row instead of eight
  // needs-ruflo cards for software that is not there.
  if (!rufloVersion) return { rufloVersion: null, capturedAt: null, components: [], summary: { active: 0, total: 0 } };
  const claude = reconcileClaudeComponentEnv(cfg, {
    projectRoot, rufloVersion, userSettingsFile, dryRun: true,
  });
  const evidence = readEvidenceCache(evidenceFile);
  const missingHosts = cfg?.integrations?.hosts?.codex ? ['Codex hooks'] : [];
  const policy = projectRoot ? readPolicy(projectRoot).state : null;
  return componentSnapshot({
    cfg,
    rufloVersion,
    evidence,
    now,
    projection: { claude: { keys: claudeKeyStates(claude), changed: claude.changed }, missingHosts, policy },
  });
}

/** Per-key projection state across every Claude settings file a reconcile touched:
 *  `{ KEY: { state, reason } }`, where a file-level failure marks each of that file's keys
 *  'blocked' with the file's reason. */
export function claudeKeyStates(claude) {
  const keys = {};
  for (const f of claude?.findings ?? []) {
    for (const [key, state] of Object.entries(f.keys ?? {})) {
      keys[key] = { state, reason: f.reason ?? f.conflicts?.find((c) => c.key === key)?.reason ?? '' };
    }
  }
  return keys;
}
