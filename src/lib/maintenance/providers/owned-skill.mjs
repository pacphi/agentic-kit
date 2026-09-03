import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { baseAction, executableSafetyClass, providerFinding, sha256 } from './shared.mjs';

const SCHEMA = 'agentic-kit.skill-tree-ownership/v1';
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:._@-]{1,255}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 2_048;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const CURRENT_UID = typeof process.getuid === 'function' ? process.getuid() : null;

const ownerMatches = (stat) => Number.isInteger(CURRENT_UID) && CURRENT_UID >= 0
  && Number.isInteger(stat?.uid) && stat.uid === CURRENT_UID;

const resolved = (value) => (typeof value === 'string' && path.isAbsolute(value)
  ? path.resolve(value) : null);

function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function overlaps(left, right) {
  return left === right || contained(left, right) || contained(right, left);
}

function entryPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return null;
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) return null;
  if (value.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return value;
}

function normalizedEntry(entry) {
  const relative = entryPath(entry?.path);
  const mode = Number.isInteger(entry?.mode) && entry.mode >= 0 && entry.mode <= 0o777
    ? entry.mode : null;
  if (!relative || mode === null || !['file', 'directory'].includes(entry?.kind)) return null;
  if (entry.kind === 'directory') return { path: relative, kind: 'directory', mode };
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES
      || !DIGEST.test(entry.digest ?? '')) return null;
  return { path: relative, kind: 'file', mode, size: entry.size, digest: entry.digest };
}

function manifestFrom(raw, resourceId) {
  if (raw.manifest?.complete !== true || !Array.isArray(raw.manifest.entries)
      || raw.manifest.entries.length === 0 || raw.manifest.entries.length > MAX_ENTRIES) {
    return { ok: false, resourceId, reason: 'complete-tree-manifest-required' };
  }
  const entries = raw.manifest.entries.map(normalizedEntry);
  if (entries.some((entry) => !entry)) {
    return { ok: false, resourceId, reason: 'invalid-tree-manifest' };
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const unique = new Set(entries.map((entry) => entry.path)).size === entries.length;
  const hasEntrypoint = entries.some((entry) => entry.path === 'SKILL.md' && entry.kind === 'file');
  if (!unique || !hasEntrypoint || raw.manifest.digest !== sha256(entries)) {
    return { ok: false, resourceId, reason: 'invalid-tree-manifest' };
  }
  return { ok: true, manifest: { complete: true, entries, digest: raw.manifest.digest } };
}

function validReceiptIdentity(raw, resourceId) {
  return RECEIPT_ID.test(raw?.id ?? '')
    && raw.owner === 'agentic-kit'
    && resourceId
    && ['user', 'project'].includes(raw.scope)
    && ['standalone', 'projected'].includes(raw.sourceKind)
    && raw.desired === false;
}

function structuralReceipt(raw, allowedRoots, pluginCacheRoots) {
  const resourceId = RESOURCE_ID.test(raw?.resourceId ?? '') ? raw.resourceId : null;
  if (raw?.schemaVersion !== SCHEMA) {
    return { ok: false, resourceId, reason: 'complete-tree-manifest-required' };
  }
  if (!validReceiptIdentity(raw, resourceId)) {
    return { ok: false, resourceId, reason: 'invalid-ownership-receipt' };
  }
  const root = resolved(raw.root);
  const allowedRoot = resolved(raw.allowedRoot);
  if (!root || !allowedRoot || !allowedRoots.includes(allowedRoot)
      || path.dirname(root) !== allowedRoot) {
    return { ok: false, resourceId, reason: 'target-outside-exact-allowed-root' };
  }
  if (pluginCacheRoots.some((pluginRoot) => root === pluginRoot || contained(pluginRoot, root))) {
    return { ok: false, resourceId, reason: 'plugin-cache-target-forbidden' };
  }
  const normalizedManifest = manifestFrom(raw, resourceId);
  if (!normalizedManifest.ok) return normalizedManifest;
  return {
    ok: true, resourceId,
    value: {
      id: raw.id, resourceId, scope: raw.scope, sourceKind: raw.sourceKind,
      root, allowedRoot, manifest: normalizedManifest.manifest,
    },
  };
}

function fileDigest(file, fsImpl) {
  return createHash('sha256').update(fsImpl.readFileSync(file)).digest('hex');
}

function scanTree(root, fsImpl) {
  const entries = [];
  let count = 0;
  function visit(dir, prefix = '') {
    const children = fsImpl.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      count += 1;
      if (count > MAX_ENTRIES) throw new Error('tree-entry-limit');
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const target = path.join(dir, child.name);
      const stat = fsImpl.lstatSync(target);
      if (!ownerMatches(stat)) throw new Error('tree-owner-mismatch');
      if (stat.isSymbolicLink()) throw new Error('tree-contains-symlink');
      if (stat.isDirectory()) {
        entries.push({ path: relative, kind: 'directory', mode: stat.mode & 0o777 });
        visit(target, relative);
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) throw new Error('tree-file-size-limit');
        entries.push({
          path: relative, kind: 'file', mode: stat.mode & 0o777,
          size: stat.size, digest: fileDigest(target, fsImpl),
        });
      } else {
        throw new Error('tree-contains-special-file');
      }
    }
  }
  visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function safeDirectory(target, fsImpl) {
  try {
    const stat = fsImpl.lstatSync(target);
    if (stat.isSymbolicLink()) return { ok: false, reason: 'target-is-symlink' };
    if (!stat.isDirectory()) return { ok: false, reason: 'target-is-not-directory' };
    if (!ownerMatches(stat)) return { ok: false, reason: 'target-owner-mismatch' };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'absent' : 'unreadable-tree' };
  }
}

function validateAllowedRoot(receipt, fsImpl) {
  const safe = safeDirectory(receipt.allowedRoot, fsImpl);
  if (!safe.ok) return { ok: false, reason: 'allowed-root-unsafe-or-unreadable' };
  try {
    const actualRoot = fsImpl.realpathSync(receipt.allowedRoot);
    if (path.dirname(receipt.root) !== receipt.allowedRoot) {
      return { ok: false, reason: 'target-outside-exact-allowed-root' };
    }
    return { ok: true, actualRoot };
  } catch {
    return { ok: false, reason: 'allowed-root-unsafe-or-unreadable' };
  }
}

function compareManifest(receipt, target, fsImpl, { source = true } = {}) {
  const safe = safeDirectory(target, fsImpl);
  if (!safe.ok) return safe;
  try {
    if (source) {
      const rootCheck = validateAllowedRoot(receipt, fsImpl);
      if (!rootCheck.ok) return rootCheck;
      const actualTarget = fsImpl.realpathSync(target);
      if (path.dirname(actualTarget) !== rootCheck.actualRoot) {
        return { ok: false, reason: 'target-outside-exact-allowed-root' };
      }
    }
    const actual = scanTree(target, fsImpl);
    const actualShape = actual.map(({ path: relative, kind }) => ({ path: relative, kind }));
    const expectedShape = receipt.manifest.entries
      .map(({ path: relative, kind }) => ({ path: relative, kind }));
    if (sha256(actualShape) !== sha256(expectedShape)) {
      return { ok: false, reason: 'manifest-shape-drift' };
    }
    if (sha256(actual) !== receipt.manifest.digest) {
      return { ok: false, reason: 'manifest-content-drift' };
    }
    return { ok: true, fingerprint: sourceFingerprint(receipt) };
  } catch (error) {
    const reason = String(error?.message ?? '').startsWith('tree-')
      ? error.message : 'unreadable-tree';
    return { ok: false, reason };
  }
}

const sourceFingerprint = (receipt) => sha256({
  receiptId: receipt.id,
  resourceId: receipt.resourceId,
  allowedRoot: receipt.allowedRoot,
  root: receipt.root,
  manifestDigest: receipt.manifest.digest,
});

const archiveKey = (receipt) => `skill-${sha256({
  resourceId: receipt.resourceId, manifestDigest: receipt.manifest.digest,
}).slice(0, 32)}`;

const postFingerprint = (receipt, operation) => sha256({
  resourceId: receipt.resourceId,
  manifestDigest: receipt.manifest.digest,
  state: operation === 'archive' ? 'archived' : 'absent',
});

function inspectReceipt(receipt, archiveRoot, fsImpl) {
  const current = compareManifest(receipt, receipt.root, fsImpl);
  if (current.ok) return { status: 'owned-current', executable: true, sourceFingerprint: current.fingerprint };
  if (current.reason === 'target-is-symlink') return { status: 'unsafe', executable: false, reason: current.reason };
  if (current.reason !== 'absent') {
    return { status: 'modified-or-shape-drift', executable: false, reason: current.reason };
  }
  const archived = compareManifest(
    receipt, path.join(archiveRoot, archiveKey(receipt)), fsImpl, { source: false },
  );
  if (archived.ok) {
    return {
      status: 'archived', executable: false, sourceFingerprint: sourceFingerprint(receipt),
      postFingerprint: postFingerprint(receipt, 'archive'),
    };
  }
  if (archived.reason === 'absent') return { status: 'absent', executable: false, reason: 'source-absent' };
  return { status: 'archive-drift', executable: false, reason: archived.reason };
}

function ensureArchiveRoot(archiveRoot, allowedRoots, pluginCacheRoots, fsImpl) {
  if (allowedRoots.concat(pluginCacheRoots).some((root) => overlaps(root, archiveRoot))) {
    throw new Error('maintenance archive overlaps a managed or plugin capability root');
  }
  fsImpl.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  const safe = safeDirectory(archiveRoot, fsImpl);
  if (!safe.ok) throw new Error('maintenance archive root is unsafe');
  const stat = fsImpl.lstatSync(archiveRoot);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('maintenance archive root is not private');
  }
}

function actionRequest(finding) {
  const resource = finding?.resource ?? finding?.resourceIdentity;
  const operation = finding?.nextAction?.operation;
  const eligible = resource?.kind === 'skill'
    && ['user', 'project'].includes(resource.scope)
    && RESOURCE_ID.test(resource.id ?? '')
    && ['archive', 'prune'].includes(operation)
    && finding?.ownership?.authority === 'agentic-kit-receipt'
    && finding?.ownership?.managed === true
    && executableSafetyClass(finding?.safetyClass);
  return eligible ? { resource, operation } : null;
}

/** @param {any} options */
export function createOwnedSkillProvider({
  receipts = [], allowedRoots = [], pluginCacheRoots = [], archiveRoot, fsImpl = fs,
} = {}) {
  const roots = allowedRoots.map(resolved);
  const pluginRoots = pluginCacheRoots.map(resolved);
  const archive = resolved(archiveRoot);
  const broad = (root) => root && path.dirname(root) === root;
  if (!archive || broad(archive) || roots.some((root) => !root || broad(root))
      || pluginRoots.some((root) => !root || broad(root))
      || roots.concat(pluginRoots).some((root) => overlaps(root, archive))) {
    throw new TypeError('owned skill provider requires absolute bounded roots');
  }

  function receiptInventory() {
    const limitations = [];
    const grouped = new Map();
    for (const raw of Array.isArray(receipts) ? receipts : []) {
      const result = structuralReceipt(raw, roots, pluginRoots);
      if (!result.resourceId) {
        limitations.push({ receiptId: RECEIPT_ID.test(raw?.id ?? '') ? raw.id : null, reason: result.reason });
        continue;
      }
      const values = grouped.get(result.resourceId) ?? [];
      values.push(result);
      grouped.set(result.resourceId, values);
    }
    return { limitations, grouped };
  }

  function exactReceipt(resourceId) {
    const values = receiptInventory().grouped.get(resourceId) ?? [];
    return values.length === 1 && values[0].ok ? values[0].value : null;
  }

  async function detect() {
    const { limitations, grouped } = receiptInventory();
    const skills = [];
    for (const [resourceId, values] of grouped) {
      if (values.length !== 1) {
        skills.push({ resourceId, status: 'ambiguous', executable: false, reason: 'ambiguous-ownership-receipts' });
        continue;
      }
      if (!values[0].ok) {
        skills.push({ resourceId, status: 'unsupported', executable: false, reason: values[0].reason });
        continue;
      }
      skills.push({ resourceId, scope: values[0].value.scope,
        ...inspectReceipt(values[0].value, archive, fsImpl) });
    }
    return {
      status: 'available', complete: limitations.length === 0,
      authority: 'agentic-kit-receipt', asOf: new Date().toISOString(),
      skills, receiptLimitations: limitations,
    };
  }

  function findings(facts) {
    const rows = (facts?.skills ?? []).map((skill) => {
      const owned = facts?.status === 'available' && facts.complete === true
        && skill.status === 'owned-current' && skill.executable === true;
      return providerFinding({
        providerId: 'agentic-kit-owned-skill', stableKey: skill.resourceId,
        state: owned ? 'stale-configuration'
          : (skill.status === 'modified-or-shape-drift' ? 'modified' : 'ambiguous'),
        bucket: 'needsReview',
        classification: owned ? 'complete-tree-receipt-owned'
          : `owned-skill-${skill.status ?? 'unavailable'}`,
        safetyClass: owned ? 'approval-required' : 'never-automatic',
        resource: {
          id: skill.resourceId, kind: 'skill', name: skill.resourceId,
          host: 'agentic-kit', scope: skill.scope ?? 'unknown',
        },
        versions: {},
        ownership: { owner: 'agentic-kit', authority: 'agentic-kit-receipt', managed: owned },
        evidence: { sources: ['agentic-kit-complete-tree-receipt'], asOf: facts.asOf,
          freshness: 'fresh', completeness: owned ? 'complete' : 'partial',
          gaps: owned ? [] : ['Ownership or complete-tree postimage is not exact.'] },
        impact: { summary: owned
          ? 'The exact unchanged skill tree can be archived and restored.'
          : 'The skill tree is preserved because exact ownership is not proven.' },
        operation: owned ? 'archive' : 'review',
        label: owned ? 'Archive exact receipt-owned skill tree' : 'Review ownership evidence',
        rollback: owned ? 'reversible' : 'irreversible', restart: 'required', executable: owned,
      });
    });
    if ((facts?.receiptLimitations ?? []).length) {
      rows.push(providerFinding({
        providerId: 'agentic-kit-owned-skill', stableKey: 'legacy-or-partial-receipts',
        state: 'unreadable-partial', bucket: 'needsReview',
        classification: 'legacy-skill-receipt-report-only', safetyClass: 'never-automatic',
        resource: { id: 'skill:ownership-receipt-limitations', kind: 'skill',
          name: 'Legacy or partial skill ownership receipts', host: 'agentic-kit', scope: 'machine' },
        versions: {}, ownership: { owner: 'agentic-kit', authority: 'legacy-receipt', managed: false },
        evidence: { sources: ['agentic-kit-legacy-receipt'], asOf: facts.asOf,
          freshness: 'fresh', completeness: 'partial', gaps: ['Complete-tree ownership is not proven.'] },
        impact: { summary: 'Legacy entrypoint-only receipts remain report-only and are preserved.' },
        operation: 'review', label: 'Review and migrate ownership evidence',
        rollback: 'irreversible', restart: 'not-required', executable: false,
      }));
    }
    return rows;
  }

  function actionFor(finding, facts) {
    const request = actionRequest(finding);
    if (!request) return null;
    const fact = facts?.skills?.find((row) => row.resourceId === request.resource.id);
    const receipt = exactReceipt(request.resource.id);
    if (!receipt || fact?.status !== 'owned-current' || fact.executable !== true
        || fact.sourceFingerprint !== sourceFingerprint(receipt)) return null;
    return baseAction(finding, {
      providerId: 'agentic-kit-owned-skill', providerVersion: 'v1', operation: request.operation,
      sourceFingerprint: fact.sourceFingerprint,
      rollback: request.operation === 'archive' ? 'reversible' : 'irreversible',
      restart: 'required',
    });
  }

  async function preflight(action) {
    const receipt = exactReceipt(action?.resourceIdentity?.id);
    if (!receipt || !['archive', 'prune'].includes(action?.operation)) {
      return { ok: false, sourceFingerprint: null };
    }
    const current = inspectReceipt(receipt, archive, fsImpl);
    return {
      ok: current.status === 'owned-current' && current.sourceFingerprint === action.sourceFingerprint,
      sourceFingerprint: current.sourceFingerprint ?? null,
    };
  }

  async function apply(action) {
    const receipt = exactReceipt(action?.resourceIdentity?.id);
    if (!receipt || !['archive', 'prune'].includes(action?.operation)) {
      return { status: 'refused', summary: 'The ownership receipt or operation is invalid.' };
    }
    const current = inspectReceipt(receipt, archive, fsImpl);
    const expectedPost = postFingerprint(receipt, action.operation);
    if (action.operation === 'archive' && current.status === 'archived') {
      return { status: 'unchanged', postFingerprint: expectedPost, summary: 'The exact tree is already archived.' };
    }
    if (action.operation === 'prune' && current.status === 'absent') {
      return { status: 'unchanged', postFingerprint: expectedPost, summary: 'The exact tree is already absent.' };
    }
    if (current.status !== 'owned-current' || current.sourceFingerprint !== action.sourceFingerprint) {
      return { status: 'refused', summary: 'Current tree no longer matches its complete ownership receipt.' };
    }
    try {
      if (action.operation === 'archive') {
        ensureArchiveRoot(archive, roots, pluginRoots, fsImpl);
        const destination = path.join(archive, archiveKey(receipt));
        const archiveState = safeDirectory(destination, fsImpl);
        if (archiveState.reason !== 'absent') {
          return { status: 'refused', summary: 'The archive destination is not empty.' };
        }
        fsImpl.renameSync(receipt.root, destination);
      } else {
        fsImpl.rmSync(receipt.root, { recursive: true, force: false });
      }
      return {
        status: 'applied', postFingerprint: expectedPost,
        summary: action.operation === 'archive'
          ? 'Receipt-owned skill tree archived.' : 'Receipt-owned skill tree pruned.',
      };
    } catch {
      return { status: 'unknown', summary: 'Filesystem outcome could not be proven; inspect current state.' };
    }
  }

  async function verify(action, outcome) {
    const receipt = exactReceipt(action?.resourceIdentity?.id);
    if (!receipt) return { ok: false, postFingerprint: null };
    const state = inspectReceipt(receipt, archive, fsImpl);
    const expected = postFingerprint(receipt, action.operation);
    const ok = action.operation === 'archive' ? state.status === 'archived' : state.status === 'absent';
    return { ok: ok && outcome?.postFingerprint === expected, postFingerprint: ok ? expected : null };
  }

  async function inspectPostimage(entry) {
    const receipt = exactReceipt(entry?.resourceIdentity?.id);
    if (!receipt || entry?.operation !== 'archive') return { postFingerprint: null };
    const state = inspectReceipt(receipt, archive, fsImpl);
    return { postFingerprint: state.status === 'archived' ? postFingerprint(receipt, 'archive') : null };
  }

  const inspectCurrent = inspectPostimage;

  async function undo(entry) {
    const receipt = exactReceipt(entry?.resourceIdentity?.id);
    if (!receipt || entry?.operation !== 'archive') {
      return { status: 'refused', summary: 'Only exact archived skill trees are reversible.' };
    }
    const state = inspectReceipt(receipt, archive, fsImpl);
    const expectedPost = postFingerprint(receipt, 'archive');
    if (state.status !== 'archived' || entry?.outcome?.postFingerprint !== expectedPost) {
      return { status: 'refused', summary: 'Archive or source postimage drifted; restoration was preserved.' };
    }
    try {
      fsImpl.renameSync(path.join(archive, archiveKey(receipt)), receipt.root);
      return {
        status: 'restored', sourceFingerprint: sourceFingerprint(receipt),
        summary: 'Receipt-owned skill tree restored.',
      };
    } catch {
      return { status: 'unknown', summary: 'Restore outcome could not be proven; inspect current state.' };
    }
  }

  async function verifyUndo(entry) {
    const receipt = exactReceipt(entry?.resourceIdentity?.id);
    if (!receipt) return { ok: false, sourceFingerprint: null };
    const state = inspectReceipt(receipt, archive, fsImpl);
    const fingerprint = sourceFingerprint(receipt);
    return {
      ok: state.status === 'owned-current' && !fsImpl.existsSync(path.join(archive, archiveKey(receipt)))
        && entry?.sourceFingerprint === fingerprint,
      sourceFingerprint: state.status === 'owned-current' ? fingerprint : null,
    };
  }

  return {
    id: 'agentic-kit-owned-skill', version: 'v1', authority: 'agentic-kit-receipt', resourceKinds: ['skill'],
    operations: ['archive', 'prune'], rollback: ['reversible', 'irreversible'],
    detect, findings, actionFor, preflight, apply, verify,
    inspectPostimage, inspectCurrent, undo, verifyUndo,
  };
}
