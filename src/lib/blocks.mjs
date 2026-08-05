// CLAUDE.md managed sentinel blocks — the port of _ruflo_block_upsert/_strip/
// _prepend and the conditional registry (_ruflo_cond_blocks). Sentinel format is
// UNCHANGED (`<!-- BEGIN <slug> -->` … `<!-- END <slug> -->`) so files written by
// the shell kit upgrade in place. Detectors are declarative (no eval'd shell —
// Windows-safe): {type: 'always'|'command'|'dir'|'file'|'glob-dir', target}.
// Built-in rows ship here; custom rows come from kit.json `customBlocks`.
//
// A `flag` detector ({type:'flag', target:'dualMode'}) gates a block on a
// caller-supplied boolean rather than the filesystem/PATH — the caller passes
// `syncBlocks(..., { context: { flags: { dualMode: <bool> } } })`. This is how
// we gate on kit.json enablement (both hosts on) instead of merely `codex` being
// on PATH. Absent context => false, so every legacy caller is unaffected.
//
// Rows may carry `guidanceFiles` (logical names, default ['claude']) declaring
// which guidance files they belong in — the caller loops targets via
// `blocksForTarget(rows, name)`. Logical names only; paths stay a caller concern.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, claudeMdPath, codexDir, opencodeDir, home } from './paths.mjs';
import { have } from './exec.mjs';
import { writeFileWithBackup } from './file-write.mjs';

export const BEGIN = (slug) => `<!-- BEGIN ${slug} -->`;
export const END = (slug) => `<!-- END ${slug} -->`;

/** Built-in registry. templatePath is package-relative (resolved by caller
 *  against the kit's own claude/ dir or the staged config dir). `position` is
 *  where the block lands when it is NOT already present in the file. */
export const BUILTIN_BLOCKS = [
  {
    // Host-agnostic operating rules — shared by the claude + opencode machine
    // guidance files (the opencode file exists BECAUSE opencode prefers it over
    // falling back to ~/.claude/CLAUDE.md, so it needs its own copy).
    slug: 'ruflo-preamble',
    template: 'ruflo-preamble.md',
    position: 'prepend',
    detector: { type: 'always' },
    guidanceFiles: ['claude', 'agents-opencode'],
  },
  {
    slug: 'ruflo-reference',
    template: 'ruflo-reference.md',
    position: 'append',
    detector: { type: 'always' },
  },
  {
    // opencode's ruflo surface: MCP tools are `claude-flow_*` (not
    // `mcp__claude-flow__*`), hooks arrive via the plugins/ bridge, and agents
    // are converted subagents — a different enough story to warrant its own
    // template rather than reusing ruflo-reference. Gated on ENABLEMENT (the
    // opencodeEnabled flag, same mechanism as dualMode) — the template asserts
    // active wiring, so an installed-but-disabled host must not receive it
    // (codex-review r2; and `x provider off` → next sync strips it).
    slug: 'ruflo-opencode-reference',
    template: 'ruflo-opencode-reference.md',
    position: 'append',
    detector: { type: 'flag', target: 'opencodeEnabled' },
    guidanceFiles: ['agents-opencode'],
  },
  {
    // opencode twin of ruvnet-brain-reference (that slug stays claude-only):
    // same ground-before-assert rule, but the tool name is the opencode-style
    // `ruvnet-brain_search_ruvnet` and updates ride the stable-spine shim.
    // Likewise enablement-gated: the tool exists in opencode only when wired.
    slug: 'ruvnet-brain-opencode-reference',
    template: 'ruvnet-brain-opencode-reference.md',
    position: 'append',
    detector: { type: 'flag', target: 'opencodeEnabled' },
    guidanceFiles: ['agents-opencode'],
  },
  {
    slug: 'ruflo-aqe-reference',
    template: 'aqe-reference.md',
    position: 'append',
    detector: { type: 'command', target: 'aqe' },
  },
  {
    slug: 'ruflo-superpowers-reference',
    template: 'superpowers-reference.md',
    position: 'append',
    // shell impl: find ~/.claude/plugins/cache -maxdepth 4 -type d -name superpowers
    detector: { type: 'glob-dir', target: 'superpowers', root: 'plugins/cache', maxDepth: 4 },
  },
  {
    // Only surfaces once the codex CLI is on PATH — mirrors the aqe block gated on
    // `command: aqe`. Documents the claude/codex host axis + `ak x host`.
    slug: 'ruflo-providers-reference',
    template: 'providers-reference.md',
    position: 'append',
    detector: { type: 'command', target: 'codex' },
  },
  {
    // Surfaces only when BOTH hosts are enabled in kit.json (dual mode) — gated
    // on a caller flag, not PATH, so it does not fire just because `codex` is
    // installed. Its content is MACHINE state (both hosts enabled in kit.json),
    // so it lands in the two MACHINE-scoped guidance files — ~/.claude/CLAUDE.md
    // (claude) and ~/.codex/AGENTS.md (agents-user) — never a repo's checked-in
    // AGENTS.md, which would leak machine truths into shared git history (ADR-0008).
    // Documents `ak run`, the Claude↔Codex bridge, and per-activity routing.
    slug: 'ruflo-dual-mode-reference',
    template: 'dual-mode-reference.md',
    position: 'append',
    detector: { type: 'flag', target: 'dualMode' },
    guidanceFiles: ['claude', 'agents-user'],
  },
  {
    // Surfaces once the RuvNet Brain KB is on disk. `dir` supports ~/ expansion;
    // uses the default KB path (honoring $RUVNET_BRAIN_KB in the detector is a
    // minor follow-up — the override is rare).
    slug: 'ruvnet-brain-reference',
    template: 'ruvnet-brain-reference.md',
    position: 'append',
    detector: { type: 'dir', target: '~/.cache/ruvnet-brain/kb' },
  },
];

/** Evaluate a declarative detector. Returns boolean. `context` carries
 *  caller-supplied signals the filesystem can't provide (e.g. kit.json
 *  enablement) — currently `context.flags` for the `flag` detector. Defaulted
 *  so `detect(detector)` keeps working for every existing caller. */
export async function detect(detector, context = {}) {
  switch (detector?.type) {
    case 'always': return true;
    case 'command': return have(detector.target);
    case 'flag': return !!context?.flags?.[detector.target];
    case 'file': return fs.existsSync(expand(detector.target));
    case 'dir': {
      const p = expand(detector.target);
      return fs.existsSync(p) && fs.statSync(p).isDirectory();
    }
    case 'glob-dir': {
      const root = path.join(claudeDir(), detector.root ?? '');
      return dirNamed(root, detector.target, detector.maxDepth ?? 4);
    }
    default: return false;
  }
}

function expand(p) {
  return p?.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function dirNamed(root, name, maxDepth, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(root)) return false;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === name) return true;
    if (dirNamed(path.join(root, e.name), name, maxDepth, depth + 1)) return true;
  }
  return false;
}

/** Detect the file's dominant line ending so patched output round-trips on
 *  Windows checkouts. */
const eol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const normalize = (s) => s.replace(/\r\n/g, '\n');
const denormalize = (s, ending) => (ending === '\r\n' ? s.replace(/\n/g, '\r\n') : s);

/** Is the block present in content? */
export function hasBlock(content, slug) {
  return normalize(content ?? '').includes(BEGIN(slug));
}

/** Upsert: replace in place when present (preserving everything outside the
 *  sentinels); otherwise append (or prepend, for position:'prepend') — exact
 *  port of _ruflo_block_upsert/_ruflo_block_prepend. Pure function on strings. */
export function upsertBlock(content, slug, blockText, position = 'append') {
  const block = normalize(blockText).replace(/\n+$/, '') + '\n';
  if (content == null || content === '') return block;
  const ending = eol(content);
  const text = normalize(content);
  const b = BEGIN(slug);
  const e = END(slug);
  let out;
  const bi = text.indexOf(b);
  const afterEndLine = bi !== -1 ? endOfSentinelLine(text, e, bi) : null;
  if (bi !== -1 && afterEndLine !== null) {
    out = text.slice(0, lineStart(text, bi)) + block + text.slice(afterEndLine);
  } else if (bi !== -1) {
    // Orphaned BEGIN (no END): append a fresh block instead of replacing "to
    // end-of-file" — the orphan stays visible for the user to clean up, and
    // nothing below it is destroyed.
    out = text.replace(/\n*$/, '\n') + '\n' + block;
  } else if (position === 'prepend') {
    out = block + '\n' + text;
  } else {
    out = text.replace(/\n*$/, '\n') + '\n' + block;
  }
  return denormalize(out, ending);
}

/** Strip the BEGIN..END block (inclusive, plus one trailing blank line). */
export function stripBlock(content, slug) {
  if (content == null) return content;
  const ending = eol(content);
  const text = normalize(content);
  const b = BEGIN(slug);
  const e = END(slug);
  const bi = text.indexOf(b);
  if (bi === -1) return content;
  const afterEndLine = endOfSentinelLine(text, e, bi);
  if (afterEndLine === null) return content; // orphaned BEGIN — never strip to EOF
  const tail = text.slice(afterEndLine).replace(/^\n/, '');
  // Collapse the blank separator line upsert added before the block.
  const head = text.slice(0, lineStart(text, bi)).replace(/\n+$/, '\n');
  return denormalize(head + tail, ending);
}

function lineStart(text, index) {
  const nl = text.lastIndexOf('\n', index - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** Index just past the newline that terminates the sentinel `e`'s line, or
 *  NULL when the END sentinel is missing. Callers must treat null as "no
 *  well-formed block here" — the old fallback (run to end-of-file) meant an
 *  orphaned BEGIN silently deleted everything below it on the next upsert:
 *  irreversible loss of the user's global CLAUDE.md content. */
function endOfSentinelLine(text, e, from) {
  const ei = text.indexOf(e, from);
  if (ei === -1) return null;
  const nl = text.indexOf('\n', ei);
  return nl === -1 ? text.length : nl + 1;
}

/** Full registry = built-ins + kit.json custom rows (already-validated shape). */
export function registry(customBlocks = []) {
  const custom = customBlocks
    .filter((r) => r && r.slug && r.templatePath && r.detector)
    .map((r) => ({
      slug: r.slug,
      template: r.templatePath,
      position: r.position ?? 'append',
      detector: r.detector,
      guidanceFiles: Array.isArray(r.guidanceFiles) ? r.guidanceFiles : ['claude'],
      custom: true,
    }));
  return [...BUILTIN_BLOCKS, ...custom];
}

/** Filter rows to those belonging in a given logical guidance file (default
 *  membership is ['claude'] when a row omits `guidanceFiles`). Pure — lets a
 *  caller loop guidance-file targets (claude → CLAUDE.md, agents → AGENTS.md)
 *  without hardcoding paths in this module. */
export function blocksForTarget(rows, targetName) {
  return rows.filter((r) => (r.guidanceFiles ?? ['claude']).includes(targetName));
}

/** Registry rows whose sentinel might linger in a target's file but which no
 *  longer belong there (they don't list `targetName` in guidanceFiles). This is
 *  the migration path for a RE-SCOPED block: pass these to `syncBlocks` alongside
 *  `blocksForTarget` and they are force-stripped when present. Each returned row
 *  carries a detector that never fires (`{type:'retired'}` → detect() falls to
 *  its default false), so a present block is stripped and an absent one is a
 *  no-op — the original detector (e.g. a live `flag`) can never re-upsert it into
 *  a file it must stay out of. Absent from the file → nothing happens (no write). */
export function retiredForTarget(rows, targetName) {
  return rows
    .filter((r) => !(r.guidanceFiles ?? ['claude']).includes(targetName))
    .map((r) => ({ ...r, detector: { type: 'retired' } }));
}

/** The logical guidance targets `sync` (apply) and `status` (dry-run) both loop.
 *  ONE source of truth so the two commands can never drift. Always: machine-wide
 *  `~/.claude/CLAUDE.md` (claude) + the project's own `<cwd>/AGENTS.md` (agents).
 *  The machine-scoped `~/.codex/AGENTS.md` (agents-user) is included ONLY when
 *  `~/.codex` already exists — codex's presence signal — and is NEVER created by
 *  this discovery (dir-exists gate, no mkdir). That single gate covers both cases:
 *  a codex machine that is momentarily single-host still gets the target (so a
 *  stale block can be stripped), and a codex-less machine never grows a ~/.codex.
 *  `~/.config/opencode/AGENTS.md` (agents-opencode) follows the identical rule
 *  (opencode's config home is its presence signal; opencode prefers this file
 *  over ~/.claude/CLAUDE.md, so it needs its own managed copy rather than
 *  inheriting claude's). `cfg` is accepted for call-site symmetry/forward-compat;
 *  the target set is cfg-independent today. `codexRoot`/`opencodeRoot` are test
 *  seams (default to the real dirs).
 *  @param {{ cwd?: string, cfg?: object, codexRoot?: string, opencodeRoot?: string }} opts */
export function guidanceTargets({ cwd = process.cwd(), codexRoot = codexDir(), opencodeRoot = opencodeDir() } = {}) {
  const targets = [
    { name: 'claude', label: 'CLAUDE.md', file: claudeMdPath() },
    { name: 'agents', label: 'AGENTS.md', file: path.join(cwd, 'AGENTS.md') },
  ];
  if (fs.existsSync(codexRoot)) {
    targets.push({ name: 'agents-user', label: '~/.codex/AGENTS.md', file: path.join(codexRoot, 'AGENTS.md') });
  }
  if (fs.existsSync(opencodeRoot)) {
    targets.push({ name: 'agents-opencode', label: 'opencode AGENTS.md', file: path.join(opencodeRoot, 'AGENTS.md') });
  }
  return targets;
}

/** Package-relative template resolution shared by setup and sync: custom rows
 *  are absolute or ~-expanded paths; built-ins resolve against the kit's own
 *  claude/ dir. */
export function templateResolver(pkgRoot) {
  return (r) => (r.custom
    ? (r.template.startsWith('~/') ? path.join(home, r.template.slice(2)) : r.template)
    : path.join(pkgRoot, 'claude', r.template));
}

/** Reconcile EVERY guidance target against the registry — the one loop
 *  `sync` (apply) and `setup`'s final pass both run, so the two commands can
 *  never drift. Per target: active rows upsert/strip per detector, and
 *  re-scoped rows are force-stripped (retiredForTarget). `context` carries the
 *  caller's flag signals for `flag` detectors (dualMode, opencodeEnabled).
 *  Returns [{name, label, changed}] where `changed` is a human-readable action
 *  summary ('' when the target was already in sync). */
export async function reconcileGuidance({ cwd, cfg, pkgRoot, context = {}, dryRun = false }) {
  const rows = registry(cfg.customBlocks);
  const resolve = templateResolver(pkgRoot);
  const out = [];
  for (const t of guidanceTargets({ cwd, cfg })) {
    const treg = [...blocksForTarget(rows, t.name), ...retiredForTarget(rows, t.name)];
    const res = await syncBlocks(t.file, treg, resolve, { context, dryRun });
    const changed = res.filter((r) => r.action !== 'unchanged' && r.action !== 'skipped')
      .map((r) => `${r.slug} ${r.action}`).join(', ');
    out.push({ name: t.name, label: t.label, changed });
  }
  return out;
}

/** Reconcile every registry row against its detector on a file.
 *  resolveTemplate(row) → absolute template path (built-ins resolve against the
 *  package's claude/ dir; custom rows are absolute or ~-expanded already).
 *  Returns [{slug, action: 'upserted'|'stripped'|'unchanged'|'missing-template', present}] —
 *  dryRun skips writes but reports the same actions. `context` is forwarded to
 *  every detector (see detect) so `flag`-gated rows can read caller signals such
 *  as `{ flags: { dualMode: <bool> } }`; omitting it preserves prior behavior.
 * @param {string} file
 * @param {Array<any>} rows
 * @param {(row: any) => string} resolveTemplate
 * @param {{dryRun?: boolean, context?: object, fileWriteOptions?: {fsImpl?: typeof fs}}} [options]
 */
export async function syncBlocks(file, rows, resolveTemplate, {
  dryRun = false, context = {}, fileWriteOptions,
} = {}) {
  const results = [];
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let changed = false;
  for (const row of rows) {
    const present = hasBlock(content, row.slug);
    const wanted = await detect(row.detector, context);
    if (wanted) {
      const tpl = resolveTemplate(row);
      if (!tpl || !fs.existsSync(tpl)) {
        results.push({ slug: row.slug, action: 'missing-template', present });
        continue;
      }
      const blockText = fs.readFileSync(tpl, 'utf8');
      const next = upsertBlock(content, row.slug, blockText, row.position);
      const action = next === content ? 'unchanged' : 'upserted';
      if (action === 'upserted') { content = next; changed = true; }
      results.push({ slug: row.slug, action, present: true });
    } else if (present) {
      content = stripBlock(content, row.slug);
      changed = true;
      results.push({ slug: row.slug, action: 'stripped', present: false });
    } else {
      results.push({ slug: row.slug, action: 'unchanged', present: false });
    }
  }
  if (changed && !dryRun) {
    writeFileWithBackup(file, content, fileWriteOptions);
  }
  return results;
}
