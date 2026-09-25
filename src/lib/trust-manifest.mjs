// Host-neutral setup trust manifest. Host adapters declare every setup-time
// trust change in the registry; setup only filters/renders that declaration.
// This keeps a future host from gaining a silent permission/config path.
import { HOST_REGISTRY } from './adapters/index.mjs';
import { managedCompanionFor } from './adapters/companion-registry.mjs';
import { DEJA_VU_TARGETS } from './deja-vu.mjs';
import { targetAgentBrowserVersion } from './agent-browser.mjs';
import { managedIntent } from './ruflo-components/config.mjs';

const DEJA_VU = managedCompanionFor('deja-vu');
const AUTO_EVENTS = Object.freeze({
  claude: 'session start, prompt submit, pre-compaction, PreToolUse command/edit, failed-command follow-up',
  codex: 'session start, PreToolUse Bash/apply_patch, failed-command follow-up',
  opencode: 'session context, per-prompt recall, pre-compaction (no action-time PreToolUse)',
});

const enabledSet = (cfg) => new Set(Object.entries(cfg?.integrations?.hosts ?? {})
  .filter(([, enabled]) => enabled)
  .map(([id]) => id));

function featuresMatch(change, context) {
  return (change.features ?? []).every((feature) => context[feature] === true);
}

/** Return applicable trust changes grouped by host. `hosts` is injectable so
 * registry construction tests can prove a newly-added host needs no setup
 * command branch to participate. */
export function trustManifestForOperation(cfg, {
  project = false,
  hosts = HOST_REGISTRY,
  operation = 'setup',
} = {}) {
  const context = {
    project,
    aqe: cfg?.aqe !== false,
    brain: cfg?.ruvnetBrain !== false,
  };
  const enabled = enabledSet(cfg);
  return hosts.map((host) => ({
    hostId: host.id,
    label: host.label,
    approvalPolicy: host.trust.approvalPolicy,
    changes: host.trust.changes.filter((change) => (
      (change.requiresHostEnabled === false || enabled.has(host.id))
      && change.operations.includes(operation)
      && featuresMatch(change, context)
    )),
  })).filter((group) => group.changes.length > 0);
}

export function dejaVuSetupTrustManifest(cfg, preflight) {
  const intent = cfg?.integrations?.tools?.dejaVu;
  if (!preflight) return [];
  if (intent?.enabled !== true) {
    const removals = (preflight.plan?.operations ?? [])
      .filter((entry) => entry.kind === 'target-remove' && DEJA_VU_TARGETS[entry.host]?.[entry.mode])
      .map((entry) => ({
        id: `deja-vu-target-remove-${entry.host}`,
        kind: 'companion-target-removal', scope: 'user', owner: 'agentic-kit',
        value: DEJA_VU_TARGETS[entry.host][entry.mode],
        effect: `remove only the receipt-owned ${entry.host} wiring; preserve the npm package, transcripts, and index`,
      }));
    return removals.length ? [{
      companionId: DEJA_VU.id,
      label: `${DEJA_VU.label} managed companion removal`,
      approvalPolicy: 'explicit-opt-in',
      changes: removals,
    }] : [];
  }
  const packageOperation = preflight.plan?.operations?.find((entry) =>
    entry.kind === 'package-install' || entry.kind === 'package-upgrade');
  const rawVersion = packageOperation?.version ?? preflight.facts?.install?.version;
  const version = typeof rawVersion === 'string'
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(rawVersion)
    ? rawVersion : 'unknown';
  const packageManaged = !!packageOperation
    || preflight.facts?.install?.ownership === 'agentic-kit'
    || preflight.facts?.install?.receiptState === 'current';
  const changes = [{
    id: 'deja-vu-package',
    kind: packageManaged ? 'npm-package' : 'npm-package-observation',
    scope: 'global', owner: packageManaged ? 'agentic-kit' : 'user/external',
    value: `${DEJA_VU.install.npmPackage}@${version}`,
    effect: packageManaged
      ? 'install or retain this exact global npm companion version and record only Agentic Kit-owned changes'
      : 'use this compatible external installation without adopting, updating, or removing it',
  }];
  for (const entry of preflight.plan?.operations ?? []) {
    const priorTarget = entry.kind === 'target-remove'
      ? DEJA_VU_TARGETS[entry.host]?.[entry.mode] : null;
    if (!priorTarget) continue;
    changes.push({
      id: `deja-vu-prior-target-${entry.host}`, kind: 'companion-target-removal',
      scope: 'user', owner: 'agentic-kit', value: priorTarget,
      effect: `remove only the receipt-owned prior ${entry.host} wiring before changing mode`,
    });
  }
  for (const host of intent.hosts ?? []) {
    const target = DEJA_VU_TARGETS[host]?.[intent.mode];
    if (!target) continue;
    changes.push({
      id: `deja-vu-target-${host}`, kind: 'companion-target', scope: 'user', owner: 'agentic-kit',
      value: target,
      effect: `wire only the explicit ${host} ${intent.mode} target`,
    });
    if (intent.mode === 'auto') changes.push({
      id: `deja-vu-events-${host}`, kind: 'automatic-recall', scope: 'user', owner: 'deja-vu',
      value: `${host}: ${AUTO_EVENTS[host]}`,
      effect: 'recall may inject untrusted local-history context automatically at these events, including action time where listed',
    });
  }
  if (intent.indexOnSetup !== false) changes.push({
    id: 'deja-vu-index', kind: 'history-index', scope: 'global', owner: 'deja-vu',
    value: 'plaintext global deja-vu index with best-effort redaction',
    effect: 'read enabled hosts\' local transcripts and run one bounded `deja index`; embeddings and cross-machine sync remain disabled',
  });
  changes.push({
    id: 'deja-vu-health', kind: 'health-check', scope: 'global', owner: 'agentic-kit',
    value: 'deja doctor --json --offline (schema v2)',
    effect: 'inspect bounded health facts without exposing transcript content or local paths; removal preserves history/index unless separately purged',
  });
  return [{
    companionId: DEJA_VU.id,
    label: `${DEJA_VU.label} managed companion`,
    approvalPolicy: 'explicit-opt-in',
    changes,
  }];
}

/** @param {any[]} [plan] bounded entries from codexMcpRepairPlan() */
export function codexMcpRepairTrustManifest(plan = []) {
  const changes = plan.filter((entry) => (
    (entry?.scope === 'project' || entry?.scope === 'user')
    && ((entry?.repairKind === 'recursive-codex' && entry?.name === 'codex')
      || (entry?.repairKind === 'legacy-ruflo' && entry?.name === 'claude-flow'))
  )).map((entry) => {
    const mechanism = entry.scope === 'user' && entry.repairKind === 'recursive-codex'
      ? 'through `codex mcp`'
      : 'with a bounded exact-table edit';
    return {
      id: `codex-mcp-repair-${entry.scope}-${entry.name}`,
      kind: 'mcp-registration-removal',
      scope: entry.scope,
      owner: 'user/external',
      value: `[mcp_servers.${entry.name}]`,
      effect: entry.repairKind === 'recursive-codex'
        ? `create a current-state recovery copy, remove this deprecated recursive Codex transport ${mechanism}, and verify its absence`
        : `create a current-state recovery copy, replace this duplicate legacy Ruflo transport ${mechanism} with a disabled placeholder (so Codex's Claude config import cannot re-add it), and verify it is disabled${entry.scope === 'user' ? '; remember this recognized correction for future setup/sync runs while the managed workspace-aware replacement remains present' : ''}`,
    };
  });
  if (!changes.length) return [];
  return [{
    componentId: 'codex-mcp-repair',
    label: 'Codex MCP topology repair',
    approvalPolicy: 'unchanged',
    changes,
  }];
}

// Controller rulings 2 + 3 (ADR-0058 disclosure): the funnel entry names the
// irreversible funnel-ID/event-queue deletion `ruflo funnel disable` performs
// beyond the toggle itself (apply.mjs's ensureFunnel grounds this against
// ruflo's own funnel command); the governance entries make clear enforcement
// only ever applies to the policy file ak itself wrote — a project's own
// pre-existing .harness/mcp-policy.json is left alone (policy.mjs's foreign
// state).
export function rufloComponentsTrustGroup(cfg) {
  const change = (id, kind, scope, value, effect) => ({ id, kind, scope, owner: 'agentic-kit', value, effect });
  const changes = [];
  if (managedIntent(cfg, 'typesafePicker')) {
    changes.push(change('rc-typesafe-package', 'npm-package', 'global', '@ruvector/typesafe',
      'semantic agent picker library; ruflo ≥ 3.43.0 only'));
    changes.push(change('rc-typesafe-env', 'env', 'user', 'CLAUDE_FLOW_ROUTER_TYPESAFE=1', 'route agents by meaning; falls back when unsure'));
  }
  if (managedIntent(cfg, 'minilmPicker')) changes.push(change('rc-minilm-env', 'env', 'user', 'CLAUDE_FLOW_ROUTER_EMBEDDER=minilm', 'MiniLM routing; ~5 ms per prompt; ruflo ≥ 3.44.0'));
  const gov = managedIntent(cfg, 'mcpGovernance');
  if (gov) {
    changes.push(change('rc-governance-file', 'project-file', 'project', '.harness/mcp-policy.json',
      `policy file for ruflo's MCP governance (audit on, ${gov.maxCallsPerMinute} calls per minute); not yet enforced on stdio launches by ruflo ≤ 3.44.0`));
    changes.push(change('rc-governance-env', 'env', 'project', 'RUFLO_MCP_ENFORCE_POLICY=1',
      'enforced only against the policy file ak itself wrote; a project\'s own existing .harness/mcp-policy.json is left alone'));
  }
  const profile = managedIntent(cfg, 'learningProfile');
  if (profile) changes.push(change('rc-learning-env', 'env', 'user', `RUFLO_INTELLIGENCE_MODE=${profile}`, 'explicit learning profile'));
  if (managedIntent(cfg, 'funnel') === 'off') {
    changes.push(change('rc-funnel', 'cli-state', 'user', 'ruflo funnel disable',
      'no promotional tips or statusline promos; also deletes ruflo\'s local funnel ID and event queue'));
  }
  if (!changes.length) return null;
  changes.push(change('rc-opt-out', 'config', 'user', 'kit.json → rufloComponents', 'set any component to false to leave it alone'));
  return { componentId: 'ruflo-components', label: 'Managed ruflo components (ADR-0058)', approvalPolicy: 'managed', changes };
}

/** @param {any} cfg
 * @param {{project?: boolean, hosts?: any[], companionPreflight?: any,
 *   codexRepairPlan?: any[]}} [options] */
export function setupTrustManifest(cfg, {
  companionPreflight, codexRepairPlan, ...options
} = {}) {
  return [
    ...(cfg?.aqe !== false && cfg?.aqeEmbedding?.mode && cfg.aqeEmbedding.mode !== 'unmanaged' ? [{
      companionId: 'aqe-embedding', label: 'AQE semantic embeddings', approvalPolicy: 'explicit-setup',
      changes: [{ id: 'aqe-embedding', kind: 'embedding-runtime', scope: 'user/project', owner: 'agentic-kit',
        value: cfg.aqeEmbedding.mode,
        effect: cfg.aqeEmbedding.provisioning === 'ollama'
          ? 'use existing local Ollama, download all-minilm:22m (about 45 MB) and create missing AQE alias; configure enabled hosts; preserve existing vectors'
          : 'project selected backend to enabled hosts and verify with synthetic text; no automatic package installation or corpus migration' }],
    }] : []),
    ...trustManifestForOperation(cfg, { ...options, operation: 'setup' }),
    ...codexMcpRepairTrustManifest(codexRepairPlan),
    ...(cfg?.agentBrowser === false ? [] : [{
      componentId: 'agent-browser',
      label: 'Managed Ruflo browser executor',
      approvalPolicy: 'managed',
      changes: [
        {
          id: 'agent-browser-package', kind: 'npm-package', scope: 'global', owner: 'agentic-kit',
          value: `agent-browser@${targetAgentBrowserVersion() ?? 'unsupported'}`,
          effect: 'install the exact Ruflo-compatible native CLI with its reviewed postinstall and verify the package-owned executable',
        },
        {
          id: 'agent-browser-config', kind: 'runtime-config', scope: 'user', owner: 'agentic-kit',
          value: '~/.config/agentic-kit/agent-browser.json',
          effect: 'give only managed Ruflo MCP children a trusted headless config, bypassing repository config discovery',
        },
        {
          id: 'agent-browser-payload', kind: 'browser-download', scope: 'user', owner: 'agent-browser',
          value: '~/.agent-browser/browsers (only when no local Chrome is available)',
          effect: 'download Chrome for Testing without privileged --with-deps; preserve browser/session/profile data on uninstall',
        },
      ],
    }]),
    ...[rufloComponentsTrustGroup(cfg)].filter(Boolean),
    ...dejaVuSetupTrustManifest(cfg, companionPreflight),
  ];
}

export function newlyEnabledHostTrustManifest(cfg, enabledHostIds, {
  project = true,
  hosts = HOST_REGISTRY,
  operation = 'host-pick',
} = {}) {
  const previous = enabledSet(cfg);
  const desired = new Set(enabledHostIds);
  const newlyEnabled = hosts.filter((host) => desired.has(host.id) && !previous.has(host.id));
  if (!newlyEnabled.length) return [];
  const nextCfg = {
    ...cfg,
    integrations: {
      ...(cfg?.integrations ?? {}),
      hosts: Object.fromEntries([...desired].map((id) => [id, true])),
    },
  };
  return trustManifestForOperation(nextCfg, { project, hosts: newlyEnabled, operation });
}

/** @param {string} hostId
 * @param {{ kind?: string, hosts?: readonly any[] }} [options] */
export function trustChangesForHost(hostId, { kind, hosts = HOST_REGISTRY } = {}) {
  const host = hosts.find((entry) => entry.id === hostId);
  if (!host) return [];
  return host.trust.changes.filter((change) => !kind || change.kind === kind);
}

export function autoApproveValues(hostId, options) {
  return trustChangesForHost(hostId, { ...options, kind: 'auto-approve' })
    .map((change) => change.value);
}

export function trustManifestLines(manifest) {
  return manifest.flatMap((group) => {
    const posture = group.approvalPolicy === 'unchanged'
      ? 'approval/sandbox policy unchanged'
      : group.approvalPolicy === 'explicit-opt-in'
        ? 'explicit companion consent required; host approval/sandbox policy unchanged'
        : group.componentId
          ? 'managed component changes disclosed; host approval/sandbox policy unchanged'
          : 'approval policy receives the listed grants';
    return [
      `${group.label} — ${posture}`,
      ...group.changes.map((change) => (
        `  • [${change.scope}] ${change.kind}: ${change.value} — ${change.owner}: ${change.effect}`
      )),
    ];
  });
}
