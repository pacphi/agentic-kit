import fs from 'node:fs';
import path from 'node:path';

import { scanNpxStale } from '../../npx.mjs';
import { baseAction, executableSafetyClass, providerFinding, sha256 } from './shared.mjs';

const CANDIDATE_ID = /^stale-npx-env:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
function ownerMatches(stat, currentUid) {
  return Number.isInteger(currentUid) && currentUid >= 0
    && Number.isInteger(stat?.uid) && stat.uid === currentUid;
}

function safeRoot(root, fsImpl, currentUid) {
  try {
    const stat = fsImpl.lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink() && ownerMatches(stat, currentUid);
  } catch {
    return false;
  }
}

function targetState(target, root, fsImpl, currentUid) {
  try {
    const stat = fsImpl.lstatSync(target);
    if (stat.isSymbolicLink()) return { status: 'unsafe', reason: 'target-is-symlink' };
    if (!stat.isDirectory()) return { status: 'unsafe', reason: 'target-is-not-directory' };
    if (!ownerMatches(stat, currentUid)) return { status: 'unsafe', reason: 'target-owner-mismatch' };
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

/** @param {any} options */
export function createOwnedNpxCacheProvider({
  candidates = [], root, baseline, fsImpl = fs, scan = scanNpxStale,
  currentUid = typeof process.getuid === 'function' ? process.getuid() : null,
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
    if (!safeRoot(cacheRoot, fsImpl, currentUid)) {
      return { status: 'unsupported', executable: false, reason: 'cache-root-unsafe-or-unreadable' };
    }
    const state = targetState(definition.target, cacheRoot, fsImpl, currentUid);
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
      authority: 'agentic-kit-procedure', asOf: new Date().toISOString(), candidates: facts,
    };
  }

  /** @param {any} facts @param {any} context */
  function findings(facts, context = {}) {
    const { baseFindings } = context;
    if (facts?.status !== 'available' || facts.complete !== true) return [];
    return (facts?.candidates ?? []).flatMap((fact) => {
      if (fact.status !== 'owned-procedure-current' || fact.executable !== true) return [];
      const base = (baseFindings ?? []).find((row) => row?.resource?.id === fact.resourceId);
      if (!base) return [];
      return [providerFinding({
        providerId: 'agentic-kit-npx-cache', stableKey: fact.resourceId,
        state: 'orphaned-cache', bucket: 'safeCleanup',
        classification: 'version-stale-owned-npx-environment', safetyClass: 'safe-automatic',
        resource: base.resource,
        versions: base.versions,
        ownership: { owner: 'agentic-kit', authority: 'agentic-kit-procedure', managed: true },
        evidence: { sources: ['system-footprint', 'agentic-kit-npx-stale-procedure'],
          asOf: facts.asOf, freshness: 'fresh', completeness: 'complete', gaps: [] },
        impact: base.impact,
        operation: 'clean', label: 'Remove exact reproducible stale npx environment',
        rollback: 'irreversible', restart: 'not-required', executable: true,
      })];
    });
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
    const state = targetState(definition.target, cacheRoot, fsImpl, currentUid);
    const expected = absentFingerprint(definition.resourceId);
    return {
      ok: state.status === 'absent' && outcome?.postFingerprint === expected,
      postFingerprint: state.status === 'absent' ? expected : null,
    };
  }

  async function inspectCurrent(entry) {
    const definition = exactDefinition(entry?.resourceIdentity?.id);
    if (!definition || entry?.operation !== 'clean') return { complete: false, postFingerprint: null };
    const current = inspect(definition);
    if (current.status === 'owned-procedure-current') {
      return { complete: true, postFingerprint: current.sourceFingerprint };
    }
    if (current.status === 'absent') {
      return { complete: true, postFingerprint: absentFingerprint(definition.resourceId) };
    }
    return { complete: false, postFingerprint: null };
  }

  return {
    id: 'agentic-kit-npx-cache', version: 'v1', authority: 'agentic-kit-procedure',
    resourceKinds: ['stale-npx-env'],
    operations: ['clean'], rollback: ['irreversible'],
    detect, findings, actionFor, preflight, apply, verify, inspectCurrent,
  };
}
