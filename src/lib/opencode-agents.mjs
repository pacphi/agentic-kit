// opencode-agents.mjs — ruflo catalog resolution + the Claude Code agent .md →
// OpenCode subagent .md conversion/sync/status pipeline. Split out of
// opencode.mjs (ADR-0037's file-size gate) — behavior and export names are
// unchanged; opencode.mjs re-exports the externally-consumed names so no
// import path elsewhere in the repo needed to change.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './settings.mjs';
import * as paths from './paths.mjs';
import { deepEqual, contentHash, hasReceiptValue, receiptMatches, asReceiptMap } from './opencode-receipts.mjs';

/** @typedef {{ kind: string, root: string, id: string, hasPlugins: boolean, hasPlatformSkill: boolean }} CatalogSource */

// ── ruflo catalog source (agents + skills) ──────────────────────────────────

/** Resolve where ruflo's agent/skill catalog comes from. Order: explicit
 *  override (kit.json integrations.ownership.opencode.catalogDir) →
 *  $RUFLO_REPO → the claude
 *  marketplace clone (full repo mirror, auto-updated by claude) → the
 *  published @claude-flow/cli package (subset: ADR-128 agents + core skills)
 *  → the nested copy under global ruflo/node_modules (the layout a plain
 *  `npm i -g ruflo` actually produces). Candidates are LAZY thunks: the
 *  npm-root lookups spawn `npm root -g` (cached per process), so evaluating
 *  them only when earlier candidates miss keeps status probes spawn-free on
 *  marketplace machines. Returns {kind, root, id, hasPlugins, hasPlatformSkill}
 *  or null.
 *  @param {{ override?: string }} [opts]
 *  @returns {CatalogSource|null} */
export function catalogSource({ override } = {}) {
  const candidates = [];
  if (override) candidates.push(() => ({ kind: 'override', root: override }));
  if (process.env.RUFLO_REPO) candidates.push(() => ({ kind: 'env', root: process.env.RUFLO_REPO }));
  candidates.push(() => ({ kind: 'marketplace', root: paths.rufloMarketplaceRoot() }));
  candidates.push(() => ({ kind: 'npm', root: paths.rufloCliPkgRoot() }));
  candidates.push(() => ({ kind: 'npm-nested', root: path.join(paths.rufloNodeModules(), '@claude-flow', 'cli') }));
  for (const thunk of candidates) {
    const c = thunk();
    if (!c.root || !fs.existsSync(path.join(c.root, '.claude', 'agents'))) continue;
    let version = null;
    try { version = JSON.parse(fs.readFileSync(path.join(c.root, 'package.json'), 'utf8')).version; } catch { /* unversioned source */ }
    return {
      ...c,
      id: `${c.kind}@${version ?? 'unversioned'}`,
      hasPlugins: fs.existsSync(path.join(c.root, 'plugins')),
      hasPlatformSkill: fs.existsSync(path.join(c.root, 'SKILL.md')),
    };
  }
  return null;
}

/** skills.paths entries for a catalog source (existing dirs only).
 *  @param {CatalogSource|null} source */
export function skillPathsFor(source) {
  if (!source) return [];
  const out = [path.join(source.root, '.claude', 'skills')];
  if (source.hasPlugins) out.push(path.join(source.root, 'plugins'));
  return out.filter((p) => fs.existsSync(p));
}

// ── agent conversion (Claude Code agent .md → opencode subagent .md) ─────────

/** Ownership markers on generated agent files — the current ak marker plus the
 *  legacy standalone-script marker, so the one-time script's output is adopted
 *  (removed/replaced) rather than orphaned. */
const AGENT_MARKERS = ['generated-by: agentic-kit', 'generated-by: sync-ruflo-agents.mjs'];
export const STAMP_FILE = '.ak-agents-stamp.json';

function* walkMd(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkMd(p);
    else if (e.isFile() && e.name.endsWith('.md')) yield p;
  }
}

/** Minimal YAML frontmatter reader: scalar fields + block scalars
 *  (description: | / >). A block scalar's content is every following line that
 *  is INDENTED, with blank lines allowed inside — terminating at the first
 *  blank (they'd otherwise truncate multi-paragraph descriptions and leak the
 *  remainder into mis-parsed fields). */
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const [, fm, body] = m;
  const fields = {};
  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const km = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!km) continue;
    const [, key, raw] = km;
    if (/^[>|]-?$/.test(raw) && i + 1 < lines.length) {
      const buf = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s+\S/.test(lines[i + 1]))) {
        const t = lines[++i].trim();
        if (t) buf.push(t);
      }
      fields[key] = buf.join(' ').trim();
    } else {
      fields[key] = raw.replace(/^["']|["']$/g, '').trim();
    }
  }
  return { fields, body };
}

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const lazyGatewayCall = (family, name) =>
  `\`${family}_call\` with \`name=${JSON.stringify(name)}\` and \`arguments_json\` set to one JSON object string`;

const directOpenCodeReferences = (body) => String(body)
  .replace(/mcp__(?:claude-flow|claude_flow|ruflo)__([A-Za-z0-9_./:*-]+)/g, 'claude-flow_$1')
  .replace(/mcp__(?:agentic-qe|agentic_qe)__([A-Za-z0-9_./:*-]+)/g, 'agentic-qe_$1');

/** Rewrite tool-name references inside an OpenCode-only generated agent so
 *  the instructions use the lazy gateway that is actually advertised. The
 *  Claude/Ruflo source file is never changed. Families without a managed
 *  gateway retain their direct OpenCode tool spelling.
 *  @param {string} body @param {{ruflo?:boolean,aqe?:boolean}} capabilities */
export function rewriteAgentGatewayReferences(body, capabilities = {}) {
  let result = directOpenCodeReferences(body);
  if (capabilities.ruflo) {
    result = result
      .replace(/\b(?:claude-flow|claude_flow)_\*/g,
        () => 'the Ruflo operation selected with `ak_ruflo_search`, then invoked through `ak_ruflo_call`')
      .replace(/\b(?:claude-flow|claude_flow)_([A-Za-z0-9_./:-]+)/g,
        (_match, name) => lazyGatewayCall('ruflo', name));
  }
  if (capabilities.aqe) {
    result = result
      .replace(/\b(?:agentic-qe|agentic_qe)_\*/g,
        () => 'the Agentic QE operation selected with `ak_aqe_search`, then invoked through `ak_aqe_call`')
      .replace(/\b(?:agentic-qe|agentic_qe)_([A-Za-z0-9_./:-]+)/g,
        (_match, name) => lazyGatewayCall('aqe', name));
  }
  return result;
}

/** Convert every agent under <src>/.claude/agents into opencode form:
 *  frontmatter → {description, mode: subagent} (Claude's `tools:` string list
 *  is dropped — OpenCode applies the subagent's permissions plus inherited
 *  parent/session deny rules); body MCP refs
 *  rewritten across all catalogue spellings. Lazy-gateway conversion emits
 *  ak_ruflo_call/ak_aqe_call guidance; direct fallback conversion emits OpenCode's
 *  direct tool spelling.
 *  basename collisions across category dirs get the parent dir prefixed. The
 *  description is emitted as a JSON double-quoted scalar (valid YAML 1.2 —
 *  unquoted values containing ': ' or '#' would corrupt the frontmatter).
 *  Pure (returns content, writes nothing).
 *  @param {string} srcRoot */
export function convertAgents(srcRoot, { gatewayCapabilities = {} } = {}) {
  const srcDir = path.join(srcRoot, '.claude', 'agents');
  const agents = [];
  let scanned = 0;
  for (const file of walkMd(srcDir)) {
    scanned++;
    const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!parsed) continue;
    // documentation masquerading as an agent (e.g. MIGRATION_SUMMARY.md)
    if (collapse(parsed.fields.type).toLowerCase() === 'documentation') continue;
    const description = collapse(parsed.fields.description);
    if (!description) continue;
    const rel = path.relative(srcDir, file);
    const dir = path.dirname(rel) === '.' ? null : path.dirname(rel).split(path.sep)[0];
    agents.push({
      base: path.basename(file, '.md'),
      dir,
      description,
      body: rewriteAgentGatewayReferences(parsed.body, gatewayCapabilities),
    });
  }
  const seen = new Set();
  let renamed = 0;
  for (const a of agents) {
    let name = a.base;
    if (seen.has(name)) { name = a.dir ? `${a.dir}-${a.base}` : `${a.base}-x`; renamed++; }
    let n = 2;
    while (seen.has(name)) name = `${a.dir ?? 'agent'}-${a.base}-${n++}`;
    seen.add(name);
    a.name = name;
    a.content = `---\ndescription: ${JSON.stringify(a.description)}\nmode: subagent\n---\n\n<!-- ${AGENT_MARKERS[0]} — re-synced by \`ak sync\`; do not edit -->\n${a.body}`;
  }
  return { agents, scanned, skipped: scanned - agents.length, renamed };
}

export const SPECIALIST_AGENT = {
  name: 'ak-specialist',
  description: 'Runs one Agentic Kit specialist profile selected lazily with ak_agent_search',
  content: `---
description: "Runs one Agentic Kit specialist profile selected lazily with ak_agent_search"
mode: subagent
---

<!-- ${AGENT_MARKERS[0]} — re-synced by \`ak sync\`; do not edit -->
You are the Agentic Kit specialist dispatcher for stock OpenCode.

The parent task must begin with \`PROFILE: <exact-name>\`. Call \`ak_agent_load\` with that exact
name before doing any work. Treat the returned receipt-owned profile as your specialist
instructions for the rest of this task. If the profile names an optional dependency that is not
available, report the missing dependency instead of inventing a result.
`,
};

export function specialistDispatcherState({
  destDir = paths.opencodeAgentsDir(), receipts = {}, adoptionBlocked = false,
} = {}) {
  if (adoptionBlocked) return { available: false, blocked: true };
  const file = 'ak-specialist.md';
  const target = path.join(destDir, file);
  if (!fs.existsSync(target)) return { available: true, blocked: false };
  let current;
  try { current = fs.readFileSync(target, 'utf8'); } catch {
    return { available: false, blocked: true };
  }
  if (receiptMatches(current, receipts?.[file])) return { available: true, blocked: false };
  if (hasReceiptValue(receipts?.[file])) return { available: false, blocked: true };
  const adoptable = current === SPECIALIST_AGENT.content && isGeneratedContent(current);
  return { available: adoptable, blocked: false };
}

function desiredAgentSet(source, gatewayCapabilities, lazyCatalog) {
  const converted = convertAgents(source.root, { gatewayCapabilities });
  return { ...converted, agents: lazyCatalog ? [SPECIALIST_AGENT] : converted.agents };
}

export function gatewayAgentCatalog(source) {
  if (!source) return [];
  return convertAgents(source.root, { gatewayCapabilities: {} }).agents.map((agent) => ({
    name: agent.name,
    description: agent.description,
    body: agent.body,
  }));
}

const isGeneratedContent = (text) => AGENT_MARKERS.some((m) => text.includes(m));

/** Write/adopt each desired agent file, skipping any user-owned collision.
 *  Returns per-run counts plus the exact list of files actually deployed. */
function deployDesiredAgents(agents, destDir, { dryRun, receiptMap, adoptionBlocked }) {
  let userOwned = 0, adopted = 0, written = 0;
  const deployed = [];
  for (const a of agents) {
    const file = `${a.name}.md`;
    const p = path.join(destDir, file);
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    const priorReceipt = receiptMap[file];
    const hasPriorReceipt = adoptionBlocked || hasReceiptValue(priorReceipt);
    const priorOwned = cur !== null && receiptMatches(cur, priorReceipt);
    const adoptable = cur === a.content && !hasPriorReceipt && isGeneratedContent(cur);
    if (cur !== null && !priorOwned && !adoptable) { userOwned++; continue; }
    if (adoptable) adopted++;
    deployed.push(file);
    if (cur !== a.content) {
      written++;
      if (!dryRun) fs.writeFileSync(p, a.content);
    }
  }
  return { userOwned, adopted, written, deployed };
}

/** Remove receipt-owned generated agent files that are no longer desired.
 *  Deploy/adopt the dispatcher or complete direct set BEFORE retiring any
 *  receipt-owned predecessor. A write failure therefore preserves the last
 *  known-good eager catalogue instead of leaving no executable agent path. */
function retireStaleGeneratedAgents(destDir, agents, receiptMap, { dryRun, lazyCatalog, deployed }) {
  let removed = 0;
  const removedFiles = new Set();
  if ((!lazyCatalog || deployed.includes('ak-specialist.md')) && fs.existsSync(destDir)) {
    for (const f of fs.readdirSync(destDir).filter((f) => f.endsWith('.md'))) {
      const p = path.join(destDir, f);
      let owned = false;
      try { owned = receiptMatches(fs.readFileSync(p, 'utf8'), receiptMap[f]); } catch { /* leave alone */ }
      const wanted = agents.some((a) => `${a.name}.md` === f);
      if (owned && !wanted) {
        if (!dryRun) fs.rmSync(p);
        removedFiles.add(f);
        removed++;
      }
    }
  }
  return { removed, removedFiles };
}

/** Compute + (when ownable) write the agent-set stamp file, returning the
 *  per-file content hashes and the stamp's own receipt for the caller's
 *  managed-artifacts ledger. */
function writeAgentStamp({ destDir, dryRun, source, gatewayCapabilities, lazyCatalog, deployed, agents, stampReceipt, adoptionBlocked }) {
  const deployedHashes = Object.fromEntries(deployed.map((f) => {
    const agent = agents.find((a) => `${a.name}.md` === f);
    return [f, contentHash(agent.content)];
  }));
  const gateway = { ruflo: !!gatewayCapabilities.ruflo, aqe: !!gatewayCapabilities.aqe };
  const stamp = {
    source: source.id, gateway, lazyCatalog: !!lazyCatalog,
    count: deployed.length, files: deployed.sort(), hashes: deployedHashes,
  };
  const stampText = JSON.stringify(stamp, null, 2) + '\n';
  const stampPath = path.join(destDir, STAMP_FILE);
  const priorStampText = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8') : null;
  const hasStampReceipt = adoptionBlocked || hasReceiptValue(stampReceipt);
  const stampOwned = priorStampText !== null && receiptMatches(priorStampText, stampReceipt);
  // The stamp has no marker of its own, so exact bytes are adoptable only when
  // every file it lists was independently receipt-owned, newly written, or
  // adopted through exact marker-bearing content.
  const stampAdoptable = priorStampText === stampText && !hasStampReceipt && deployed.length > 0
    && deployed.every((f) => {
      try {
        return contentHash(fs.readFileSync(path.join(destDir, f), 'utf8')) === deployedHashes[f];
      } catch { return false; }
    });
  const mayWriteStamp = priorStampText === null || stampOwned || stampAdoptable;
  if (!dryRun && mayWriteStamp && priorStampText !== stampText) {
    fs.writeFileSync(stampPath, stampText);
  }
  return { deployedHashes, stampReceipt: mayWriteStamp ? contentHash(stampText) : stampReceipt };
}

/** Reconcile the converted agent set into the dest dir: rewrite generated
 *  files, remove stale generated ones (either marker), NEVER overwrite a file
 *  that carries no generated marker (a user-owned agent with a colliding name
 *  is preserved and reported). The stamp records the source id + the exact
 *  generated file list and is only rewritten when the set actually changed
 *  (no per-run timestamp churn — idempotent-write semantics).
 *  @param {{ source: CatalogSource|null, destDir?: string, dryRun?: boolean, receipts?:Record<string,string>, stampReceipt?:string|null, adoptionBlocked?:boolean, gatewayCapabilities?:{ruflo?:boolean,aqe?:boolean}, lazyCatalog?:boolean }} opts */
export function syncAgents({
  source, destDir = paths.opencodeAgentsDir(), dryRun = false, receipts = {}, stampReceipt = null,
  adoptionBlocked = false, gatewayCapabilities = {}, lazyCatalog = false,
}) {
  if (!source) return { ok: false, changed: false, detail: 'no ruflo catalog source (marketplace clone or @claude-flow/cli) found' };
  const receiptMap = asReceiptMap(receipts);
  const { agents, scanned, skipped, renamed } = desiredAgentSet(
    source, gatewayCapabilities, lazyCatalog,
  );
  if (!dryRun) fs.mkdirSync(destDir, { recursive: true });
  const { userOwned, adopted, written, deployed } = deployDesiredAgents(
    agents, destDir, { dryRun, receiptMap, adoptionBlocked },
  );
  const { removed, removedFiles } = retireStaleGeneratedAgents(
    destDir, agents, receiptMap, { dryRun, lazyCatalog, deployed },
  );
  const changed = written > 0 || removed > 0;
  // The stamp records what was ACTUALLY deployed (a user-owned file occupying
  // a slot is never in it) — otherwise status would diverge forever.
  // Preserve a non-null mismatched receipt while its file still exists. If it
  // were dropped, a later pass could mistake the resulting absence for a
  // pre-receipts install and launder an edited file back into ak ownership.
  const nextReceipts = Object.fromEntries(Object.entries(receiptMap).filter(([f]) => (
    !removedFiles.has(f) && fs.existsSync(path.join(destDir, f))
  )));
  const { deployedHashes, stampReceipt: nextStampReceipt } = writeAgentStamp({
    destDir, dryRun, source, gatewayCapabilities, lazyCatalog, deployed, agents, stampReceipt, adoptionBlocked,
  });
  Object.assign(nextReceipts, deployedHashes);
  return {
    ok: !lazyCatalog || deployed.includes('ak-specialist.md'),
    changed,
    receipts: nextReceipts,
    stampReceipt: nextStampReceipt,
    adopted,
    detail: `${agents.length} ${lazyCatalog ? 'lazy dispatcher agent' : 'agents'} from ${source.id} (${written} written, ${removed} removed, ${skipped} skipped, ${renamed} collision-renamed${adopted ? `, ${adopted} adopted` : ''}${userOwned ? `, ${userOwned} user-owned preserved` : ''}; scanned ${scanned})`,
  };
}

function readAgentStamp(destDir) {
  const stampPath = path.join(destDir, STAMP_FILE);
  return {
    stamp: readJson(stampPath, null),
    stampText: fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8') : null,
  };
}

function countGeneratedAgentFiles(destDir) {
  if (!fs.existsSync(destDir)) return 0;
  let count = 0;
  for (const f of fs.readdirSync(destDir).filter((f) => f.endsWith('.md'))) {
    try { if (isGeneratedContent(fs.readFileSync(path.join(destDir, f), 'utf8'))) count++; } catch { /* skip */ }
  }
  return count;
}

/** The on-disk generated (receipt-owned or adoptable) agent file list,
 *  sorted. Adoptable files (exact marker-bearing desired bytes, no prior
 *  receipt) are appended to `adoptableFiles` as a side effect. */
function onDiskAgentFiles(destDir, desired, { hasReceiptLedger, receiptMap, adoptionBlocked, adoptableFiles }) {
  if (!fs.existsSync(destDir)) return [];
  return fs.readdirSync(destDir).filter((f) => {
    if (!f.endsWith('.md')) return false;
    try {
      const text = fs.readFileSync(path.join(destDir, f), 'utf8');
      if (hasReceiptLedger) {
        const hasReceipt = adoptionBlocked || hasReceiptValue(receiptMap[f]);
        const receiptOwned = receiptMatches(text, receiptMap[f]);
        const adoptable = !hasReceipt && isGeneratedContent(text) && desired.get(f) === text;
        if (adoptable) adoptableFiles.push(f);
        return receiptOwned || adoptable;
      }
      return isGeneratedContent(text);
    } catch { return false; }
  }).sort();
}

function agentContentDiverged(destDir, onDisk, stamp) {
  return !!stamp?.hashes && onDisk.some((f) => {
    try { return contentHash(fs.readFileSync(path.join(destDir, f), 'utf8')) !== stamp.hashes[f]; } catch { return true; }
  });
}

/** The stamp bytes syncAgents would write for today's on-disk generated set,
 *  or null when there's no source or the on-disk set doesn't fully match
 *  desired — used only for stamp-only adoption detection. */
function expectedAgentStampText(source, onDisk, desired, gatewayCapabilities, lazyCatalog) {
  if (!source || onDisk.length === 0 || !onDisk.every((f) => desired.has(f))) return null;
  return `${JSON.stringify({
    source: source.id,
    gateway: { ruflo: !!gatewayCapabilities.ruflo, aqe: !!gatewayCapabilities.aqe },
    lazyCatalog: !!lazyCatalog,
    count: onDisk.length,
    files: onDisk,
    // syncAgents hashes in converter declaration order, then sorts only
    // the separate files list. Preserve that byte order for exact
    // stamp-only adoption detection.
    hashes: Object.fromEntries([...desired.entries()]
      .filter(([f]) => onDisk.includes(f))
      .map(([f, text]) => [f, contentHash(text)])),
  }, null, 2)}\n`;
}

function agentReceiptDivergence(destDir, receiptMap) {
  if (!fs.existsSync(destDir)) return false;
  return fs.readdirSync(destDir).filter((f) => f.endsWith('.md')).some((f) => {
    try {
      return hasReceiptValue(receiptMap[f])
        && !receiptMatches(fs.readFileSync(path.join(destDir, f), 'utf8'), receiptMap[f]);
    } catch { return true; }
  });
}

/** Assemble agentsStatus's final result object from its computed signals. */
function agentsStatusResult({
  generatedCount, stamp, source, adoptionBlocked, adoptableFiles, stampAdoptable,
  contentDiverged, hasReceiptLedger, destDir, receiptMap, filesDiverged, lazyCatalog, gatewayCapabilities,
}) {
  return {
    count: generatedCount,
    stampedId: stamp?.source ?? null,
    currentId: source?.id ?? null,
    adoptable: !adoptionBlocked && (adoptableFiles.length > 0 || stampAdoptable),
    adoptionBlocked,
    modified: contentDiverged || (hasReceiptLedger && agentReceiptDivergence(destDir, receiptMap)),
    stale: !stamp || stamp.source !== (source?.id ?? null) || filesDiverged
      || !!stamp.lazyCatalog !== !!lazyCatalog
      || !deepEqual(stamp.gateway ?? { ruflo: false, aqe: false }, {
        ruflo: !!gatewayCapabilities.ruflo, aqe: !!gatewayCapabilities.aqe,
      }),
  };
}

/** Agent-set drift, honestly: stale when the stamp is missing, the catalog
 *  source id diverged (upgrade/marketplace pull), or the on-disk generated
 *  file set differs from the stamp. Count reports marker-bearing agents for
 *  visibility, while receipt/hash divergence is reported as `modified` so
 *  callers classify user edits as preserved rather than repairable drift.
 *  @param {{ source?: CatalogSource|null, destDir?: string, receipts?:Record<string,string>|null, stampReceipt?:string|null, adoptionBlocked?:boolean, gatewayCapabilities?:{ruflo?:boolean,aqe?:boolean}, lazyCatalog?:boolean }} [opts] */
export function agentsStatus({
  source, destDir = paths.opencodeAgentsDir(), receipts = null, stampReceipt = null,
  adoptionBlocked = false, gatewayCapabilities = {}, lazyCatalog = false,
} = {}) {
  const { stamp, stampText } = readAgentStamp(destDir);
  const hasReceiptLedger = receipts !== null;
  const receiptMap = asReceiptMap(receipts);
  const desired = source
    ? new Map(desiredAgentSet(source, gatewayCapabilities, lazyCatalog)
      .agents.map((a) => [`${a.name}.md`, a.content]))
    : new Map();
  const generatedCount = countGeneratedAgentFiles(destDir);
  const adoptableFiles = [];
  const onDisk = onDiskAgentFiles(destDir, desired, { hasReceiptLedger, receiptMap, adoptionBlocked, adoptableFiles });
  const stampFiles = Array.isArray(stamp?.files) ? [...stamp.files].sort() : null;
  const filesDiverged = stampFiles != null && JSON.stringify(stampFiles) !== JSON.stringify(onDisk);
  const contentDiverged = agentContentDiverged(destDir, onDisk, stamp);
  const expectedStamp = expectedAgentStampText(source, onDisk, desired, gatewayCapabilities, lazyCatalog);
  const stampAdoptable = hasReceiptLedger && !adoptionBlocked && !hasReceiptValue(stampReceipt)
    && expectedStamp !== null && stampText === expectedStamp;
  return agentsStatusResult({
    generatedCount, stamp, source, adoptionBlocked, adoptableFiles, stampAdoptable,
    contentDiverged, hasReceiptLedger, destDir, receiptMap, filesDiverged, lazyCatalog, gatewayCapabilities,
  });
}

