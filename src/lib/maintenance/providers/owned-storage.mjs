import fs from 'node:fs';
import path from 'node:path';

import { scanNpxStale } from '../../npx.mjs';
import { baseAction, executableSafetyClass, sha256 } from './shared.mjs';

const CANDIDATE_ID = /^stale-npx-env:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const CURRENT_UID = typeof process.getuid === 'function' ? process.getuid() : null;

const ownerMatches = (stat) => !Number.isInteger(CURRENT_UID)
  || !Number.isInteger(stat?.uid) || stat.uid === CURRENT_UID;

function safeRoot(root, fsImpl) {
  try {
    const stat = fsImpl.lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink() && ownerMatches(stat);
  } catch {
    return false;
  }
}

function targetState(target, root, fsImpl) {
  try {
    const stat = fsImpl.lstatSync(target);
    if (stat.isSymbolicLink()) return { status: 'unsafe', reason: 'target-is-symlink' };
    if (!stat.isDirectory()) return { status: 'unsafe', reason: 'target-is-not-directory' };
    if (!ownerMatches(stat)) return { status: 'unsafe', reason: 'target-owner-mismatch' };
    const actualRoot = fsImpl.realpathSync(root);
    const actualTarget = fsImpl.realpathSync(target);
    if (path.dirname(actualTarget) !== actualRoot) {
      return { status: 'unsafe', reason: 'target-outside-exact-cache-root' };
    }
    return { status: 'present' };
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { status: 'absent' }
      : { status: 'unknown', reason: 'target-unreadable' };
  }
}

function candidateDefinition(candidate, root) {
  const match = String(candidate?.id ?? '').match(CANDIDATE_ID);
  const target = typeof candidate?.path === 'string' && path.isAbsolute(candidate.path)
    ? path.resolve(candidate.path) : null;
  const exact = match && target === path.join(root, match[1]);
  const measured = candidate?.bytes?.status === 'measured'
    && candidate.bytes.partial !== true
    && candidate?.files?.status === 'measured'
    && candidate.files.partial !== true;
  if (!match || candidate?.kind !== 'stale-npx-env' || candidate?.safety !== 'regenerable'
      || candidate?.advisory !== true) {
    return { ok: false, resourceId: candidate?.id ?? null, reason: 'unsupported-storage-candidate' };
  }
  if (!exact) return { ok: false, resourceId: candidate.id, reason: 'target-outside-exact-cache-root' };
  if (!measured) return { ok: false, resourceId: candidate.id, reason: 'incomplete-collector-evidence' };
  return { ok: true, resourceId: candidate.id, leaf: match[1], target };
}

function staleFingerprint(resourceId, stale) {
  const versions = (stale ?? []).map((entry) => ({
    package: entry.pkg, cached: entry.cached, installed: entry.installed,
  })).sort((a, b) => a.package.localeCompare(b.package));
  return sha256({ procedure: 'agentic-kit-npx-stale-prune/v1', resourceId, versions });
}

const absentFingerprint = (resourceId) => sha256({
  procedure: 'agentic-kit-npx-stale-prune/v1', resourceId, state: 'absent',
});

function actionRequest(finding) {
  const resource = finding?.resource ?? finding?.resourceIdentity;
  const eligible = resource?.kind === 'stale-npx-env'
    && CANDIDATE_ID.test(resource.id ?? '')
    && finding?.nextAction?.operation === 'clean'
    && finding?.ownership?.authority === 'agentic-kit-procedure'
    && finding?.ownership?.managed === true
    && executableSafetyClass(finding?.safetyClass);
  return eligible ? resource : null;
}

export function createOwnedNpxCacheProvider({
  candidates = [], root, baseline, fsImpl = fs, scan = scanNpxStale,
} = {}) {
  const cacheRoot = typeof root === 'string' && path.isAbsolute(root) ? path.resolve(root) : null;
  if (!cacheRoot || path.dirname(cacheRoot) === cacheRoot
      || typeof baseline !== 'function' || typeof scan !== 'function') {
    throw new TypeError('owned npx provider requires an absolute root and baseline');
  }

  const definitions = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const definition = candidateDefinition(candidate, cacheRoot);
    const rows = definitions.get(definition.resourceId) ?? [];
    rows.push(definition);
    definitions.set(definition.resourceId, rows);
  }

  function exactDefinition(resourceId) {
    const rows = definitions.get(resourceId) ?? [];
    return rows.length === 1 && rows[0].ok ? rows[0] : null;
  }

  function inspect(definition) {
    if (!safeRoot(cacheRoot, fsImpl)) {
      return { status: 'unsupported', executable: false, reason: 'cache-root-unsafe-or-unreadable' };
    }
    const state = targetState(definition.target, cacheRoot, fsImpl);
    if (state.status === 'absent') return { status: 'absent', executable: false };
    if (state.status !== 'present') return { ...state, executable: false };
    let stale;
    try {
      stale = scan({ root: cacheRoot, baseline })
        .find((entry) => path.resolve(entry.dir) === definition.target)?.stale ?? null;
    } catch {
      return { status: 'unsupported', executable: false, reason: 'owned-procedure-scan-failed' };
    }
    if (!Array.isArray(stale) || stale.length === 0) {
      return { status: 'not-currently-stale', executable: false, reason: 'no-current-owned-procedure-match' };
    }
    return {
      status: 'owned-procedure-current', executable: true,
      sourceFingerprint: staleFingerprint(definition.resourceId, stale),
    };
  }

  async function detect() {
    const facts = [];
    for (const [resourceId, rows] of definitions) {
      if (rows.length !== 1) {
        facts.push({ resourceId, status: 'ambiguous', executable: false, reason: 'ambiguous-storage-candidates' });
      } else if (!rows[0].ok) {
        facts.push({ resourceId, status: 'unsupported', executable: false, reason: rows[0].reason });
      } else {
        facts.push({ resourceId, ...inspect(rows[0]) });
      }
    }
    return {
      status: 'available', complete: facts.every((fact) => fact.status !== 'unsupported'),
      authority: 'agentic-kit-procedure', candidates: facts,
    };
  }

  function actionFor(finding, facts) {
    const resource = actionRequest(finding);
    if (!resource) return null;
    const definition = exactDefinition(resource.id);
    const fact = facts?.candidates?.find((row) => row.resourceId === resource.id);
    if (!definition || fact?.status !== 'owned-procedure-current' || fact.executable !== true) return null;
    return baseAction(finding, {
      providerId: 'agentic-kit-npx-cache', providerVersion: 'v1', operation: 'clean',
      sourceFingerprint: fact.sourceFingerprint, rollback: 'irreversible', restart: 'not-required',
    });
  }

  async function preflight(action) {
    const definition = exactDefinition(action?.resourceIdentity?.id);
    if (!definition || action?.operation !== 'clean') return { ok: false, sourceFingerprint: null };
    const current = inspect(definition);
    return {
      ok: current.status === 'owned-procedure-current'
        && current.sourceFingerprint === action.sourceFingerprint,
      sourceFingerprint: current.sourceFingerprint ?? null,
    };
  }

  async function apply(action) {
    const definition = exactDefinition(action?.resourceIdentity?.id);
    if (!definition || action?.operation !== 'clean') {
      return { status: 'refused', summary: 'Storage procedure identity is invalid.' };
    }
    const current = inspect(definition);
    const postFingerprint = absentFingerprint(definition.resourceId);
    if (current.status === 'absent') {
      return { status: 'unchanged', postFingerprint, summary: 'The exact cache environment is already absent.' };
    }
    if (current.status !== 'owned-procedure-current'
        || current.sourceFingerprint !== action.sourceFingerprint) {
      return { status: 'refused', summary: 'The cache no longer matches the bounded stale-env procedure.' };
    }
    try {
      fsImpl.rmSync(definition.target, { recursive: true, force: false });
      return {
        status: 'applied', postFingerprint,
        summary: 'Exact stale npx environment removed; npx can reproduce it on demand.',
      };
    } catch {
      return { status: 'unknown', summary: 'Cache cleanup outcome could not be proven.' };
    }
  }

  async function verify(action, outcome) {
    const definition = exactDefinition(action?.resourceIdentity?.id);
    if (!definition) return { ok: false, postFingerprint: null };
    const state = targetState(definition.target, cacheRoot, fsImpl);
    const expected = absentFingerprint(definition.resourceId);
    return {
      ok: state.status === 'absent' && outcome?.postFingerprint === expected,
      postFingerprint: state.status === 'absent' ? expected : null,
    };
  }

  return {
    id: 'agentic-kit-npx-cache', version: 'v1', resourceKinds: ['stale-npx-env'],
    operations: ['clean'], rollback: ['irreversible'],
    detect, actionFor, preflight, apply, verify,
  };
}
