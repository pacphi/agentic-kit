// The System page's slim read model (#237 M4, decision 8). GET /api/system
// serves the footprint collector's payload verbatim, the same shape as
// `ak system --json`, and that stays the complete, documented contract. Its
// catalog repeats every presence fact in item.presence, item.consumerBindings,
// item.artifacts[].consumers and again in top-level artifacts/consumerBindings,
// so it grows with items × projects × hosts (tens of MB on a real machine),
// while the page draws only counts, the host profile, the presence matrix and
// project pressure. GET /api/system/summary applies this projection and the
// page (including the Runtime view's 30 s poll) reads that instead.
//
// Allow-list, not drop-list: a field added to the catalog later stays off the
// page's wire until the page actually needs it. Every other section passes
// through untouched. Pure; never mutates its input.

/** Catalog keys the System page reads, copied through as-is. */
export const SUMMARY_CATALOG_KEYS = Object.freeze([
  'schemaVersion', 'asOf', 'complete', 'degraded', 'truncated', 'partial',
  'hosts', 'kinds', 'scopes', 'counts', 'perHost', 'projects',
]);

/** Distinct plugin providers of an item, reduced to what the presence matrix
 *  prints (`ref` and `version`), in the `presence[].provider` shape the page
 *  already reads — so the page code is the same for both endpoints. */
function summaryPresence(presence) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(presence) ? presence : []) {
    const provider = row?.provider;
    if (!provider || typeof provider !== 'object') continue;
    const slim = { ref: provider.ref ?? null, version: provider.version ?? null };
    const id = JSON.stringify(slim);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ provider: slim });
  }
  return out;
}

function summaryItem(item) {
  if (!item || typeof item !== 'object') return item;
  return {
    key: item.key, kind: item.kind, name: item.name,
    hosts: item.hosts, sourceScopes: item.sourceScopes,
    digestCoverage: item.digestCoverage,
    presence: summaryPresence(item.presence),
  };
}

function summaryCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') return catalog;
  const out = {};
  for (const key of SUMMARY_CATALOG_KEYS) if (key in catalog) out[key] = catalog[key];
  if (Array.isArray(catalog.items)) out.items = catalog.items.map(summaryItem);
  return out;
}

/**
 * The System page payload: the collector payload with its catalog projected.
 * @param {any} payload the footprint collector's read() result
 */
export function systemSummaryPayload(payload) {
  if (!payload || typeof payload !== 'object' || !('catalog' in payload)) return payload;
  return { ...payload, catalog: summaryCatalog(payload.catalog) };
}
