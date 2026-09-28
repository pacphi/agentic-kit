// The System page's slim read model (#237 M4, decision 8). GET /api/system
// serves the footprint collector's payload
// verbatim, the same shape as `ak system --json`, and that stays the
// complete, documented contract. Its catalog repeats every presence fact in
// item.presence, item.consumerBindings, item.artifacts[].consumers and again
// in top-level artifacts/consumerBindings, so it grows with items × projects
// × hosts (tens of MB on a real machine), while the page draws only counts,
// the host profile, the presence matrix and project pressure. `storage`,
// `install`, `projects` and `consumers` carry the same shape of excess — a
// deep tree, a per-tool native-addon list, per-project stack detection, a
// full consumer-descriptor row — of which the page draws a handful of fields.
// GET /api/system/summary applies this projection to all five and the page
// (including the Runtime view's 30 s poll) reads that instead.
//
// Allow-list, not drop-list: a field added to a section later stays off the
// page's wire until the page actually needs it. `runtime`, `knownFiles`,
// `snapshot`, `cheapTier` and `scan` pass through untouched — they are
// already small, or (`scan`) the live progress state the page's own
// scan-running indicator needs verbatim. Pure; never mutates its input.

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

// ── storage ──────────────────────────────────────────────────────────────
// The storage tree (category -> host -> project -> session) carries `kind`,
// `path`, `attribution`, `presence`, `files` and `newestMtimeMs` at every
// node; the page's donut, per-host split and learning-store card read only
// `key`, `label`, `bytes` and the child count/array (system-readout.mjs's
// storageHostTotals/topConsumers, renderSysDonut, renderSysHostSplit,
// renderSysLearning).
const SUMMARY_STORAGE_NODE_KEYS = Object.freeze(['key', 'label', 'bytes']);

function summaryStorageNode(node) {
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const key of SUMMARY_STORAGE_NODE_KEYS) if (key in node) out[key] = node[key];
  if (Array.isArray(node.children)) out.children = node.children.map(summaryStorageNode);
  return out;
}

/** A growth day: renderSysGrowth reads only `day` and `bytes` (never `files`). */
function summaryGrowthDay(day) {
  if (!day || typeof day !== 'object') return day;
  return { day: day.day, bytes: day.bytes };
}

const SUMMARY_GROWTH_HOST_KEYS = Object.freeze(['host', 'totalBytes', 'perDayAvgBytes']);

function summaryGrowthHost(host) {
  if (!host || typeof host !== 'object') return host;
  const out = {};
  for (const key of SUMMARY_GROWTH_HOST_KEYS) if (key in host) out[key] = host[key];
  if (Array.isArray(host.days)) out.days = host.days.map(summaryGrowthDay);
  return out;
}

function summaryGrowth(growth) {
  if (!growth || typeof growth !== 'object') return growth;
  return {
    windowDays: growth.windowDays,
    basis: growth.basis,
    hosts: Array.isArray(growth.hosts) ? growth.hosts.map(summaryGrowthHost) : growth.hosts,
  };
}

/** A topSessions row: renderSysTopSessions/sysSessionIdentity's field list. */
const SUMMARY_SESSION_KEYS = Object.freeze([
  'session', 'host', 'project', 'bytes', 'mtimeMs', 'identity', 'context',
  'projectPath', 'projectResolved', 'projectReason', 'projectLabel',
]);

function summarySession(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const key of SUMMARY_SESSION_KEYS) if (key in row) out[key] = row[key];
  return out;
}

/** A reclaim candidate: renderSysReclaim's reclaimRow reads this set; `id`,
 *  `kind`, `samplePaths`, `matchedCount`, `files` and `keeps` never render. */
const SUMMARY_RECLAIMABLE_KEYS = Object.freeze([
  'label', 'path', 'safety', 'bytesMeaning', 'rationale', 'cleanupHint', 'bytes',
]);

function summaryReclaimable(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const key of SUMMARY_RECLAIMABLE_KEYS) if (key in row) out[key] = row[key];
  return out;
}

const SUMMARY_RECLAIM_TIER_KEYS = Object.freeze(['safety', 'bytes', 'rowCount']);

function summaryReclaimSummary(summary) {
  if (!summary || typeof summary !== 'object') return summary;
  const tiers = Array.isArray(summary.tiers)
    ? summary.tiers.map((tier) => {
      if (!tier || typeof tier !== 'object') return tier;
      const out = {};
      for (const key of SUMMARY_RECLAIM_TIER_KEYS) if (key in tier) out[key] = tier[key];
      return out;
    })
    : summary.tiers;
  return { tiers };
}

/** Every field renderSysStorage's six sub-views (renderSysLearning/Donut/
 *  HostSplit/Growth/Reclaim/TopSessions) and the KPI band's "data retained"
 *  tile read. `topFiles` and the section's own `complete`/`asOf` never render. */
function summaryStorage(storage) {
  if (!storage || typeof storage !== 'object') return storage;
  const out = {};
  if (storage.totals) out.totals = { bytes: storage.totals.bytes };
  if (Array.isArray(storage.categories)) out.categories = storage.categories.map(summaryStorageNode);
  if ('growth' in storage) out.growth = summaryGrowth(storage.growth);
  if (Array.isArray(storage.topSessions)) out.topSessions = storage.topSessions.map(summarySession);
  if (Array.isArray(storage.reclaimables)) out.reclaimables = storage.reclaimables.map(summaryReclaimable);
  if ('reclaimSummary' in storage) out.reclaimSummary = summaryReclaimSummary(storage.reclaimSummary);
  return out;
}

// ── install ──────────────────────────────────────────────────────────────
// Each tool carries `package`, `executablePath`, `linkedFrom`, `components`,
// a `nativeAddons` array, `degraded` and more; renderSysBrowserRuntimes and
// topConsumers read only this set.
const SUMMARY_TOOL_KEYS = Object.freeze([
  'tool', 'label', 'installMethod', 'updateOwner', 'present', 'version', 'root', 'bytes',
]);

function summaryTool(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  const out = {};
  for (const key of SUMMARY_TOOL_KEYS) if (key in tool) out[key] = tool[key];
  return out;
}

const SUMMARY_CACHE_KEYS = Object.freeze(['runtime', 'label', 'path', 'bytes', 'payload']);

function summaryCache(cache) {
  if (!cache || typeof cache !== 'object') return cache;
  const out = {};
  for (const key of SUMMARY_CACHE_KEYS) if (key in cache) out[key] = cache[key];
  return out;
}

const SUMMARY_INSTALL_TOTALS_KEYS = Object.freeze(['installBytes', 'toolsPresent', 'nativeAddons']);

/** `globalRoot`, `npxEnvs` and `duplicateNatives` never render; `disk` is
 *  already three small fields (renderSysGaugeBand), passed through as-is. */
function summaryInstall(install) {
  if (!install || typeof install !== 'object') return install;
  const out = {};
  if (Array.isArray(install.tools)) out.tools = install.tools.map(summaryTool);
  if (Array.isArray(install.sharedCaches)) out.sharedCaches = install.sharedCaches.map(summaryCache);
  if ('disk' in install) out.disk = install.disk;
  if (install.totals) {
    const totals = {};
    for (const key of SUMMARY_INSTALL_TOTALS_KEYS) if (key in install.totals) totals[key] = install.totals[key];
    out.totals = totals;
  }
  return out;
}

// ── projects ─────────────────────────────────────────────────────────────
// A measured project row also carries `stack` (framework/manifest/dependency
// detection — explicitly not rendered, per system-projects.mjs's langCell
// comment), `nodeModulesRoots`, `treeBytes`/`gitBytes`/`nodeModulesBytes`,
// `footprintMtime`, `sessionOrigins`, `source` and `treeExclusions`; the
// Projects table (renderSysProjects) and repository grouping
// (project-groups.mjs's repositoryTree) read only what is listed below.
const SUMMARY_PROJECT_LANG_KEYS = Object.freeze(['id', 'name', 'lines']);

function summaryProjectLang(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const key of SUMMARY_PROJECT_LANG_KEYS) if (key in row) out[key] = row[key];
  return out;
}

/** `byLanguage` duplicates `languages` as an id->lines map; kept anyway
 *  (unlike a dropped field, this one is small — a handful of entries per
 *  project) because `read()` carries a DEEP section forward from whatever was
 *  last persisted (index.mjs's `carryForward`), so a snapshot written before
 *  `languages` existed can still reach this endpoint, and the client's
 *  `locLanguages` falls back to `byLanguage` exactly for that case. */
function summaryProjectLoc(loc) {
  if (!loc || typeof loc !== 'object') return loc;
  return {
    total: loc.total,
    languages: Array.isArray(loc.languages) ? loc.languages.map(summaryProjectLang) : loc.languages,
    byLanguage: loc.byLanguage ?? null,
  };
}

const SUMMARY_REPOSITORY_KEYS = Object.freeze(['repositoryId', 'kind', 'root']);

function summaryRepository(repo) {
  if (!repo || typeof repo !== 'object') return repo;
  const out = {};
  for (const key of SUMMARY_REPOSITORY_KEYS) if (key in repo) out[key] = repo[key];
  return out;
}

const SUMMARY_REMOTE_KEYS = Object.freeze(['status', 'webUrl', 'raw']);

function summaryRemote(remote) {
  if (!remote || typeof remote !== 'object') return remote;
  const out = {};
  for (const key of SUMMARY_REMOTE_KEYS) if (key in remote) out[key] = remote[key];
  return out;
}

const SUMMARY_PROJECT_ROW_KEYS = Object.freeze(['path', 'label', 'hosts', 'totalBytes', 'lastActivity']);

function summaryProjectRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const key of SUMMARY_PROJECT_ROW_KEYS) if (key in row) out[key] = row[key];
  if ('loc' in row) out.loc = summaryProjectLoc(row.loc);
  if ('remote' in row) out.remote = summaryRemote(row.remote);
  if ('repository' in row) out.repository = summaryRepository(row.repository);
  return out;
}

/** A discovery-only row (project-sources.mjs): `origins`, `exists`,
 *  `isGitRepo`, `lastSeenMs`, `sessions` and `sessionOrigins` never render —
 *  repositoryTree reads only path/label/hosts/repository off it. */
const SUMMARY_DISCOVERY_PROJECT_KEYS = Object.freeze(['path', 'label', 'hosts']);

function summaryDiscoveryProject(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const key of SUMMARY_DISCOVERY_PROJECT_KEYS) if (key in row) out[key] = row[key];
  if ('repository' in row) out.repository = summaryRepository(row.repository);
  return out;
}

const SUMMARY_PROJECTS_KEYS = Object.freeze([
  'everSeen', 'onDisk', 'count', 'gitRepos', 'unresolved', 'importedExcluded', 'method', 'truncated',
]);

/** `sources`, `locMeasured`, `registryVersion`, `unrecognized`, `population`,
 *  `scanned` and the section's own `complete` never render (projectsLiner and
 *  the KPI band read only the counts/flags listed above). */
function summaryProjects(projects) {
  if (!projects || typeof projects !== 'object') return projects;
  const out = {};
  for (const key of SUMMARY_PROJECTS_KEYS) if (key in projects) out[key] = projects[key];
  if (Array.isArray(projects.projects)) out.projects = projects.projects.map(summaryProjectRow);
  if (Array.isArray(projects.discoveryProjects)) {
    out.discoveryProjects = projects.discoveryProjects.map(summaryDiscoveryProject);
  }
  return out;
}

// ── consumers ────────────────────────────────────────────────────────────
// A row (measured or residual) also carries `matchedPaths`, `matchedCount`,
// `kind`, `presence`, `files`, `basis`, `newestMtimeMs`, `source`,
// `measuredBy`, `residual` and `complete`; consRows/consGroupRows read only
// this set from `top`/`rows` (both share the same row shape).
const SUMMARY_CONSUMER_ROW_KEYS = Object.freeze([
  'id', 'label', 'path', 'pathPattern', 'group', 'containedBy', 'bytes', 'apparentBytes', 'accountingNote',
]);

function summaryConsumerRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const key of SUMMARY_CONSUMER_ROW_KEYS) if (key in row) out[key] = row[key];
  return out;
}

const SUMMARY_CONSUMER_GROUP_KEYS = Object.freeze(['id', 'label', 'note', 'bytes', 'rowCount']);

function summaryConsumerGroup(group) {
  if (!group || typeof group !== 'object') return group;
  const out = {};
  for (const key of SUMMARY_CONSUMER_GROUP_KEYS) if (key in group) out[key] = group[key];
  return out;
}

const SUMMARY_CONSUMER_ACCOUNTING_KEYS = Object.freeze(['basis', 'containment', 'residuals', 'absent']);

function summaryConsumerAccounting(accounting) {
  if (!accounting || typeof accounting !== 'object') return accounting;
  const out = {};
  for (const key of SUMMARY_CONSUMER_ACCOUNTING_KEYS) if (key in accounting) out[key] = accounting[key];
  return out;
}

/** `unmeasured` items are already minimal (id/label/path/group/kind/reason);
 *  `absent` and per-row `matchedPaths` never render. */
function summaryConsumers(consumers) {
  if (!consumers || typeof consumers !== 'object') return consumers;
  const out = {
    includeProjectTrees: consumers.includeProjectTrees,
    topN: consumers.topN,
  };
  if (Array.isArray(consumers.rows)) out.rows = consumers.rows.map(summaryConsumerRow);
  if (Array.isArray(consumers.top)) out.top = consumers.top.map(summaryConsumerRow);
  if (Array.isArray(consumers.groups)) out.groups = consumers.groups.map(summaryConsumerGroup);
  if (Array.isArray(consumers.unmeasured)) out.unmeasured = consumers.unmeasured;
  if (consumers.totals) out.totals = { rankedCount: consumers.totals.rankedCount };
  if (consumers.accounting) out.accounting = summaryConsumerAccounting(consumers.accounting);
  if (consumers.projectTrees) {
    out.projectTrees = { included: consumers.projectTrees.included, reason: consumers.projectTrees.reason };
  }
  return out;
}

/**
 * The System page payload: the collector payload with catalog, storage,
 * install, projects and consumers each projected to what the page reads.
 * @param {any} payload the footprint collector's read() result
 */
export function systemSummaryPayload(payload) {
  if (!payload || typeof payload !== 'object' || !('catalog' in payload)) return payload;
  const out = { ...payload, catalog: summaryCatalog(payload.catalog) };
  if ('storage' in payload) out.storage = summaryStorage(payload.storage);
  if ('install' in payload) out.install = summaryInstall(payload.install);
  if ('projects' in payload) out.projects = summaryProjects(payload.projects);
  if ('consumers' in payload) out.consumers = summaryConsumers(payload.consumers);
  return out;
}
