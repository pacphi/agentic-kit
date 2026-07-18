// CLAUDE.md managed sentinel blocks — the port of _ruflo_block_upsert/_strip/
// _prepend and the conditional registry (_ruflo_cond_blocks). Sentinel format is
// UNCHANGED (`<!-- BEGIN <slug> -->` … `<!-- END <slug> -->`) so files written by
// the shell kit upgrade in place. Detectors are declarative (no eval'd shell —
// Windows-safe): {type: 'always'|'command'|'dir'|'file'|'glob-dir', target}.
// Built-in rows ship here; custom rows come from kit.json `customBlocks`.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, home } from './paths.mjs';
import { have } from './exec.mjs';

export const BEGIN = (slug) => `<!-- BEGIN ${slug} -->`;
export const END = (slug) => `<!-- END ${slug} -->`;

/** Built-in registry. templatePath is package-relative (resolved by caller
 *  against the kit's own claude/ dir or the staged config dir). `position` is
 *  where the block lands when it is NOT already present in the file. */
export const BUILTIN_BLOCKS = [
  {
    slug: 'ruflo-preamble',
    template: 'ruflo-preamble.md',
    position: 'prepend',
    detector: { type: 'always' },
  },
  {
    slug: 'ruflo-reference',
    template: 'ruflo-reference.md',
    position: 'append',
    detector: { type: 'always' },
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
    // `command: aqe`. Documents the claude/codex host axis + `ak x provider`.
    slug: 'ruflo-providers-reference',
    template: 'providers-reference.md',
    position: 'append',
    detector: { type: 'command', target: 'codex' },
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

/** Evaluate a declarative detector. Returns boolean. */
export async function detect(detector) {
  switch (detector?.type) {
    case 'always': return true;
    case 'command': return have(detector.target);
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
    .map((r) => ({ slug: r.slug, template: r.templatePath, position: r.position ?? 'append', detector: r.detector, custom: true }));
  return [...BUILTIN_BLOCKS, ...custom];
}

/** Reconcile every registry row against its detector on a file.
 *  resolveTemplate(row) → absolute template path (built-ins resolve against the
 *  package's claude/ dir; custom rows are absolute or ~-expanded already).
 *  Returns [{slug, action: 'upserted'|'stripped'|'unchanged'|'missing-template', present}] —
 *  dryRun skips writes but reports the same actions. */
export async function syncBlocks(file, rows, resolveTemplate, { dryRun = false } = {}) {
  const results = [];
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let changed = false;
  for (const row of rows) {
    const present = hasBlock(content, row.slug);
    const wanted = await detect(row.detector);
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // One-time backup before the first rewrite of the user's CLAUDE.md —
    // same contract as settings.mjs writeJsonWithBackup (never overwrite an
    // existing .bak): this file is the user's global instructions, and every
    // other writer in the kit is backup-first.
    const bak = `${file}.bak`;
    if (fs.existsSync(file) && !fs.existsSync(bak)) {
      try { fs.copyFileSync(file, bak); } catch { /* best-effort */ }
    }
    fs.writeFileSync(file, content);
  }
  return results;
}
