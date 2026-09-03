// Host-neutral setup trust manifest. Host adapters declare every setup-time
// trust change in the registry; setup only filters/renders that declaration.
// This keeps a future host from gaining a silent permission/config path.
import { HOST_REGISTRY } from './adapters/index.mjs';
import { managedCompanionFor } from './adapters/companion-registry.mjs';
import { DEJA_VU_TARGETS } from './deja-vu.mjs';
import { targetAgentBrowserVersion } from './agent-browser.mjs';

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
    const mechanism = entry.scope === 'user'
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
        : `create a current-state recovery copy, remove this duplicate legacy Ruflo transport ${mechanism}, and verify its absence`,
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

/** @param {any} cfg
 * @param {{project?: boolean, hosts?: any[], companionPreflight?: any,
 *   codexRepairPlan?: any[]}} [options] */
export function setupTrustManifest(cfg, {
  companionPreflight, codexRepairPlan, ...options
} = {}) {
  return [
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
