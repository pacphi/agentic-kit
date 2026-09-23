// ADR-0058: one state per component, combining config intent, ruflo version support,
// projection results and evidence into a single plain-language view.
import { cmpVersions } from '../versions.mjs';
import { COMPONENTS } from './catalogue.mjs';
import { describeState } from './states.mjs';
import { managedIntent } from './config.mjs';
import { supports, RC_KEYS } from './env.mjs';
import { EVIDENCE_STALE_MS, readEvidenceCache } from './evidence.mjs';
import { readPolicy } from './policy.mjs';
import { reconcileClaudeComponentEnv } from '../claude-env-projection.mjs';

// The machine env key each RC-backed component projects — used to detect a
// user-set conflict (Claude host layer) and to know which components can go
// `partial` when a host is missing. Components without an entry here are
// either applied through other mechanisms (mcpGovernance's policy file,
// funnel's CLI toggle) or need no host at all (turnCredit, memoryFix2887).
const KEY_OF = { typesafePicker: RC_KEYS.typesafe, minilmPicker: RC_KEYS.embedder, learningProfile: RC_KEYS.mode };

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
  turnCredit: (e, at) => (e.turnCredit?.present === null ? [] : [ev('ruflo doctor', at, e.turnCredit?.present ? '@metaharness/turn-credit resolves' : 'turn-credit not found')]),
};

function evidenceLines(id, e) {
  if (!e) return [];
  const fn = EVIDENCE_LINES[id];
  return fn ? fn(e, e.capturedAt) : [];
}

function stateFor(component, { cfg, rufloVersion, evidence, projection, now }) {
  const { id, minRuflo } = component;
  if (id === 'encryptionAtRest') {
    const base = describeState('not-applied');
    return { ...base, meaning: `${base.meaning} Managed by ADR-0059, not yet implemented.` };
  }
  const intent = managedIntent(cfg, id);
  if (!intent) return describeState('user-managed');
  if (!supports(rufloVersion, minRuflo)) return describeState('needs-ruflo', { minRuflo });
  if (projection?.blocked?.[id]) return describeState('blocked', { reason: projection.blocked[id] });
  if (id === 'mcpGovernance' && projection?.policy === 'invalid') {
    return describeState('blocked', { reason: 'The policy file is invalid, so ruflo would refuse every tool call; ak removed enforcement for this project.' });
  }
  if (id === 'mcpGovernance' && projection?.policy === 'absent') return describeState('not-applied');
  if (id === 'mcpGovernance' && projection?.policy === 'foreign') {
    const base = describeState('user-managed');
    return { ...base, meaning: `${base.meaning} This project has its own .harness/mcp-policy.json, so ak leaves enforcement off.` };
  }
  if (KEY_OF[id] && projection?.claude?.conflicts?.includes(KEY_OF[id])) return describeState('user-managed');
  if (!evidence || now - Date.parse(evidence.capturedAt) > EVIDENCE_STALE_MS) return describeState('unknown');
  // ADR-305 precedence: env > enterprise-policy > user-config > project-config >
  // package-default. ak's own `ruflo funnel disable` always lands as the user-tier
  // ('user-config') source (apply.mjs's releaseFunnel gates its undo on the same
  // /user/i test). A funnel that reads disabled from any OTHER source is off, but
  // not by ak's hand — reported as user-managed (goal met, not an error) rather
  // than claiming credit ak didn't earn.
  if (id === 'funnel' && evidence.funnel?.enabled === false && !/user/i.test(evidence.funnel.decidedBy ?? '')) {
    const base = describeState('user-managed');
    return { ...base, meaning: `${base.meaning} Ruflo's funnel is already off, decided by ${evidence.funnel.decidedBy} — not ak's doing.` };
  }
  const result = confirmed(id, intent, evidence);
  if (id === 'memoryFix2887' && result === false) {
    return describeState('blocked', { reason: 'Run npm install -g ruflo@latest so ruflo resolves @claude-flow/memory 3.0.0-alpha.22 or newer.' });
  }
  if (result === null) {
    const reason = id === 'mcpGovernance' ? GOVERNANCE_UNOBSERVED_REASON : evidence.errors?.[ERROR_KEY_OF[id]] ?? '';
    return describeState('unknown', { reason });
  }
  if (result === false) return describeState('applied-unverified');
  if (KEY_OF[id] && projection?.missingHosts?.length) return describeState('partial', { hosts: projection.missingHosts });
  return describeState('active');
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
    summary: { active: components.filter((c) => c.state.id === 'active').length, total: components.length },
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
  const claude = reconcileClaudeComponentEnv(cfg, {
    projectRoot, rufloVersion, userSettingsFile, dryRun: true,
  });
  const conflicts = claude.findings
    .filter((f) => f.status === 'conflict')
    .map((f) => (f.reason ?? '').split(':')[0]);
  const evidence = readEvidenceCache(evidenceFile);
  const missingHosts = cfg?.integrations?.hosts?.codex ? ['Codex hooks'] : [];
  const policy = projectRoot ? readPolicy(projectRoot).state : null;
  return componentSnapshot({
    cfg,
    rufloVersion,
    evidence,
    now,
    projection: { claude: { conflicts, changed: claude.changed }, missingHosts, policy },
  });
}
