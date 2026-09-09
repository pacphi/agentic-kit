// ADR-0048 — `ak maintain` v2: inventory-led evidence, guidance, discovery,
// activity, interruption audit/reconciliation, and guarded one-action plans,
// layered over the existing read-only-scan / immutable-plan / apply / undo
// engine (v1). `deps.service` is the v1 `createMaintenanceService()` and
// keeps `scan|plan|apply|undo` working exactly as before; `deps.management`
// is the ADR-0048 facade (`createManagementService()` from
// `../lib/maintenance/management/service.mjs`), imported lazily so a plain
// `ak maintain scan` never pays for modules it does not need.
import { heading, info, warn, dim, ok } from '../lib/output.mjs';
import { createMaintenanceService } from '../lib/maintenance/service.mjs';
import {
  SCOPE_LENSES, CURATED_VIEWS, SORT_ORDERS, FACETS, GUIDANCE_LANES, GUIDANCE_LANE_LABELS,
  SHELLS, DISPOSITION_KINDS, RECONCILE_OUTCOMES, RECONCILE_OUTCOME_LABELS,
  AUDIT_RESULT_LABELS, NO_CORRECTIVE_ACTION, SOURCE_SCAN_INCOMPLETE, RESOURCE_KIND_LABELS,
  SCOPE_LABELS, SOURCE_TYPES, SOURCE_COVERAGE_LABELS,
} from '../lib/maintenance/management/model.mjs';

const ADDABLE_SOURCE_KINDS = SOURCE_TYPES.filter((kind) => kind !== 'automatic');
const AK_MAINTAIN_JSON_SCHEMA = 'ak-maintain/v2';

export const options = {
  json: { type: 'boolean', default: false },
  deep: { type: 'boolean', default: false },
  'refresh-inventory': { type: 'boolean', default: false },
  project: { type: 'string' },
  findings: { type: 'string' },
  'safety-class': { type: 'string' },
  executable: { type: 'boolean', default: false },
  plan: { type: 'string' },
  digest: { type: 'string' },
  actions: { type: 'string' },
  receipt: { type: 'string' },
  receipts: { type: 'string' },
  yes: { type: 'boolean', default: false },
  scope: { type: 'string' },
  view: { type: 'string' },
  facet: { type: 'string', multiple: true, default: [] },
  search: { type: 'string' },
  sort: { type: 'string' },
  cursor: { type: 'string' },
  limit: { type: 'string' },
  placement: { type: 'string' },
  reveal: { type: 'boolean', default: false },
  lane: { type: 'string' },
  guidance: { type: 'string' },
  shell: { type: 'string' },
  kind: { type: 'string' },
  root: { type: 'string' },
  source: { type: 'string' },
  path: { type: 'string' },
  recursive: { type: 'boolean', default: false },
  exclusion: { type: 'string' },
  outcome: { type: 'string' },
  until: { type: 'string' },
  export: { type: 'boolean', default: false },
  'include-local-paths': { type: 'boolean', default: false },
  'acknowledge-warning': { type: 'boolean', default: false },
  recipe: { type: 'string' },
  version: { type: 'string' },
  set: { type: 'string', multiple: true, default: [] },
};

export const help = `ak maintain — inventory-led maintenance: evidence, guidance, guarded actions

System measures; Maintenance explains what is verified about every resource
placement and offers only bounded, exact operations. Every write plan is one
placement and one action — no batching. Apply, undo, reconcile, and
disposition require explicit, exact confirmation with --yes.

Usage:
  ak maintain scan [--deep] [--refresh-inventory] [--json]
  ak maintain inventory [--scope S] [--view V] [--facet name=value ...]
                         [--search TEXT] [--sort ORDER] [--cursor TOKEN] [--limit N] [--json]
  ak maintain show --placement ID [--reveal] [--json]
  ak maintain guidance [--lane LANE] [--json]
  ak maintain procedure --guidance ID [--shell SHELL] [--json]
  ak maintain discovery [--json]
  ak maintain sources add --kind exact-project|collection-root --root PATH [--yes] [--json]
  ak maintain sources remove --source ID [--yes] [--json]
  ak maintain sources enable|disable --source ID [--json]
  ak maintain sources exclude --path PATH [--recursive] [--json]
  ak maintain sources unexclude --exclusion ID [--json]
  ak maintain scans [--json]
  ak maintain scans start [--source ID,...] [--deep] [--json]   (waits for the final state)
  ak maintain scans pause|resume --source ID [--json]
  ak maintain scans stop --source ID [--yes] [--json]
  ak maintain activity [--json]
  ak maintain receipt --receipt ID [--export [--include-local-paths --acknowledge-warning]] [--json]
  ak maintain audit --receipts ID,... [--json]
  ak maintain reconcile --receipt ID --outcome record-no-change|record-completed|record-restored --yes [--json]
  ak maintain disposition --guidance ID --kind acknowledged|snoozed|ignored-exact-candidate [--until ISO] --yes [--json]
  ak maintain plan [--findings ID,...] [--safety-class CLASS] [--project PATH] [--executable] [--json]
  ak maintain plan --placement ID [--guidance ID] --executable [--json]
  ak maintain apply --plan ID --digest SHA256 --actions ID --yes [--json]
  ak maintain undo --receipt ID --yes [--json]
  ak maintain recover --receipt ID [--json]
  ak maintain recipes list|refresh|accept|withdraw [--recipe ID [--version V] --yes] [--json]
  ak maintain preferences [--set key=value ...] [--json]

Options:
  --json                    emit the complete DTO exactly as returned by the facade
  --deep                    explicitly refresh the System deep scan before reading
  --refresh-inventory       rebuild the Inventory from the collector after scanning
  --scope S                 system|machine|user|project|across
  --view V                  a curated Inventory view
  --facet name=value        repeatable facet filter (kind, scope, guidance, ...)
  --search TEXT             free-text search across displayed names
  --sort ORDER              guidance-first|name|recently-changed|kind
  --cursor TOKEN            opaque page token from a previous --json response
  --limit N                 page size (bounded server-side)
  --placement ID            exact opaque placement id
  --reveal                  print the exact, owner-only path for one placement
  --lane LANE               apply|steps|decision|update|recovery
  --guidance ID             exact opaque guidance id
  --shell SHELL             bash|zsh|powershell|cmd|wsl
  --kind KIND               exact-project|collection-root (sources add)
  --root PATH               exact root path (sources add)
  --source ID               exact opaque source id (comma-list for scans start)
  --path PATH               exact exclusion path (sources exclude)
  --recursive               the exclusion applies to the whole subtree
  --exclusion ID            exact opaque exclusion id
  --findings ID,...         exact finding IDs (legacy safety-class plans)
  --safety-class CLASS      select findings from one safety class (legacy)
  --project PATH            select findings for one reported project (legacy)
  --executable              derive one action from fresh evidence and persist the plan
  --plan ID                 exact persisted executable plan ID
  --digest SHA256           exact executable plan digest shown at preview
  --actions ID              exactly one exact action ID shown at preview
  --receipt ID              exact receipt ID (undo, reconcile, recover, receipt)
  --receipts ID,...         exact receipt IDs (audit; read-only, may batch)
  --outcome OUTCOME         record-no-change|record-completed|record-restored
  --until ISO               disposition expiry (snoozed)
  --export                  sanitize and export one receipt
  --include-local-paths     export: include local paths (requires --acknowledge-warning)
  --acknowledge-warning     export: explicit acknowledgement for --include-local-paths
  --recipe ID               exact opaque recipe id
  --version V               exact recipe version
  --set key=value           repeatable preference assignment
  --yes                     explicit confirmation for a write

Examples:
  ak maintain inventory --search lightpanda --json
  ak maintain show --placement plc_lightpanda --json
  ak maintain guidance --lane steps
  ak maintain procedure --guidance gid_lightpanda_steps --shell zsh
  ak maintain audit --receipts mnt-receipt-a,mnt-receipt-b
  ak maintain reconcile --receipt mnt-receipt-a --outcome record-completed --yes
  ak maintain sources add --kind collection-root --root /path/to/projects
  ak maintain sources add --kind collection-root --root /path/to/projects --yes
  ak maintain plan --findings maintenance-finding-abc --executable --json
  ak maintain apply --plan maintenance-plan-abc --digest SHA256 --actions maintenance-action-abc --yes
  ak maintain undo --receipt mnt-receipt --yes
  ak maintain recover --receipt mnt-receipt

Compatibility:
  recover is a read-only alias for audit; it no longer records an outcome.
  Recording now requires: ak maintain reconcile --receipt ID --outcome OUTCOME --yes.
  --actions accepts exactly one exact action ID, and --findings with --executable
  accepts exactly one exact finding ID. Two or more IDs are refused before any
  write, on the CLI side, before the request ever reaches the service.
  recipes accept always requires --version; recipes withdraw's --version is
  optional and defaults to the active, else the most recently staged, version.
  scans start/pause/resume drive a discovery scan in the background and wait
  for it to reach a final state before printing progress. Automatic sources
  that are not a filesystem walk (runtimes, package managers, Ollama,
  providers) are measured by "ak maintain scan --deep", not by scans start —
  naming one with --source is refused.`;

// ── Small parsing helpers ───────────────────────────────────────────────────

function usageError(message) {
  return { usageError: message };
}

function csvIds(raw) {
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  return typeof value === 'string' && value.length
    ? [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))].sort()
    : [];
}

const idsOrNull = (raw) => (raw ? csvIds(raw) : null);

function compact(source) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
}

function parseFacets(rawList) {
  const facets = {};
  for (const raw of rawList ?? []) {
    const eq = raw.indexOf('=');
    if (eq <= 0) return { error: `--facet must be name=value, got: ${raw}` };
    const name = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!FACETS.includes(name)) return { error: `--facet name is not a recognized facet: ${name}` };
    if (!value) return { error: `--facet ${name} requires a value` };
    (facets[name] ??= []).push(value);
  }
  return { facets };
}

function parseKeyValues(list) {
  const values = {};
  for (const raw of list) {
    const eq = raw.indexOf('=');
    if (eq <= 0) return { error: `--set must be key=value, got: ${raw}` };
    values[raw.slice(0, eq).trim()] = raw.slice(eq + 1);
  }
  return { values };
}

const validIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function hasOwnSchema(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && ('schema' in value || 'schemaVersion' in value);
}

function jsonPayload(outcome) {
  if (outcome.rawJson === true || hasOwnSchema(outcome.result)) return outcome.result;
  return { schema: AK_MAINTAIN_JSON_SCHEMA, verb: outcome.verb, result: outcome.result };
}

// ── Lazy facade resolution ──────────────────────────────────────────────────

async function resolveManagement(deps) {
  if (deps.management) return deps.management;
  const { createManagementService } = await import('../lib/maintenance/management/service.mjs');
  return createManagementService();
}

// ── Legacy v1 verbs: scan / plan / apply / undo (byte-for-byte JSON contract) ─

function renderScan(model) {
  heading('Maintenance — read-only findings');
  info(`Evidence: ${model.freshness.status} · ${model.freshness.completeness}`);
  info(`${model.summary.updatesReady} updates ready · ${model.summary.safeCleanup} safe cleanup · `
    + `${model.summary.needsReview} needs review · ${model.summary.unsupportedOrBlocked} blocked`);
  for (const finding of model.findings) {
    info(`${finding.resource.name}: ${finding.state} · ${finding.nextAction.label}`);
  }
  if (!model.findings.length) info(dim('No maintenance findings in the measured evidence.'));
}

function renderRefreshedInventory(value) {
  if (!value) return;
  const parts = [value.inventoryId, value.capturedAt].filter(Boolean);
  info(`Inventory refreshed${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
}

async function dispatchScan({ flags, deps }) {
  const service = deps.service ?? createMaintenanceService();
  const scanResult = await service.scan({ deep: flags.deep === true });
  if (flags['refresh-inventory'] !== true) {
    return { verb: 'scan', result: scanResult, rawJson: true, render: renderScan };
  }
  const management = await resolveManagement(deps);
  // `--deep` is a machine measurement: walk every discovery source to a
  // terminal state, then rebuild, exactly as the dashboard's Re-measure does.
  const inventoryResult = flags.deep === true && typeof management.rebuildAfterMeasurement === 'function'
    ? (await management.rebuildAfterMeasurement()).inventory
    : await management.refreshInventory({ deep: flags.deep === true });
  return {
    verb: 'scan',
    result: { scan: scanResult, inventory: inventoryResult },
    render: (value) => { renderScan(value.scan); renderRefreshedInventory(value.inventory); },
  };
}

function renderPlan(plan) {
  heading(`Maintenance plan — ${plan.mode}`);
  info(`${plan.planId} · ${plan.safetyClass} · ${plan.actions.length} action(s)`);
  info(`Expires ${plan.expiresAt}`);
  info(dim('Nothing was changed. Apply requires this exact plan ID, digest, action selection, and --yes.'));
}

function planOneActionMessage() {
  return 'A maintenance plan carries exactly one action per placement. Select exactly one id with '
    + '--findings for --executable, or omit --executable to list several findings read-only.';
}

async function dispatchPlan({ flags, deps }) {
  if (flags.placement) {
    if (flags.executable !== true) return usageError('Maintenance plan --placement requires --executable.');
    const management = await resolveManagement(deps);
    const result = await management.planAction(compact({ placementId: flags.placement, guidanceId: flags.guidance }));
    return { verb: 'plan', result, rawJson: true, render: renderPlan };
  }
  const findingIds = idsOrNull(flags.findings);
  if (flags.executable === true && findingIds && findingIds.length > 1) {
    return usageError(planOneActionMessage());
  }
  const service = deps.service ?? createMaintenanceService();
  const result = await service.plan({
    deep: flags.deep === true,
    findingIds,
    project: flags.project ?? null,
    ...(flags['safety-class'] ? { safetyClass: flags['safety-class'] } : {}),
    ...(flags.executable === true ? { executable: true, persist: true } : {}),
  });
  return { verb: 'plan', result, rawJson: true, render: renderPlan };
}

function renderMutation(result, verb) {
  heading(`Maintenance ${verb}`);
  if (result && typeof result === 'object') {
    if ('status' in result) info(`${result.status}${result.receiptId ? ` · ${result.receiptId}` : ''}`);
    else if ('ok' in result) (result.ok ? ok : warn)(result.ok ? 'Completed.' : 'Not completed.');
    else info(dim('Request completed.'));
    if (result.error) warn(result.error);
  } else {
    info(dim('Request completed.'));
  }
}

async function dispatchApply({ flags, deps }) {
  const missingRequired = ['plan', 'digest', 'actions'].some((name) => !flags[name]);
  if (missingRequired || flags.yes !== true) {
    return usageError('Maintenance apply requires --plan, --digest, --actions, and --yes.');
  }
  const actionIds = csvIds(flags.actions);
  if (actionIds.length !== 1) {
    return usageError('A maintenance apply request carries exactly one exact action id. '
      + 'Provide exactly one id with --actions.');
  }
  const service = deps.service ?? createMaintenanceService();
  const result = await service.apply({
    planId: flags.plan, expectedPlanDigest: flags.digest, actionIds, confirmed: true,
  });
  return { verb: 'apply', result, rawJson: true, render: (value) => renderMutation(value, 'apply') };
}

async function dispatchUndo({ flags, deps }) {
  if (!flags.receipt || flags.yes !== true) return usageError('Maintenance undo requires --receipt and --yes.');
  const service = deps.service ?? createMaintenanceService();
  const result = await service.undo({ receiptId: flags.receipt, confirmed: true });
  return { verb: 'undo', result, rawJson: true, render: (value) => renderMutation(value, 'undo') };
}

// ── Interruption audit and the `recover` compatibility alias ────────────────

function renderAuditResults(results) {
  heading('Maintenance audit — interruption');
  for (const entry of results) {
    info(`${entry.receiptId}: ${AUDIT_RESULT_LABELS[entry.result] ?? entry.result}`);
    const enabled = entry.enables ? RECONCILE_OUTCOME_LABELS[entry.enables] : null;
    info(enabled ? `Enables: ${enabled}` : NO_CORRECTIVE_ACTION);
  }
  if (!results.length) info(dim('No receipts were audited.'));
}

async function dispatchAudit({ flags, deps }) {
  const receiptIds = csvIds(flags.receipts);
  if (!receiptIds.length) return usageError('Maintenance audit requires --receipts.');
  const management = await resolveManagement(deps);
  const result = await management.auditInterruption({ receiptIds });
  return { verb: 'audit', result, render: renderAuditResults };
}

const RECOVER_COMPAT_NOTE = 'recover is a read-only compatibility alias for audit. Recording an '
  + 'outcome now requires: ak maintain reconcile --receipt ID --outcome OUTCOME --yes.';

async function dispatchRecover({ flags, deps }) {
  const receiptIds = flags.receipts ? csvIds(flags.receipts) : (flags.receipt ? [flags.receipt] : []);
  if (!receiptIds.length) return usageError('Maintenance recover requires --receipt.');
  const management = await resolveManagement(deps);
  const results = await management.auditInterruption({ receiptIds });
  const single = receiptIds.length === 1;
  return {
    verb: 'recover',
    result: single ? results[0] : results,
    render: (value) => {
      renderAuditResults(single ? [value] : value);
      info(dim(RECOVER_COMPAT_NOTE));
    },
  };
}

async function dispatchReconcile({ flags, deps }) {
  if (!flags.receipt || !flags.outcome) return usageError('Maintenance reconcile requires --receipt and --outcome.');
  if (!RECONCILE_OUTCOMES.includes(flags.outcome)) {
    return usageError(`--outcome must be one of: ${RECONCILE_OUTCOMES.join(', ')}.`);
  }
  if (flags.yes !== true) return usageError('Maintenance reconcile requires --yes.');
  const management = await resolveManagement(deps);
  const result = await management.reconcile({ receiptId: flags.receipt, outcome: flags.outcome, confirmed: true });
  return { verb: 'reconcile', result, render: (value) => renderMutation(value, 'reconcile') };
}

// ── Inventory, inspector, guidance, procedure ───────────────────────────────

function renderInventoryPage(page) {
  heading('Maintenance inventory');
  info(`${page.total} placement(s) across ${page.groups.length} resource group(s).`);
  for (const group of page.groups) {
    info(`${group.displayName} (${RESOURCE_KIND_LABELS[group.kind] ?? group.kind}) · ${group.placementCount} placement(s)`);
    for (const row of group.placements) {
      const lane = row.guidanceLane ? ` · ${row.guidanceLane.label}` : '';
      info(`  ${row.placementId} · ${row.scope.label} · ${row.breadcrumb.join(' › ')}${lane}`);
    }
  }
  if (page.sortGroups?.length) info(page.sortGroups.map((entry) => `${entry.label}: ${entry.count}`).join(' · '));
  if (page.partialSources?.length) warn(SOURCE_SCAN_INCOMPLETE);
  if (page.nextCursor) info(dim(`More results: --cursor ${page.nextCursor}`));
  if (!page.groups.length) info(dim('No placements match this inventory query.'));
}

async function dispatchInventory({ flags, deps }) {
  const parsedFacets = parseFacets(flags.facet);
  if (parsedFacets.error) return usageError(parsedFacets.error);
  if (flags.scope != null && !SCOPE_LENSES.includes(flags.scope)) {
    return usageError(`--scope must be one of: ${SCOPE_LENSES.join(', ')}.`);
  }
  if (flags.view != null && !CURATED_VIEWS.includes(flags.view)) {
    return usageError(`--view must be one of: ${CURATED_VIEWS.join(', ')}.`);
  }
  if (flags.sort != null && !SORT_ORDERS.includes(flags.sort)) {
    return usageError(`--sort must be one of: ${SORT_ORDERS.join(', ')}.`);
  }
  const management = await resolveManagement(deps);
  const result = await management.inventory(compact({
    scope: flags.scope,
    view: flags.view,
    facets: Object.keys(parsedFacets.facets).length ? parsedFacets.facets : undefined,
    search: flags.search,
    sort: flags.sort,
    cursor: flags.cursor,
    limit: flags.limit != null ? Number.parseInt(flags.limit, 10) : undefined,
  }));
  return { verb: 'inventory', result, render: renderInventoryPage };
}

function renderWhatCanIAccomplish(value) {
  if (Array.isArray(value)) {
    for (const entry of value) info(`${GUIDANCE_LANE_LABELS[entry.lane]}: ${entry.outcome}`);
    if (!value.length) info(dim('No admitted guidance for this placement.'));
    return;
  }
  info(value.detail);
}

function renderInspector(inspector) {
  if (inspector?.scanRequired === true) {
    heading('Maintenance placement');
    info(dim('No inventory has been captured yet. Run: ak maintain scan --refresh-inventory.'));
    return;
  }
  heading(`Maintenance placement — ${inspector.whatIsThis.displayName}`);
  info(`${inspector.whatIsThis.kindLabel} · ${inspector.whatIsThis.placementId}`);
  if (inspector.whatIsThis.conditionLabels.length) info(inspector.whatIsThis.conditionLabels.join(' · '));
  info(`Scope: ${SCOPE_LABELS[inspector.whereIsIt.scope]} · ${inspector.whereIsIt.breadcrumb.join(' › ')}`);
  if (inspector.whereDidItComeFrom) {
    info(`Source: ${inspector.whereDidItComeFrom.label ?? inspector.whereDidItComeFrom.kind} `
      + `(${inspector.whereDidItComeFrom.authority})`);
  }
  const versions = Object.entries(inspector.whatVersionIsHere ?? {});
  if (versions.length) info(versions.map(([axis, value]) => `${axis}: ${value}`).join(' · '));
  if (inspector.whoUsesIt.consumers.length) {
    info(`Used by: ${inspector.whoUsesIt.consumers.map((consumer) => consumer.consumerLabel).join(', ')}`);
  }
  for (const conflict of inspector.whatChangedOrConflicts) info(`${conflict.label}: ${conflict.proves}`);
  renderWhatCanIAccomplish(inspector.whatCanIAccomplish);
  if (inspector.whatHappenedBefore.receipts.length) {
    info(`Receipts: ${inspector.whatHappenedBefore.receipts.map((entry) => entry.id).join(', ')}`);
  }
}

function renderRevealedLocator(result) {
  heading('Maintenance placement — exact location');
  info(result.path);
  if (result.selector) info(`Selector: ${result.selector}`);
  if (result.file) info(`File: ${result.file}`);
}

async function dispatchShow({ flags, deps }) {
  if (!flags.placement) return usageError('Maintenance show requires --placement.');
  const management = await resolveManagement(deps);
  if (flags.reveal === true) {
    const result = await management.revealLocator({ placementId: flags.placement });
    return { verb: 'show', result, render: renderRevealedLocator };
  }
  const result = await management.placement({ placementId: flags.placement });
  return { verb: 'show', result, render: renderInspector };
}

function renderGuidance(result) {
  heading('Maintenance guidance');
  info(GUIDANCE_LANES.map((lane) => `${GUIDANCE_LANE_LABELS[lane]}: ${result.counts?.[lane] ?? 0}`).join(' · '));
  const entries = Array.isArray(result.entries)
    ? result.entries
    : GUIDANCE_LANES.flatMap((lane) => result.lanes?.[lane] ?? []);
  for (const entry of entries) {
    info(`${GUIDANCE_LANE_LABELS[entry.lane]} · ${entry.placementId}: ${entry.outcome}`);
    if (entry.impact?.summary) info(dim(entry.impact.summary));
    if (entry.warning) warn(entry.warning.impact);
  }
  if (!entries.length) info(dim('No admitted guidance in the current inventory.'));
}

async function dispatchGuidance({ flags, deps }) {
  if (flags.lane != null && !GUIDANCE_LANES.includes(flags.lane)) {
    return usageError(`--lane must be one of: ${GUIDANCE_LANES.join(', ')}.`);
  }
  const management = await resolveManagement(deps);
  const result = await management.guidance(compact({ lane: flags.lane }));
  return { verb: 'guidance', result, render: renderGuidance };
}

function renderProcedureResult(result) {
  heading('Maintenance procedure');
  info(result.outcome);
  info(`Source: ${result.source.authority} · ${result.source.publisher} · v${result.source.recipeVersion}`);
  info(`Privilege: ${result.privilege} · Network: ${result.network}`);
  info(`Command (${result.command.shellLabel}): ${result.command.text}`);
  info(`Verification (${result.verification.shellLabel}): ${result.verification.text}`);
  if (result.preserved.length) info(`Preserved: ${result.preserved.join(', ')}`);
  for (const step of result.checklist) info(`- ${step.label}`);
}

async function dispatchProcedure({ flags, deps }) {
  if (!flags.guidance) return usageError('Maintenance procedure requires --guidance.');
  if (flags.shell != null && !SHELLS.includes(flags.shell)) return usageError(`--shell must be one of: ${SHELLS.join(', ')}.`);
  const management = await resolveManagement(deps);
  const result = await management.procedure(compact({ guidanceId: flags.guidance, shell: flags.shell }));
  return { verb: 'procedure', result, render: renderProcedureResult };
}

async function dispatchDisposition({ flags, deps }) {
  if (!flags.guidance || !flags.kind) return usageError('Maintenance disposition requires --guidance and --kind.');
  if (!DISPOSITION_KINDS.includes(flags.kind)) return usageError(`--kind must be one of: ${DISPOSITION_KINDS.join(', ')}.`);
  if (flags.until != null && !validIso(flags.until)) return usageError('--until must be an ISO timestamp.');
  if (flags.yes !== true) return usageError('Maintenance disposition requires --yes.');
  const management = await resolveManagement(deps);
  const result = await management.recordDisposition(compact({
    guidanceId: flags.guidance, kind: flags.kind, until: flags.until, confirmed: true,
  }));
  return { verb: 'disposition', result, render: (value) => renderMutation(value, 'disposition') };
}

// ── Discovery, sources, scans ────────────────────────────────────────────────
// `discovery` is the one verb besides `show --reveal` allowed to print a path:
// the configured roots are exactly what the user typed at `sources add`.

// Renders one SourceCoverage row through SOURCE_COVERAGE_LABELS — never the
// raw enum token — and, for a source that has never been scanned, a hint to
// start it (the opaque sourceId is safe to print; it is not a path).
function renderCoverageEntry(entry) {
  info(`${entry.label}: ${SOURCE_COVERAGE_LABELS[entry.state] ?? entry.state}`);
  if (entry.state === 'not-scanned') info(dim(`Run: ak maintain scans start --source ${entry.sourceId}`));
}

function renderDiscovery(result) {
  heading('Maintenance discovery');
  for (const source of result.automaticSources ?? []) info(`${source.id}: ${source.enabled ? 'enabled' : 'disabled'}`);
  for (const project of result.exactProjects ?? []) info(`Exact project: ${project.root}`);
  for (const root of result.collectionRoots ?? []) info(`Collection root: ${root.root}`);
  for (const exclusion of result.exclusions ?? []) info(`Excluded: ${exclusion.path}${exclusion.recursive ? ' (recursive)' : ''}`);
  if (result.progress) info(result.progress);
  for (const entry of result.coverage ?? []) renderCoverageEntry(entry);
  if (result.history?.length) info(dim(`${result.history.length} prior scan(s) recorded.`));
}

async function dispatchDiscovery({ deps }) {
  const management = await resolveManagement(deps);
  const result = await management.discovery();
  return { verb: 'discovery', result, render: renderDiscovery };
}

function renderSourcePreview(preview) {
  heading('Maintenance sources — preview');
  info(dim('Nothing was changed. Re-run with --yes to save.'));
  if (preview.root) info(`Root: ${preview.root}`);
  if (Array.isArray(preview.projectsFound)) info(`${preview.projectsFound.length} project(s) found.`);
  if (preview.previewId) info(dim(`Preview: ${preview.previewId}`));
}

function renderAffectedPreview(result) {
  heading('Maintenance — affected preview');
  info(dim('Nothing was changed. Re-run with --yes to proceed.'));
  const preview = result?.preview ?? result;
  if (preview?.label) info(`${preview.label}: ${preview.visited ?? 0} entries visited so far.`);
  const count = preview?.affectedPlacements?.length ?? preview?.affected?.length ?? preview?.count;
  if (count != null) info(`${count} placement(s) would be affected.`);
  if (!preview?.label && count == null) info(dim('Full preview detail is available with --json.'));
}

async function sourcesAdd(flags, management) {
  if (!flags.kind || !flags.root) return usageError('Maintenance sources add requires --kind and --root.');
  if (!ADDABLE_SOURCE_KINDS.includes(flags.kind)) {
    return usageError(`--kind must be one of: ${ADDABLE_SOURCE_KINDS.join(', ')}.`);
  }
  const preview = await management.previewSource({ kind: flags.kind, root: flags.root });
  if (flags.yes !== true) return { verb: 'sources', result: preview, render: renderSourcePreview };
  const saved = await management.saveSource({ previewId: preview.previewId, confirmed: true });
  return { verb: 'sources', result: saved, render: (value) => renderMutation(value, 'sources add') };
}

async function sourcesRemove(flags, management) {
  if (!flags.source) return usageError('Maintenance sources remove requires --source.');
  const confirmed = flags.yes === true;
  const result = await management.removeSource({ sourceId: flags.source, confirmed });
  return {
    verb: 'sources', result,
    render: confirmed ? (value) => renderMutation(value, 'sources remove') : renderAffectedPreview,
  };
}

async function sourcesToggle(flags, management, enabled) {
  const verb = enabled ? 'enable' : 'disable';
  if (!flags.source) return usageError(`Maintenance sources ${verb} requires --source.`);
  const result = await management.setAutomaticSource({ sourceId: flags.source, enabled });
  return { verb: 'sources', result, render: (value) => renderMutation(value, `sources ${verb}`) };
}

async function sourcesExclude(flags, management) {
  if (!flags.path) return usageError('Maintenance sources exclude requires --path.');
  const result = await management.addExclusion({ path: flags.path, recursive: flags.recursive === true });
  return { verb: 'sources', result, render: (value) => renderMutation(value, 'sources exclude') };
}

async function sourcesUnexclude(flags, management) {
  if (!flags.exclusion) return usageError('Maintenance sources unexclude requires --exclusion.');
  const result = await management.removeExclusion({ exclusionId: flags.exclusion });
  return { verb: 'sources', result, render: (value) => renderMutation(value, 'sources unexclude') };
}

const SOURCES_SUBVERBS = Object.freeze({
  add: (flags, management) => sourcesAdd(flags, management),
  remove: (flags, management) => sourcesRemove(flags, management),
  enable: (flags, management) => sourcesToggle(flags, management, true),
  disable: (flags, management) => sourcesToggle(flags, management, false),
  exclude: (flags, management) => sourcesExclude(flags, management),
  unexclude: (flags, management) => sourcesUnexclude(flags, management),
});

async function dispatchSources({ flags, sub, deps }) {
  const handler = sub ? SOURCES_SUBVERBS[sub] : null;
  if (!handler) return usageError('usage: ak maintain sources add|remove|enable|disable|exclude|unexclude [options]');
  const management = await resolveManagement(deps);
  return handler(flags, management);
}

function renderScanProgress(result) {
  heading('Maintenance scans — progress');
  if (result?.narrative) info(result.narrative);
  for (const entry of result?.coverage ?? []) renderCoverageEntry(entry);
  if (!result?.narrative && !(result?.coverage ?? []).length) info(dim('No scan is configured or in progress.'));
}

async function scansStart(flags, management) {
  const sourceIds = flags.source ? csvIds(flags.source) : undefined;
  const result = await management.startScan(compact({
    sourceIds, deep: flags.deep === true ? true : undefined,
  }));
  // The facade drives each started source to a terminal state in the
  // background; the CLI waits for exactly the sources it just requested (or
  // every in-flight scan, when --source was omitted) so it can report a
  // final state instead of the snapshot right after the first work slice.
  const settled = typeof management.awaitScans === 'function'
    ? await management.awaitScans(compact({ sourceIds }))
    : result;
  return { verb: 'scans', result: settled ?? result, render: renderScanProgress };
}

// `{sourceId}` and `{sourceIds}` are interchangeable everywhere on the real
// facade (service-discovery.mjs's normalizeSourceIds); pauseScan/resumeScan
// both now return the same `scanProgress()` envelope, so one helper covers
// both with a single rendering path.
async function scansPauseOrResume(flags, management, method, label) {
  if (!flags.source) return usageError(`Maintenance scans ${label} requires --source.`);
  const result = await management[method]({ sourceId: flags.source });
  return { verb: 'scans', result, render: renderScanProgress };
}

async function scansStop(flags, management) {
  if (!flags.source) return usageError('Maintenance scans stop requires --source.');
  const confirmed = flags.yes === true;
  const result = await management.stopScan({ sourceId: flags.source, confirmed });
  return {
    verb: 'scans', result,
    render: confirmed ? (value) => renderMutation(value, 'scans stop') : renderAffectedPreview,
  };
}

async function dispatchScans({ flags, sub, deps }) {
  const management = await resolveManagement(deps);
  if (!sub) {
    const result = await management.scanProgress();
    return { verb: 'scans', result, render: renderScanProgress };
  }
  if (sub === 'start') return scansStart(flags, management);
  if (sub === 'pause') return scansPauseOrResume(flags, management, 'pauseScan', 'pause');
  if (sub === 'resume') return scansPauseOrResume(flags, management, 'resumeScan', 'resume');
  if (sub === 'stop') return scansStop(flags, management);
  return usageError('usage: ak maintain scans [start|pause|resume|stop] [options]');
}

// ── Activity and receipts ───────────────────────────────────────────────────

function renderActivity(result) {
  heading('Maintenance activity');
  if (result.recovery?.length) {
    info(`Recovery to finish (${result.recovery.length}):`);
    for (const entry of result.recovery) info(`  ${entry.receiptId} · ${entry.statusLabel} · ${entry.primaryActionLabel}`);
  }
  if (result.inProgress?.length) info(`In progress: ${result.inProgress.length}`);
  info(`Receipts: ${result.receipts?.length ?? 0} · Dispositions: ${result.dispositions?.length ?? 0} · `
    + `Recipe events: ${result.recipes?.length ?? 0} · Scan history: ${result.scans?.length ?? 0}`);
}

async function dispatchActivity({ deps }) {
  const management = await resolveManagement(deps);
  const result = await management.activity();
  return { verb: 'activity', result, render: renderActivity };
}

function renderReceiptDetail(detail) {
  heading(`Maintenance receipt — ${detail.receiptId}`);
  if (detail.result) info(detail.result);
  if (detail.provider) info(`Provider: ${detail.provider.id} v${detail.provider.version}`);
  if (detail.operation) info(`Operation: ${detail.operation}`);
  if (detail.restart) info(`Restart: ${detail.restart}`);
  if (detail.rollback) info(`Rollback class: ${detail.rollback}`);
  if (detail.preserved?.length) info(`Preserved: ${detail.preserved.join(', ')}`);
}

async function dispatchReceipt({ flags, deps }) {
  if (!flags.receipt) return usageError('Maintenance receipt requires --receipt.');
  const management = await resolveManagement(deps);
  if (flags.export === true) {
    const includeLocalPaths = flags['include-local-paths'] === true;
    // The facade's own acknowledgment is reaching it with includeLocalPaths:
    // true at all (service-activity.mjs), so this CLI-level gate is the
    // explicit, separate confirmation MNT-PRV-003 asks for before that
    // happens — --acknowledge-warning is never forwarded to the facade.
    if (includeLocalPaths && flags['acknowledge-warning'] !== true) {
      return usageError('Maintenance receipt --export --include-local-paths requires --acknowledge-warning.');
    }
    const result = await management.exportReceipt({ receiptId: flags.receipt, includeLocalPaths });
    return { verb: 'receipt', result, render: renderReceiptDetail };
  }
  const result = await management.receipt({ receiptId: flags.receipt });
  return { verb: 'receipt', result, render: renderReceiptDetail };
}

// ── Recipes and preferences ──────────────────────────────────────────────────

function renderRecipes(result) {
  heading('Maintenance recipes');
  const list = Array.isArray(result) ? result : (result?.recipes ?? []);
  for (const recipe of list) info(`${recipe.recipeId ?? recipe.id} v${recipe.recipeVersion ?? recipe.version} · ${recipe.state}`);
  if (!list.length) info(dim('No recipes recorded.'));
}

async function recipesAccept(flags, management) {
  if (!flags.recipe || !flags.version || flags.yes !== true) {
    return usageError('Maintenance recipes accept requires --recipe, --version, and --yes.');
  }
  const result = await management.acceptRecipe({ recipeId: flags.recipe, recipeVersion: flags.version, confirmed: true });
  return { verb: 'recipes', result, render: (value) => renderMutation(value, 'recipes accept') };
}

// `--version` is optional: the facade defaults an omitted recipeVersion to
// the active version, else the most recently staged pending-acceptance
// version, refusing only when neither exists (service-actions.mjs).
async function recipesWithdraw(flags, management) {
  if (!flags.recipe || flags.yes !== true) return usageError('Maintenance recipes withdraw requires --recipe and --yes.');
  const result = await management.withdrawRecipe(compact({
    recipeId: flags.recipe, recipeVersion: flags.version, confirmed: true,
  }));
  return { verb: 'recipes', result, render: (value) => renderMutation(value, 'recipes withdraw') };
}

async function dispatchRecipes({ flags, sub, deps }) {
  const management = await resolveManagement(deps);
  if (!sub || sub === 'list') {
    const result = await management.recipes();
    return { verb: 'recipes', result, render: renderRecipes };
  }
  if (sub === 'refresh') {
    const result = await management.refreshRecipes({ confirmed: flags.yes === true });
    return { verb: 'recipes', result, render: (value) => renderMutation(value, 'recipes refresh') };
  }
  if (sub === 'accept') return recipesAccept(flags, management);
  if (sub === 'withdraw') return recipesWithdraw(flags, management);
  return usageError('usage: ak maintain recipes list|refresh|accept|withdraw [options]');
}

function renderPreferences(result) {
  heading('Maintenance preferences');
  const entries = Object.entries(result ?? {});
  for (const [key, value] of entries) info(`${key}: ${JSON.stringify(value)}`);
  if (!entries.length) info(dim('No preferences recorded.'));
}

async function dispatchPreferences({ flags, deps }) {
  const management = await resolveManagement(deps);
  if (!flags.set?.length) {
    const result = await management.preferences();
    return { verb: 'preferences', result, render: renderPreferences };
  }
  const parsed = parseKeyValues(flags.set);
  if (parsed.error) return usageError(parsed.error);
  const result = await management.savePreferences(parsed.values);
  return { verb: 'preferences', result, render: (value) => renderMutation(value, 'preferences') };
}

// ── Dispatch table and entrypoint ───────────────────────────────────────────

const DISPATCH = Object.freeze({
  scan: dispatchScan,
  inventory: dispatchInventory,
  show: dispatchShow,
  guidance: dispatchGuidance,
  procedure: dispatchProcedure,
  discovery: dispatchDiscovery,
  sources: dispatchSources,
  scans: dispatchScans,
  activity: dispatchActivity,
  receipt: dispatchReceipt,
  audit: dispatchAudit,
  reconcile: dispatchReconcile,
  disposition: dispatchDisposition,
  plan: dispatchPlan,
  apply: dispatchApply,
  undo: dispatchUndo,
  recover: dispatchRecover,
  recipes: dispatchRecipes,
  preferences: dispatchPreferences,
});

function emit(outcome, json) {
  if (outcome.result === undefined) return;
  if (json) { console.log(JSON.stringify(jsonPayload(outcome), null, 2)); return; }
  outcome.render?.(outcome.result);
}

/** CLI adapter over the ADR-0048 Maintenance management facade (v2 verbs) and
 * the shared v1 Maintenance application service (`scan|plan|apply|undo`,
 * unchanged). `deps.service` stubs the v1 service; `deps.management` stubs
 * the ADR-0048 facade (`createManagementService()`), so tests never touch a
 * real filesystem or provider.
 * @param {{ flags: Record<string, any>, positionals: string[], deps?: { service?: any, management?: any } }} input */
export async function run({ flags, positionals, deps = {} }) {
  const verb = positionals[0] ?? 'scan';
  const handler = DISPATCH[verb];
  if (!handler || positionals.length > 2) {
    warn(`usage: ak maintain ${Object.keys(DISPATCH).join('|')} [options]`);
    return 2;
  }
  try {
    const outcome = await handler({ flags, sub: positionals[1] ?? null, positionals, deps });
    if (outcome.usageError) { warn(outcome.usageError); return 2; }
    emit(outcome, flags.json === true);
    return outcome.result?.ok === false ? 2 : 0;
  } catch (error) {
    warn(error?.message ?? String(error));
    return 2;
  }
}
