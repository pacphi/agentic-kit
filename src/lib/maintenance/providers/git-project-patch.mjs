// ADR-0048 provider-and-action-policy.md "Git-aware project patches" (MNT-ACT-015/016).
// One exact server-derived file replacement inside a configured, trusted
// project root. The patch definition (target, expected preimage digest,
// replacement content, validation kind, declared checks) is entirely
// server-authored — it never comes from the browser. The browser only ever
// supplies the opaque resourceId/actionId that this provider already knows
// about, exactly like every other Managed provider in this file.
//
// Safety invariants proven by this module (see
// tests/kit/maintenance-git-project-patch.test.mjs):
//   - the target root must be one of the provider's configured `projectRoots`;
//   - the target path may not cross a symlink, a submodule, or `..`;
//   - unrelated dirty files in the worktree are permitted; the exact target
//     path must have no index/worktree drift and must match the recorded
//     preimage digest before apply proceeds;
//   - `run` is never invoked with `stash`, `commit`, `branch`, `checkout`,
//     `push`, or `merge` — only `status`, `ls-files`, and caller-declared
//     checks;
//   - replacement is an atomic tmp+rename; a declared-check failure restores
//     the exact original bytes before reporting a non-mutating refusal.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { inspectCodexTomlStructure } from '../../codex-toml-safety.mjs';
import { maintenanceControlDir } from '../../paths.mjs';
import { runNativeCommand } from '../native-command.mjs';
import { baseAction, executableSafetyClass, sha256 } from './shared.mjs';

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const VALIDATION_KINDS = new Set(['json', 'toml', 'yaml', 'none']);
const BINARY = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_DECLARED_CHECKS = 5;
const MAX_CHECK_ARGS = 8;
const MAX_PREVIEW_SIDE_LINES = 100;
const PROVIDER_ID = 'git-project-patch';
const PROVIDER_VERSION = 'v1';

function resolvedAbsolute(value) {
  return typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : null;
}

function relativePathOk(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) return false;
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function declaredChecksOk(value) {
  if (value == null) return true;
  if (!Array.isArray(value) || value.length > MAX_DECLARED_CHECKS) return false;
  return value.every((check) => BINARY.test(check?.binary ?? '')
    && Array.isArray(check?.args) && check.args.length <= MAX_CHECK_ARGS
    && check.args.every((arg) => typeof arg === 'string' && arg.length <= 512 && !arg.includes('\0')));
}

function identityName(relPath) {
  const name = relPath.split('/').join(':');
  return name.length > 0 && name.length <= 256 ? name : null;
}

function validatePatch(raw, roots) {
  const resourceId = RESOURCE_ID.test(raw?.resourceId ?? '') ? raw.resourceId : null;
  if (!resourceId) return { ok: false, resourceId: null, reason: 'invalid-resource-id' };
  const projectRoot = resolvedAbsolute(raw.projectRoot);
  if (!projectRoot || !roots.includes(projectRoot)) {
    return { ok: false, resourceId, reason: 'target-outside-configured-project-roots' };
  }
  if (!relativePathOk(raw.targetRelativePath)) {
    return { ok: false, resourceId, reason: 'invalid-target-relative-path' };
  }
  if (!DIGEST.test(raw.expectedPreimageDigest ?? '')) {
    return { ok: false, resourceId, reason: 'invalid-expected-preimage-digest' };
  }
  if (typeof raw.replacementContent !== 'string'
      || Buffer.byteLength(raw.replacementContent) > MAX_CONTENT_BYTES) {
    return { ok: false, resourceId, reason: 'replacement-content-too-large-or-invalid' };
  }
  if (!VALIDATION_KINDS.has(raw.validation ?? 'none')) {
    return { ok: false, resourceId, reason: 'unsupported-validation-kind' };
  }
  if (!declaredChecksOk(raw.declaredChecks)) {
    return { ok: false, resourceId, reason: 'invalid-declared-checks' };
  }
  const name = identityName(raw.targetRelativePath);
  if (!name) return { ok: false, resourceId, reason: 'target-relative-path-too-long' };
  return {
    ok: true,
    resourceId,
    value: {
      resourceId, projectRoot, targetRelativePath: raw.targetRelativePath, name,
      expectedPreimageDigest: raw.expectedPreimageDigest, replacementContent: raw.replacementContent,
      validation: raw.validation ?? 'none', declaredChecks: raw.declaredChecks ?? [],
    },
  };
}

function safeDirectory(target, fsImpl) {
  try {
    const stat = fsImpl.lstatSync(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch { return false; }
}

/** Refuse a target reached through any symlinked path segment. */
function walkSymlinkSafe(root, relPath, fsImpl) {
  let current = root;
  const segments = relPath.split('/');
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fsImpl.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT' && index === segments.length - 1) return { ok: true, absent: true };
      return { ok: false, reason: 'path-segment-unreadable' };
    }
    if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink-in-path' };
    if (index < segments.length - 1 && !stat.isDirectory()) return { ok: false, reason: 'path-segment-not-a-directory' };
  }
  return { ok: true, absent: false };
}

function submodulePaths(root, fsImpl) {
  let content;
  try { content = fsImpl.readFileSync(path.join(root, '.gitmodules'), 'utf8'); } catch { return []; }
  const paths = [];
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (match) paths.push(match[1].replace(/\\/g, '/'));
  }
  return paths;
}

function underSubmodule(relPath, submodules) {
  return submodules.some((sub) => relPath === sub || relPath.startsWith(`${sub}/`));
}

function currentDigest(root, relPath, fsImpl) {
  const abs = path.join(root, relPath);
  let buffer;
  try {
    buffer = fsImpl.readFileSync(abs);
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  if (buffer.byteLength > MAX_CONTENT_BYTES) return { status: 'too-large' };
  return { status: 'present', digest: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.byteLength };
}

function parsePorcelainZ(stdout) {
  return String(stdout ?? '').split('\0').filter(Boolean);
}

async function gitScopedStatus(root, relPath, run) {
  let result;
  try { result = await run('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--', relPath]); }
  catch { return { ok: false }; }
  if (!result?.ok) return { ok: false };
  return { ok: true, entries: parsePorcelainZ(result.stdout) };
}

const GIT_SYMLINK_MODE = '120000';

/** `git ls-files --stage` reports the exact index mode for the target path.
 * A symlink mode (120000) here is a git-level signal our filesystem lstat
 * walk could miss on a filesystem that resolves symlinks transparently to
 * `readFileSync`; this is defense-in-depth alongside `walkSymlinkSafe`. */
async function gitIndexMode(root, relPath, run) {
  let result;
  try { result = await run('git', ['-C', root, 'ls-files', '--stage', '--', relPath]); }
  catch { return { ok: false }; }
  if (!result?.ok) return { ok: false };
  const lines = String(result.stdout ?? '').split('\n').filter(Boolean);
  if (lines.length > 1) return { ok: true, mode: 'ambiguous' };
  const [entry] = lines;
  const mode = entry ? entry.split(/\s+/)[0] : null;
  return { ok: true, mode };
}

/** Read-only inspection: symlink/submodule safety, current digest, and
 * scoped git drift for exactly one target path. Never runs a mutating git
 * verb; only `status` and `ls-files` are ever invoked. */
async function inspectPatch(def, { run, fsImpl }) {
  if (!safeDirectory(def.projectRoot, fsImpl)) return { status: 'unsafe', reason: 'project-root-unsafe-or-unreadable' };
  if (underSubmodule(def.targetRelativePath, submodulePaths(def.projectRoot, fsImpl))) {
    return { status: 'unsafe', reason: 'submodule-target-forbidden' };
  }
  const walk = walkSymlinkSafe(def.projectRoot, def.targetRelativePath, fsImpl);
  if (!walk.ok) return { status: 'unsafe', reason: walk.reason };
  const digestResult = currentDigest(def.projectRoot, def.targetRelativePath, fsImpl);
  if (digestResult.status !== 'present') return { status: digestResult.status };
  const indexMode = await gitIndexMode(def.projectRoot, def.targetRelativePath, run);
  if (!indexMode.ok) return { status: 'unsupported', reason: 'git-ls-files-unavailable' };
  if (indexMode.mode === GIT_SYMLINK_MODE) return { status: 'unsafe', reason: 'symlink-in-index' };
  const scoped = await gitScopedStatus(def.projectRoot, def.targetRelativePath, run);
  if (!scoped.ok) return { status: 'unsupported', reason: 'git-status-unavailable' };
  if (scoped.entries.length) return { status: 'drift', reason: 'index-or-worktree-drift' };
  if (digestResult.digest !== def.expectedPreimageDigest) return { status: 'drift', reason: 'affected-path-drift' };
  return { status: 'matches-preimage', digest: digestResult.digest, bytes: digestResult.bytes };
}

const preimageFingerprint = (def, digest) => sha256({
  provider: `${PROVIDER_ID}/${PROVIDER_VERSION}`, resourceId: def.resourceId, digest,
});
const currentStateFingerprint = (def, digest) => sha256({
  provider: `${PROVIDER_ID}/${PROVIDER_VERSION}`, resourceId: def.resourceId, state: 'applied', digest,
});

function toLines(content) {
  return String(content ?? '').split(/\r?\n/);
}

/** Bounded prefix/suffix line diff — not a minimal LCS unified diff, but a
 * deterministic, cheap, safe approximation that is bounded and copyable
 * (MNT-ACT-015). Structured config edits (the only kind this provider
 * supports) are almost always a contiguous middle-section change, which this
 * captures exactly. */
function buildPreview(beforeText, afterText) {
  const before = toLines(beforeText);
  const after = toLines(afterText);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let tailBefore = before.length;
  let tailAfter = after.length;
  while (tailBefore > prefix && tailAfter > prefix && before[tailBefore - 1] === after[tailAfter - 1]) {
    tailBefore -= 1;
    tailAfter -= 1;
  }
  const removed = before.slice(prefix, tailBefore);
  const added = after.slice(prefix, tailAfter);
  const lines = [
    ...removed.slice(0, MAX_PREVIEW_SIDE_LINES).map((line) => `-${line}`),
    ...added.slice(0, MAX_PREVIEW_SIDE_LINES).map((line) => `+${line}`),
  ];
  if (removed.length > MAX_PREVIEW_SIDE_LINES || added.length > MAX_PREVIEW_SIDE_LINES) {
    lines.push('… preview truncated …');
  }
  return lines;
}

function validateSyntax(kind, content) {
  if (kind === 'none') return { ok: true };
  if (kind === 'json') {
    try { JSON.parse(content); return { ok: true }; } catch { return { ok: false, reason: 'invalid-json' }; }
  }
  if (kind === 'toml') {
    const result = inspectCodexTomlStructure(content);
    return result.valid ? { ok: true } : { ok: false, reason: 'invalid-toml' };
  }
  // Minimal YAML sanity check (zero-dependency): YAML forbids tabs for
  // indentation and this catches the most common accidental corruption
  // without attempting a full YAML grammar.
  const hasTabIndent = toLines(content).some((line) => /^\t/.test(line));
  return hasTabIndent ? { ok: false, reason: 'tab-indentation-in-yaml' } : { ok: true };
}

function atomicReplace(file, content, fsImpl) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fsImpl.openSync(tmp, 'wx');
    fsImpl.writeFileSync(fd, content);
    fsImpl.fsyncSync?.(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* best effort */ } }
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* absent or already renamed */ }
  }
}

/** Reversibility requires the exact preimage bytes, not merely their digest.
 * They are retained privately under the maintenance transactions tree (0700
 * dir, 0600 file), keyed by resourceId + preimage digest, so a later `undo`
 * — possibly in a different process — can restore the exact original file. */
function preimageCacheFile(preimageRoot, def, digest) {
  const key = sha256({ resourceId: def.resourceId, digest });
  return path.join(preimageRoot, `${key}.bin`);
}

function storePreimage(preimageRoot, def, digest, bytes, fsImpl) {
  fsImpl.mkdirSync(preimageRoot, { recursive: true, mode: 0o700 });
  fsImpl.chmodSync?.(preimageRoot, 0o700);
  const file = preimageCacheFile(preimageRoot, def, digest);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fsImpl.openSync(tmp, 'wx', 0o600);
    fsImpl.writeFileSync(fd, bytes);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(tmp, file);
    fsImpl.chmodSync?.(file, 0o600);
  } finally {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* best effort */ } }
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* absent or already renamed */ }
  }
}

function readPreimage(preimageRoot, def, digest, fsImpl) {
  try { return fsImpl.readFileSync(preimageCacheFile(preimageRoot, def, digest)); } catch { return null; }
}

async function runDeclaredChecks(checks, root, run) {
  for (const check of checks ?? []) {
    let result;
    try { result = await run(check.binary, [...(check.args ?? [])], { cwd: root }); } catch {
      return { ok: false, reason: 'check-failed-to-run' };
    }
    if (!result?.ok) return { ok: false, reason: `check-exit-${result?.exitCode ?? 'unknown'}` };
  }
  return { ok: true };
}

function actionRequest(finding) {
  const resource = finding?.resource ?? finding?.resourceIdentity;
  const eligible = resource?.kind === 'project-file'
    && finding?.nextAction?.operation === 'apply-project-patch'
    && executableSafetyClass(finding?.safetyClass);
  return eligible ? resource : null;
}

const DEFAULT_PREIMAGE_ROOT = () => path.join(maintenanceControlDir(), 'transactions', 'patch-preimages');

/** @param {{ run?: any, fsImpl?: any, projectRoots?: (() => string[])|string[], patches?: any[], now?: () => number, preimageRoot?: string }} options */
export function createGitProjectPatchProvider({
  run = runNativeCommand, fsImpl = fs, projectRoots = () => [], patches = [], now = Date.now,
  preimageRoot = DEFAULT_PREIMAGE_ROOT(),
} = {}) {
  const rootsFn = typeof projectRoots === 'function'
    ? projectRoots
    : () => (Array.isArray(projectRoots) ? projectRoots : []);
  const resolvedRoots = () => [...new Set(rootsFn().map(resolvedAbsolute).filter(Boolean))];
  if (!resolvedRoots().length) {
    throw new TypeError('git project-patch provider requires at least one absolute project root');
  }

  function groupedDefinitions() {
    const grouped = new Map();
    const roots = resolvedRoots();
    for (const raw of Array.isArray(patches) ? patches : []) {
      const result = validatePatch(raw, roots);
      if (!result.resourceId) continue;
      const rows = grouped.get(result.resourceId) ?? [];
      rows.push(result);
      grouped.set(result.resourceId, rows);
    }
    return grouped;
  }

  function exactDefinition(resourceId) {
    const rows = groupedDefinitions().get(resourceId) ?? [];
    return rows.length === 1 && rows[0].ok ? rows[0].value : null;
  }

  async function detect() {
    const grouped = groupedDefinitions();
    const facts = [];
    for (const [resourceId, rows] of grouped) {
      if (rows.length !== 1) { facts.push({ resourceId, status: 'ambiguous' }); continue; }
      if (!rows[0].ok) { facts.push({ resourceId, status: 'unsupported', reason: rows[0].reason }); continue; }
      const inspected = await inspectPatch(rows[0].value, { run, fsImpl });
      facts.push({ resourceId, ...inspected });
    }
    return {
      status: 'available',
      complete: facts.every((fact) => fact.status !== 'unsupported' && fact.status !== 'ambiguous'),
      authority: 'git-worktree-inspection', asOf: new Date(now()).toISOString(), patches: facts,
    };
  }

  function actionFor(finding, facts) {
    const resource = actionRequest(finding);
    if (!resource) return null;
    const def = exactDefinition(resource.id);
    const fact = facts?.patches?.find((row) => row.resourceId === resource.id);
    if (!def || fact?.status !== 'matches-preimage') return null;
    let currentText;
    try { currentText = fsImpl.readFileSync(path.join(def.projectRoot, def.targetRelativePath), 'utf8'); } catch {
      return null;
    }
    const preview = buildPreview(currentText, def.replacementContent);
    const enrichedFinding = { ...finding, impact: { ...(finding.impact ?? {}), preview } };
    return baseAction(enrichedFinding, {
      providerId: PROVIDER_ID, providerVersion: PROVIDER_VERSION, operation: 'apply-project-patch',
      sourceFingerprint: preimageFingerprint(def, fact.digest), rollback: 'reversible', restart: 'not-required',
    });
  }

  async function preflight(action) {
    const def = exactDefinition(action?.resourceIdentity?.id);
    if (!def || action?.operation !== 'apply-project-patch') return { ok: false, sourceFingerprint: null };
    const inspected = await inspectPatch(def, { run, fsImpl });
    const fingerprint = inspected.status === 'matches-preimage' ? preimageFingerprint(def, inspected.digest) : null;
    return { ok: Boolean(fingerprint) && fingerprint === action.sourceFingerprint, sourceFingerprint: fingerprint };
  }

  async function apply(action) {
    const def = exactDefinition(action?.resourceIdentity?.id);
    if (!def || action?.operation !== 'apply-project-patch') {
      return { status: 'refused', summary: 'Project patch identity is invalid.' };
    }
    const inspected = await inspectPatch(def, { run, fsImpl });
    if (inspected.status !== 'matches-preimage' || preimageFingerprint(def, inspected.digest) !== action.sourceFingerprint) {
      return { status: 'refused', summary: 'The target file changed since preview; apply was refused.' };
    }
    const validation = validateSyntax(def.validation, def.replacementContent);
    if (!validation.ok) return { status: 'refused', summary: `Replacement content failed ${def.validation} validation.` };
    const abs = path.join(def.projectRoot, def.targetRelativePath);
    let original;
    try { original = fsImpl.readFileSync(abs); } catch {
      return { status: 'unknown', summary: 'The preimage could not be re-read before replacement.' };
    }
    try { atomicReplace(abs, def.replacementContent, fsImpl); } catch {
      return { status: 'unknown', summary: 'File replacement outcome could not be proven.' };
    }
    const checkResult = await runDeclaredChecks(def.declaredChecks, def.projectRoot, run);
    if (!checkResult.ok) {
      try {
        atomicReplace(abs, original, fsImpl);
        return {
          status: 'refused',
          summary: `A declared check failed after replacement (${checkResult.reason}); the original content was restored.`,
        };
      } catch {
        return { status: 'unknown', summary: 'A declared check failed and the original content could not be restored.' };
      }
    }
    try { storePreimage(preimageRoot, def, def.expectedPreimageDigest, original, fsImpl); } catch {
      // The write already committed; guarded restore degrades to unavailable
      // rather than pretending the mutation did not happen.
    }
    const postDigest = createHash('sha256').update(def.replacementContent).digest('hex');
    return {
      status: 'applied', postFingerprint: currentStateFingerprint(def, postDigest),
      summary: 'Project file patch applied and declared checks passed.',
    };
  }

  async function verify(action, outcome) {
    const def = exactDefinition(action?.resourceIdentity?.id);
    if (!def) return { ok: false, postFingerprint: null };
    const current = currentDigest(def.projectRoot, def.targetRelativePath, fsImpl);
    const postFingerprint = current.status === 'present' ? currentStateFingerprint(def, current.digest) : null;
    return { ok: Boolean(postFingerprint) && postFingerprint === outcome?.postFingerprint, postFingerprint };
  }

  async function inspectCurrent(entry) {
    const def = exactDefinition(entry?.resourceIdentity?.id);
    if (!def) return { complete: false, postFingerprint: null };
    const current = currentDigest(def.projectRoot, def.targetRelativePath, fsImpl);
    if (current.status !== 'present') return { complete: false, postFingerprint: null };
    return { complete: true, postFingerprint: currentStateFingerprint(def, current.digest) };
  }

  async function undo(entry) {
    const def = exactDefinition(entry?.resourceIdentity?.id);
    if (!def || entry?.operation !== 'apply-project-patch') {
      return { status: 'refused', summary: 'Only an exact applied project patch is reversible.' };
    }
    const current = currentDigest(def.projectRoot, def.targetRelativePath, fsImpl);
    if (current.status !== 'present' || currentStateFingerprint(def, current.digest) !== entry?.outcome?.postFingerprint) {
      return { status: 'refused', summary: 'The current content no longer matches the applied postimage; restore was preserved.' };
    }
    const preimageBytes = readPreimage(preimageRoot, def, def.expectedPreimageDigest, fsImpl);
    if (!preimageBytes || createHash('sha256').update(preimageBytes).digest('hex') !== def.expectedPreimageDigest) {
      return { status: 'refused', summary: 'The retained preimage is unavailable or does not match; restore was preserved.' };
    }
    const abs = path.join(def.projectRoot, def.targetRelativePath);
    try {
      atomicReplace(abs, preimageBytes, fsImpl);
    } catch {
      return { status: 'unknown', summary: 'Restore outcome could not be proven; inspect current state.' };
    }
    return { status: 'restored', sourceFingerprint: preimageFingerprint(def, def.expectedPreimageDigest), summary: 'The exact preimage bytes were restored.' };
  }

  async function verifyUndo(entry) {
    const def = exactDefinition(entry?.resourceIdentity?.id);
    if (!def) return { ok: false, sourceFingerprint: null };
    const current = currentDigest(def.projectRoot, def.targetRelativePath, fsImpl);
    const fingerprint = current.status === 'present' && current.digest === def.expectedPreimageDigest
      ? preimageFingerprint(def, current.digest) : null;
    return { ok: Boolean(fingerprint) && fingerprint === entry?.sourceFingerprint, sourceFingerprint: fingerprint };
  }

  return {
    id: PROVIDER_ID, version: PROVIDER_VERSION, resourceKinds: ['project-file'],
    operations: ['apply-project-patch'], rollback: ['reversible'],
    detect, actionFor, preflight, apply, verify, inspectCurrent, undo, verifyUndo,
  };
}
