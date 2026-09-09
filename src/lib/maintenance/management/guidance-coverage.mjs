import { HOST_LABELS } from './projection-builder.mjs';
import { isOptionalManagement } from './guidance-purpose.mjs';

const STATUS_LABELS = Object.freeze({
  checked: 'Automatic action checks completed', incomplete: 'Automatic action checks incomplete',
  unavailable: 'Automatic action checks unavailable', 'not-checked': 'Automatic action checks not run',
  unsupported: 'No automatic actions registered for this host',
});

/** Measurement and mutation support are independent. Missing support is not health. */
export function guidanceCoverage(inventory, providers = null, detections = new Map()) {
  const hosts = new Map();
  for (const placement of inventory.placements) {
    const measuredHosts = [...(placement.consumerHosts ?? [])];
    if (placement.kind === 'host-adapter' && placement.hostNamespace) measuredHosts.push(placement.hostNamespace);
    for (const host of new Set(measuredHosts)) {
      if (!hosts.has(host)) hosts.set(host, new Set());
      hosts.get(host).add(placement.placementId);
    }
  }
  return [...hosts].sort(([a], [b]) => a.localeCompare(b)).map(([host, ids]) => {
    const entries = (inventory.guidanceEntries ?? []).filter((entry) => ids.has(entry.placementId));
    const checks = providers && [...providers.values()].filter((provider) => provider.host === host);
    let status = 'not-checked';
    if (checks?.length === 0) status = 'unsupported';
    else if (checks?.length) {
      const facts = checks.map((provider) => detections.get(provider.id));
      if (facts.every((fact) => fact?.status === 'available' && fact.complete === true)) status = 'checked';
      else if (facts.some((fact) => fact?.status === 'available')) status = 'incomplete';
      else if (facts.some((fact) => fact != null)) status = 'unavailable';
    }
    return {
      host, label: HOST_LABELS[host] ?? host, placements: ids.size,
      recommendations: entries.filter((entry) => !isOptionalManagement(entry)).length,
      optionalActions: entries.filter(isOptionalManagement).length,
      actionKinds: [...new Set((checks || []).flatMap((provider) => provider.resourceKinds ?? []))].sort(),
      actionStatus: status, actionStatusLabel: STATUS_LABELS[status],
    };
  });
}
