import { emptySummary } from './model.mjs';
import { sha256 } from './evidence.mjs';

const array = (value) => (Array.isArray(value) ? value : []);

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

export async function projectProviderFindings({ providers, footprint, model }) {
  const derived = [];
  const unavailable = [];
  const detections = new Map();
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
  }
  if (unavailable.length) derived.push(unavailableFinding(unavailable, model.freshness));

  const replacement = new Map(derived
    .filter((finding) => model.findings.some((base) => base.resource.id === finding?.resource?.id))
    .map((finding) => [finding.resource.id, finding]));
  const additions = derived.filter((finding) => !replacement.has(finding?.resource?.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const findings = [
    ...model.findings.map((finding) => replacement.get(finding.resource.id) ?? finding),
    ...additions,
  ];
  const summary = emptySummary();
  for (const finding of findings) summary[finding.bucket] += 1;
  const sourceFingerprint = sha256({
    footprint: model.sourceFingerprint,
    providers: derived.map(stableFinding).sort((a, b) => a.id.localeCompare(b.id)),
  });
  return { findings, summary, sourceFingerprint, detections };
}
