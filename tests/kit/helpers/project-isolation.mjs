// Project-scope isolation for tests that drive a real command entry point.
// sandboxHome() (home-sandbox.mjs) redirects every HOME-relative path, but
// sync/setup/uninstall also write relative to process.cwd(): the project's
// .claude/helpers/statusline.cjs, .claude/settings.local.json, CLAUDE.md,
// AGENTS.md. Run from the repository root, a test turns the REAL repository
// into the project under test — the baseline `pnpm test` rewrote the real
// statusline to the fixture's `9.9.9` ruflo version and stripped env keys from
// the real settings.local.json that way.
//
// isolateProject() does both halves: it moves the test process into a
// throwaway project for the whole file and registers a tripwire proving the
// real repository's guarded files byte-identical when the file ends. The
// repository is located from THIS file, never from process.cwd(), so the
// tripwire still watches the right tree after the chdir. Kept apart from
// home-sandbox.mjs, which must stay loadable in a bare `node -e` child.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxProject } from './home-sandbox.mjs';

/** The repository these tests belong to (tests/kit/helpers → repo root). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Project-scoped files a leaked command has written, relative to the repo root.
 *  .agentic-qe/llm-config.json is the #137 provider-cli leak. */
export const GUARDED_FILES = [
  '.claude/settings.local.json',
  '.claude/settings.json',
  '.claude/helpers/statusline.cjs',
  '.claude/helpers/.helpers-version',
  '.agentic-qe/llm-config.json',
  'CLAUDE.md',
  'AGENTS.md',
  '.mcp.json',
  '.codex/config.toml',
];

// `<file>.ak-<tag>-backup.<uuid>` / `-tmp.<uuid>` (owned-env-projection.mjs and
// friends) are written beside a settings file before ak edits it, and
// `<file>.agentic-kit-*.json` ownership receipts are adopted or dropped with it.
const isAkSibling = (base, name) => name.startsWith(`${base}.ak-`) || name.startsWith(`${base}.agentic-kit-`);

function siblingsOf(abs) {
  const base = path.basename(abs);
  try { return fs.readdirSync(path.dirname(abs)).filter((n) => isAkSibling(base, n)).sort(); } catch { return []; }
}

function readOrNull(abs) {
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

/**
 * Snapshot the guarded files of `root`: content (null when absent) plus any
 * ak backup/temp siblings already present.
 * @param {string} [root]
 * @param {string[]} [files]
 */
export function captureGuarded(root = REPO_ROOT, files = GUARDED_FILES) {
  const snap = new Map();
  for (const rel of files) {
    const abs = path.join(root, rel);
    snap.set(rel, { content: readOrNull(abs), siblings: siblingsOf(abs) });
  }
  return snap;
}

/**
 * Differences since `before`: `+ rel` created, `- rel` removed, `~ rel`
 * rewritten, and `+`/`- rel.ak-…` or `rel.agentic-kit-…` for an ak
 * backup/temp/receipt sibling that appeared or disappeared.
 * @param {Map<string, {content: string|null, siblings: string[]}>} before
 * @param {string} [root]
 * @returns {string[]}
 */
export function guardedChanges(before, root = REPO_ROOT) {
  const changes = [];
  for (const [rel, was] of before) {
    const abs = path.join(root, rel);
    const now = readOrNull(abs);
    if (was.content === null && now !== null) changes.push(`+ ${rel}`);
    else if (was.content !== null && now === null) changes.push(`- ${rel}`);
    else if (was.content !== now) changes.push(`~ ${rel}`);
    const dir = path.dirname(rel);
    const label = (name) => (dir === '.' ? name : `${dir}/${name}`);
    const nowSiblings = siblingsOf(abs);
    for (const name of nowSiblings) if (!was.siblings.includes(name)) changes.push(`+ ${label(name)}`);
    for (const name of was.siblings) if (!nowSiblings.includes(name)) changes.push(`- ${label(name)}`);
  }
  return changes;
}

/** Register the tripwire for this test file: the real repository's guarded
 *  files must be unchanged when the file's tests end. */
export function guardRealRepository(root = REPO_ROOT) {
  const before = captureGuarded(root);
  after(() => {
    const changes = guardedChanges(before, root);
    assert.deepEqual(changes, [],
      `the real repository at ${root} changed while this test file ran:\n  ${changes.join('\n  ')}\n`
      + 'A command under test wrote relative to process.cwd() outside isolateProject(). The writer may also be '
      + 'another test file running concurrently, or a live Claude Code/ruflo session hook in this checkout.');
  });
}

/**
 * Anchor this whole test file in a throwaway git project and guard the real
 * repository. Call once at module scope, after sandboxHome(). Per-test
 * process.chdir() calls keep working; they return to this project.
 * @param {string} prefix mkdtemp prefix
 * @returns {string} the sandbox project (realpath)
 */
export function isolateProject(prefix) {
  guardRealRepository();
  const project = sandboxProject(prefix);
  process.chdir(project);
  after(() => {
    // Leave the directory before removing it (Windows cannot remove its cwd).
    try { process.chdir(os.tmpdir()); } catch { /* best-effort */ }
    fs.rmSync(project, { recursive: true, force: true });
  });
  return project;
}
