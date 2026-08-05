// Host-neutral setup trust manifest. Host adapters declare every setup-time
// trust change in the registry; setup only filters/renders that declaration.
// This keeps a future host from gaining a silent permission/config path.
import { HOST_REGISTRY } from './adapters/index.mjs';

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

export function setupTrustManifest(cfg, options = {}) {
  return trustManifestForOperation(cfg, { ...options, operation: 'setup' });
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
      : 'approval policy receives the listed grants';
    return [
      `${group.label} — ${posture}`,
      ...group.changes.map((change) => (
        `  • [${change.scope}] ${change.kind}: ${change.value} — ${change.owner}: ${change.effect}`
      )),
    ];
  });
}
