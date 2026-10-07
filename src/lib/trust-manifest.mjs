// Host-neutral setup trust manifest. Host adapters declare every setup-time
// trust change in the registry; setup only filters/renders that declaration.
// This keeps a future host from gaining a silent permission/config path.
import { HOST_REGISTRY } from './adapters/index.mjs';
import { targetAgentBrowserVersion } from './agent-browser.mjs';
import { managedIntent } from './ruflo-components/config.mjs';

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
      `policy file for ruflo's MCP governance (audit on, ${gov.maxCallsPerMinute} calls per minute); enforced on stdio launches by Ruflo 3.46.0 and newer; kept out of git with one line in the repository's .git/info/exclude`));
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

/** Ruflo's project daemon (ruflo-daemon-config.mjs): the flat keys in
 *  .claude-flow/config.json and start-on-use in .claude/settings.json. */
export function rufloDaemonTrustGroup(cfg, { project = false } = {}) {
  if (!project) return null;
  const change = (id, kind, value, effect) => ({ id, kind, scope: 'project', owner: 'agentic-kit', value, effect });
  const changes = [change('ruflo-daemon-config', 'project-file', '.claude-flow/config.json',
    'flat keys only, and only what this Ruflo needs: "daemon.idleSecs": 0 below 3.46.0 (ruvnet/ruflo#3194), '
    + '"daemon.resourceThresholds.minFreeMemoryPercent": 0 on macOS (ruvnet/ruflo#2935); other keys are kept')];
  if (cfg?.rufloDaemon?.autoStart !== false) {
    changes.push(change('ruflo-daemon-autostart', 'config', '.claude/settings.json claudeFlow.daemon.autoStart → true',
      'Ruflo starts the project daemon (memory backup and distillation) on the next ruflo command; the old value is kept for ak uninstall'));
  }
  changes.push({ ...change('ruflo-daemon-opt-out', 'config', 'kit.json → rufloDaemon.autoStart: false',
    'leave start-on-use as Ruflo set it'), scope: 'user' });
  return { componentId: 'ruflo-daemon', label: "Ruflo's project daemon", approvalPolicy: 'managed', changes };
}

/** @param {any} cfg
 * @param {{project?: boolean, hosts?: any[], codexRepairPlan?: any[]}} [options] */
export function setupTrustManifest(cfg, {
  codexRepairPlan, ...options
} = {}) {
  return [
    ...(cfg?.aqe !== false && cfg?.aqeEmbedding?.mode && cfg.aqeEmbedding.mode !== 'unmanaged' ? [{
      companionId: 'aqe-embedding', label: 'AQE semantic embeddings', approvalPolicy: 'explicit-setup',
      changes: [{ id: 'aqe-embedding', kind: 'embedding-runtime', scope: 'user/project', owner: 'agentic-kit',
        value: cfg.aqeEmbedding.mode,
        effect: cfg.aqeEmbedding.provisioning === 'ollama'
          ? 'use existing local Ollama, download all-minilm:22m (about 45 MB) and create missing AQE alias; configure enabled hosts; check the pattern index in a disposable folder; preserve existing vectors'
          : 'project selected backend to enabled hosts and verify with synthetic text, then check the pattern index in a disposable folder; no automatic package installation or corpus migration' }],
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
    ...[rufloComponentsTrustGroup(cfg), rufloDaemonTrustGroup(cfg, options)].filter(Boolean),
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
