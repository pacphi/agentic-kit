import { emptySummary } from './model.mjs';
import { sha256 } from './evidence.mjs';

const array = (value) => (Array.isArray(value) ? value : []);
const HOSTS = new Set(['claude', 'codex', 'opencode']);

function catalogConsumerHosts(footprint, finding) {
  const resource = finding?.resource ?? {};
  const visibleToHost = (candidate) => array(candidate?.hosts).includes(resource.host)
    || array(candidate?.presence).some((presence) => presence?.host === resource.host);
  const item = array(footprint?.catalog?.items).find((candidate) => (
    candidate?.canonicalId === resource.id
    || (resource.providerRef && candidate?.pluginRef === resource.providerRef && visibleToHost(candidate))
    || (resource.providerRef && candidate?.kind === 'plugin' && candidate?.name === resource.providerRef
      && visibleToHost(candidate))
  ));
  if (!item) return null;
  const bindings = array(item.consumerBindings).filter((binding) => binding?.enabled !== false);
  const hosts = [...new Set((bindings.length ? bindings.map((binding) => binding?.host)
    : [...array(item.hosts), ...array(item.presence).map((presence) => presence?.host)])
    .filter((host) => HOSTS.has(host)))].sort();
  return hosts.length
    ? { basis: 'catalog-presence', hosts, count: hosts.length, truncated: false }
    : null;
}

function unavailableFinding(providers, evidence) {
  const ids = [...new Set(providers)].sort();
  return {
    id: `maintenance-finding-${sha256({ classification: 'provider-evidence-unavailable', ids }).slice(0, 20)}`,
    state: 'unreadable-partial',
    bucket: 'needsReview',
    classification: 'provider-evidence-unavailable',
    safetyClass: 'never-automatic',
    resource: {
      id: 'system:maintenance-provider-evidence', kind: 'system-evidence',
      name: 'Native maintenance evidence', host: 'agentic-kit', scope: 'machine',
    },
    versions: {
      installed: null, recommended: null, producer: null,
      sourceRevision: null, cacheGeneration: null, contentDigest: null,
    },
    ownership: { owner: 'agentic-kit', authority: 'provider-registry', managed: true },
    evidence: {
      sources: ids.map((id) => `maintenance-provider:${id}`),
      asOf: evidence?.asOf ?? null, freshness: evidence?.status ?? 'unknown',
      completeness: 'partial', gaps: ['Native provider evidence is unavailable or incomplete.'],
    },
    observedUsage: { status: 'not-measured', statement: 'Usage was not used as action authority.' },
    impact: {
      summary: 'Affected resources remain preserved until their owning provider can prove current state.',
      bytes: null, files: null, dependencies: 'unknown',
    },
    nextAction: {
      operation: 'scan', label: 'Restore provider availability and rescan',
      providerId: 'maintenance.read-only', providerVersion: '1',
      safetyClass: 'never-automatic', rollback: 'reversible', restart: 'not-required', executable: false,
      recommendation: 'Restore the unavailable native provider, then run a deep System rescan.',
      steps: [
        'Check that the host CLI and its native inventory command are available.',
        'Repair provider configuration or authentication without changing unrelated resources.',
        'Run a deep System rescan and inspect the replacement findings.',
      ],
      preserved: ['All affected resources until provider evidence is complete'],
      blockedReason: 'Native provider evidence is unavailable or incomplete.',
    },
  };
}

function stableFinding(finding) {
  return {
    id: finding.id, state: finding.state, classification: finding.classification,
    safetyClass: finding.safetyClass, resource: finding.resource, versions: finding.versions,
    ownership: finding.ownership, nextAction: finding.nextAction,
  };
}

function stableDetection(provider, facts) {
  return {
    id: provider.id,
    version: provider.version ?? null,
    host: provider.host ?? null,
    status: facts?.status ?? 'unavailable',
    complete: facts?.complete === true,
    authority: facts?.authority ?? null,
  };
}

function notify(onProgress, payload) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(payload); } catch { /* progress observers cannot fail a scan */ }
}

export async function projectProviderFindings({ providers, footprint, model, onProgress }) {
  const derived = [];
  const unavailable = [];
  const detections = new Map();
  const total = providers.size;
  let done = 0;
  notify(onProgress, { phase: 'providers', done, total, unit: 'providers' });
  for (const provider of providers.values()) {
    let facts;
    try {
      facts = await provider.detect();
    } catch {
      facts = null;
    }
    detections.set(provider.id, facts);
    if (!facts || facts.status !== 'available' || facts.complete !== true) unavailable.push(provider.id);
    if (facts && typeof provider.findings === 'function') {
      try {
        derived.push(...array(await provider.findings(facts, {
          footprint, baseFindings: model.findings, evidence: model.freshness,
        })));
      } catch {
        detections.set(provider.id, null);
        if (!unavailable.includes(provider.id)) unavailable.push(provider.id);
      }
    }
    done += 1;
    notify(onProgress, { phase: 'providers', done, total, unit: 'providers' });
  }
  if (unavailable.length) derived.push(unavailableFinding(unavailable, model.freshness));

  const enriched = derived.map((finding) => {
    if (finding.consumerHosts) return finding;
    const consumerHosts = catalogConsumerHosts(footprint, finding);
    return consumerHosts ? { ...finding, consumerHosts } : finding;
  });

  const replacement = new Map(enriched
    .filter((finding) => model.findings.some((base) => base.resource.id === finding?.resource?.id))
    .map((finding) => [finding.resource.id, finding]));
  const additions = enriched.filter((finding) => !replacement.has(finding?.resource?.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const findings = [
    ...model.findings.map((finding) => {
      const derivedFinding = replacement.get(finding.resource.id);
      return derivedFinding && !derivedFinding.consumerHosts
        ? { ...derivedFinding, consumerHosts: finding.consumerHosts }
        : (derivedFinding ?? finding);
    }),
    ...additions,
  ];
  const summary = emptySummary();
  for (const finding of findings) summary[finding.bucket] += 1;
  const sourceFingerprint = sha256({
    footprint: model.sourceFingerprint,
    providerEvidence: [...providers.values()].map((provider) => (
      stableDetection(provider, detections.get(provider.id))
    )).sort((a, b) => a.id.localeCompare(b.id)),
    providers: enriched.map(stableFinding).sort((a, b) => a.id.localeCompare(b.id)),
  });
  return { findings, summary, sourceFingerprint, detections };
}
