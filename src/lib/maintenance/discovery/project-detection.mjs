// ADR-0048 repository identity — the ONE bounded, skipDir-based git-project
// detector shared by preview.mjs (advisory) and orchestrator.mjs (the real
// scan), so a source is never described differently depending on which of the
// two walked it (docs/MAINTENANCE.md
// "Sources"). A linked worktree and an initialized submodule share
// the identical `.git` FILE shape ("gitdir: <path>"); only the referenced path
// tells them apart, and a submodule is never its own project by default.
import { measureProjectKind } from '../../footprint/project-kind.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { opaqueId } from '../management/model.mjs';
import { exclusionAppliesTo } from './configuration.mjs';
import { readInstructionFileEvidence } from './instruction-files.mjs';

export { readInstructionFileEvidence };

export const CURATED_SKIP_DIRS = Object.freeze([
  'node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.venv', '__pycache__', '.tox',
]);
const CURATED_SKIP_SET = new Set(CURATED_SKIP_DIRS);
const GITLINK_READ_BYTES = 512;

/** Candidate project-root instruction files, checked by exact relative path
 *  only — no recursion, no directory listing. `name` is the display label
 *  (always forward-slash, independent of platform); `segments` is what
 *  `path.join` actually reads. */
export const PROJECT_INSTRUCTION_FILES = Object.freeze([
  { name: 'CLAUDE.md', segments: ['CLAUDE.md'], host: 'claude' },
  { name: 'CLAUDE.local.md', segments: ['CLAUDE.local.md'], host: 'claude' },
  { name: '.claude/CLAUDE.md', segments: ['.claude', 'CLAUDE.md'], host: 'claude' },
  { name: 'AGENTS.md', segments: ['AGENTS.md'], host: 'codex' },
  { name: '.codex/AGENTS.md', segments: ['.codex', 'AGENTS.md'], host: 'codex' },
]);

function isCuratedSkip(name) { return CURATED_SKIP_SET.has(name); }

function readGitFileText(file, fsImpl) {
  try {
    const fd = fsImpl.openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(GITLINK_READ_BYTES);
      const read = fsImpl.readSync(fd, buffer, 0, GITLINK_READ_BYTES, 0);
      return buffer.toString('utf8', 0, read);
    } finally { fsImpl.closeSync(fd); }
  } catch { return null; }
}

/** @returns {{ kind: 'worktree'|'submodule'|'unknown-linked', mainRepoRoot: string|null }}
 *  `mainRepoRoot` is the containing repository for BOTH a linked worktree
 *  (its main checkout) and a submodule (its parent repository) — the same
 *  concept either way: "the repository this linked `.git` file belongs to." */
export function classifyGitFile(file, fsImpl) {
  const text = readGitFileText(file, fsImpl);
  if (!text || !/^gitdir:/mu.test(text)) return { kind: 'unknown-linked', mainRepoRoot: null };
  const gitdir = text.slice(text.indexOf(':') + 1).split(/\r?\n/u)[0].trim();
  const absolute = path.isAbsolute(gitdir) ? gitdir : path.resolve(path.dirname(file), gitdir);
  const worktreeMatch = absolute.match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/u);
  if (worktreeMatch) return { kind: 'worktree', mainRepoRoot: worktreeMatch[1] };
  const submoduleMatch = absolute.match(/^(.*)[\\/]\.git[\\/]modules[\\/][^\\/]+.*$/u);
  if (submoduleMatch) return { kind: 'submodule', mainRepoRoot: submoduleMatch[1] };
  return { kind: 'unknown-linked', mainRepoRoot: null };
}

/** True (with its classification) when `root` ITSELF is a git checkout — the
 *  common case for an exact-project source, which a partitioned scan's per-
 *  child-directory partitions would never independently discover since none
 *  of them re-visits the source root's own directory entry. A submodule root
 *  is reported only when `includeSubmodules` opts in (design: "scanned only
 *  when explicitly included"). */
export function isRootItselfAProject(root, { fsImpl = fs, includeSubmodules = false } = {}) {
  const notAProject = { isProject: false, worktree: false, submodule: false, mainRepoRoot: null };
  const gitPath = path.join(root, '.git');
  let stat;
  try { stat = fsImpl.lstatSync(gitPath); } catch { return notAProject; }
  if (stat.isDirectory()) return { isProject: true, worktree: false, submodule: false, mainRepoRoot: null };
  if (!stat.isFile()) return notAProject;
  const { kind, mainRepoRoot } = classifyGitFile(gitPath, fsImpl);
  if (kind === 'submodule') return { isProject: includeSubmodules, worktree: false, submodule: true, mainRepoRoot };
  return { isProject: true, worktree: kind === 'worktree', submodule: false, mainRepoRoot: kind === 'worktree' ? mainRepoRoot : null };
}

/**
 * A walkTree-compatible ObservationSpec that reports every discovered project
 * (a `.git` directory, or a `.git` worktree-pointer file) via `onProject`,
 * skipping curated dependency/build/VCS-internal directories and any
 * configured exclusion. A submodule's `.git` file is read but reported only
 * when `includeSubmodules` opts in — the default excludes it entirely.
 *
 * @param {{ fsImpl?: typeof fs, exclusions?: Array<{path:string,recursive:boolean}>,
 *   includeSubmodules?: boolean,
 *   onProject: (project: {absoluteRoot: string, worktree: boolean, submodule: boolean,
 *     mainRepoRoot: string|null}) => void }} options
 */
export function projectDetectionSpec({
  fsImpl = fs, exclusions = [], includeSubmodules = false, onProject,
}) {
  return {
    fsImpl,
    skipDir(dir, name) {
      if (name === '.git') {
        onProject({
          absoluteRoot: path.dirname(dir), worktree: false, submodule: false, mainRepoRoot: null,
        });
        return true;
      }
      if (isCuratedSkip(name)) return true;
      return exclusionAppliesTo({ exclusions }, dir);
    },
    acceptFile(name) { return name === '.git'; },
    onFile({ file }) {
      const { kind, mainRepoRoot } = classifyGitFile(file, fsImpl);
      if (kind === 'submodule' && !includeSubmodules) return;
      onProject({
        absoluteRoot: path.dirname(file), worktree: kind === 'worktree', submodule: kind === 'submodule', mainRepoRoot,
      });
    },
  };
}

/** Every PRESENT instruction file at a project's own root — no recursion, no
 *  ancestor search. Absent candidates are simply omitted (unlike the
 *  automatic-source variant, a project's instruction file list only reports
 *  what it actually found). */
export function detectInstructionFiles(root, { fsImpl = fs } = {}) {
  const found = [];
  for (const candidate of PROJECT_INSTRUCTION_FILES) {
    const evidence = readInstructionFileEvidence(path.join(root, ...candidate.segments), { fsImpl });
    if (!evidence.present) continue;
    found.push({
      name: candidate.name, host: candidate.host, ...(evidence.digest ? { digest: evidence.digest } : {}),
    });
  }
  return found;
}

/** A stable, non-reversible project identity keyed on the project's real
 *  filesystem identity rather than any one scan's root — so the same
 *  directory yields the same `projectId` whether it is found by a preview or
 *  by the real scan, or from two different collection roots. */
export function projectIdentity(absoluteRoot, installationKey) {
  return opaqueId('prj', { path: path.resolve(absoluteRoot) }, installationKey);
}

/** True when `candidate` is a strict filesystem descendant of `ancestor`. */
function isDescendantOf(candidate, ancestor) {
  const relative = path.relative(ancestor, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Post-process a flat list of discovered project roots into the public,
 * path-free shape: opaque `projectId`, the shortest breadcrumb that still
 * distinguishes same-basename projects FROM EACH OTHER within this source,
 * `nested` when another discovered project is a filesystem ancestor, a shared
 * `repositoryKey` linking every linked worktree to its main checkout (present
 * on both sides when the main checkout was itself discovered), and
 * `submoduleOfProjectId` naming the containing repository for an explicitly-
 * included submodule. `instructionFiles` is read fresh from each project's
 * own root — bounded, non-recursive, content never retained.
 *
 * @param {Array<{absoluteRoot: string, worktree: boolean, submodule?: boolean,
 *   mainRepoRoot: string|null}>} found
 * @param {{ sourceRoot: string, installationKey: string, complete: boolean, fsImpl?: typeof fs }} options
 */
export function describeProjects(found, {
  sourceRoot, installationKey, complete, fsImpl = fs,
}) {
  const byRoot = new Map(found.map((entry) => [path.resolve(entry.absoluteRoot), entry]));
  const rows = [...byRoot.entries()].map(([absoluteRoot, entry]) => ({
    absoluteRoot,
    projectId: projectIdentity(absoluteRoot, installationKey),
    fullBreadcrumb: path.relative(sourceRoot, absoluteRoot).split(path.sep).filter(Boolean),
    worktree: entry.worktree || undefined,
    submodule: entry.submodule || undefined,
    mainRepoRoot: entry.mainRepoRoot ? path.resolve(entry.mainRepoRoot) : null,
    /** @type {string|undefined} */
    repositoryKey: undefined,
    /** @type {string|undefined} */
    submoduleOfProjectId: undefined,
    /** @type {boolean|undefined} */
    nested: undefined,
  }));

  for (const row of rows) {
    if (!row.mainRepoRoot) continue;
    const containingKey = projectIdentity(row.mainRepoRoot, installationKey);
    if (row.submodule) { row.submoduleOfProjectId = containingKey; continue; }
    row.repositoryKey = containingKey;
    const mainRow = byRootRow(rows, row.mainRepoRoot);
    if (mainRow) mainRow.repositoryKey = containingKey;
  }
  for (const row of rows) {
    row.nested = rows.some((other) => other !== row && isDescendantOf(row.absoluteRoot, other.absoluteRoot)) || undefined;
  }

  const breadcrumbs = shortestDistinguishingBreadcrumbs(rows.map((row) => row.fullBreadcrumb));
  return rows.map((row, index) => ({
    projectId: row.projectId,
    projectKind: measureProjectKind(row.absoluteRoot, { fsImpl }),
    breadcrumb: breadcrumbs[index],
    ...(row.worktree ? { worktree: true } : {}),
    ...(row.repositoryKey ? { repositoryKey: row.repositoryKey } : {}),
    ...(row.nested ? { nested: true } : {}),
    ...(row.submoduleOfProjectId ? { submoduleOfProjectId: row.submoduleOfProjectId } : {}),
    instructionFiles: detectInstructionFiles(row.absoluteRoot, { fsImpl }),
    complete,
  }));
}

function byRootRow(rows, absoluteRoot) {
  const resolved = path.resolve(absoluteRoot);
  return rows.find((row) => row.absoluteRoot === resolved);
}

/** Given full breadcrumbs, replace each with the SHORTEST trailing suffix
 *  (minimum 1 segment) that is unique among every OTHER breadcrumb sharing its
 *  basename. A project whose basename is unique in the set needs only its own
 *  basename — a UI shows path context solely where a name collides. */
export function shortestDistinguishingBreadcrumbs(fullBreadcrumbs) {
  const groups = new Map();
  fullBreadcrumbs.forEach((crumb, index) => {
    const basename = crumb.at(-1) ?? '';
    const list = groups.get(basename) ?? [];
    list.push(index);
    groups.set(basename, list);
  });
  const out = new Array(fullBreadcrumbs.length);
  for (const indexes of groups.values()) {
    if (indexes.length === 1) {
      out[indexes[0]] = fullBreadcrumbs[indexes[0]].slice(-1);
      continue;
    }
    const maxLen = Math.max(...indexes.map((i) => fullBreadcrumbs[i].length));
    let k = 1;
    for (; k <= maxLen; k += 1) {
      const suffixes = indexes.map((i) => fullBreadcrumbs[i].slice(-k).join('\u0000'));
      if (new Set(suffixes).size === indexes.length) break;
    }
    for (const i of indexes) out[i] = fullBreadcrumbs[i].slice(-k);
  }
  return out;
}
