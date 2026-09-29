// Additive project presentation evidence. Never replaces legacy origin counts.
import { sessionPresentation } from '../session-surface.mjs';
const RAW_FIELDS = ['entrypoint', 'originator', 'source', 'threadSource', 'sessionKind'];
const COUNT_BASES = ['declared-session-ids', 'transcript-files', 'database-sessions', 'recovered-project-sighting', 'mixed-observations'];
const token = (value) => typeof value === 'string' && value.length <= 80
  && (value === 'Codex Desktop' || /^[A-Za-z][A-Za-z0-9_.-]*$/u.test(value));

/** Merge aggregates without letting the last transcript overwrite earlier evidence. */
export function mergeSessionSurfaces(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry || !Number.isInteger(entry.sessions) || entry.sessions < 0) continue;
    const presentation = sessionPresentation(entry);
    const host = ['claude', 'codex', 'opencode'].includes(entry.host) ? entry.host : 'unknown';
    const initiator = ['person', 'automation', 'agent', 'imported-copy'].includes(entry.initiator) ? entry.initiator : 'unknown';
    const provider = presentation.provider === 'Unknown' ? null : entry.thirdPartyProvider;
    const key = `${host}:${presentation.surface}:${initiator}:${provider}`;
    if (!groups.has(key)) groups.set(key, { host, surface: presentation.surface, initiator,
      thirdPartyProvider: provider, thirdPartyProviderBasis: provider ? 'assistant-model-id' : null, attributes: [],
      sessions: 0, countBasis: entry.countBasis, rawEvidence: {}, rawEvidenceComplete: true });
    const row = groups.get(key);
    row.sessions += entry.sessions;
    row.attributes = [...new Set([...row.attributes, ...(Array.isArray(entry.attributes) ? entry.attributes : []).filter((value) =>
      ['on 3P', 'started from Claude Desktop', 'started from mobile', 'started from a project', 'started from web'].includes(value))])].sort();
    if (row.countBasis !== entry.countBasis || !COUNT_BASES.includes(row.countBasis)) row.countBasis = 'mixed-observations';
    row.rawEvidenceComplete &&= entry.rawEvidenceComplete !== false;
    for (const field of RAW_FIELDS) {
      const raw = entry.rawEvidence?.[field];
      const values = (Array.isArray(raw) ? raw : [raw]).filter(token);
      const union = [...new Set([...(row.rawEvidence[field] ?? []), ...values])].sort();
      if (union.length) row.rawEvidence[field] = union.slice(0, 16);
      if (union.length > 16) row.rawEvidenceComplete = false;
    }
  }
  return [...groups.values()].sort((a, b) => `${a.host}:${a.surface}:${a.initiator}:${a.thirdPartyProvider}`.localeCompare(`${b.host}:${b.surface}:${b.initiator}:${b.thirdPartyProvider}`));
}


export function sessionSurfaceSighting(sighting, host, weight) {
  const declared = sighting.sessionOrigin ?? {};
  return { host, surface: declared.surface, initiator: declared.initiator, rawEvidence: declared.rawEvidence,
    attributes: declared.attributes, sessions: weight, thirdPartyProvider: declared.thirdPartyProvider,
    thirdPartyProviderBasis: declared.thirdPartyProviderBasis,
    countBasis: sighting.origin === 'encoded-dir' ? 'recovered-project-sighting'
      : host === 'opencode' ? 'database-sessions' : host === 'claude' ? 'declared-session-ids' : 'transcript-files' };
}
