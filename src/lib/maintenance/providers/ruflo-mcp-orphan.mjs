import {
  listMcpTransports, orphanedMcpTransports, reapMcpTransports,
} from '../../daemons.mjs';
import { baseAction, executableSafetyClass, providerFinding, sha256 } from './shared.mjs';

const RESOURCE_ID = /^ruflo-mcp-orphan:(\d{1,10})$/;

const identityFingerprint = (row) => sha256({
  uid: row.uid, pid: row.pid, ppid: row.ppid, command: row.command,
});

const absentFingerprint = (pid) => sha256({
  provider: 'ruflo-mcp-orphan/v1', pid, state: 'absent',
});

function pidFrom(value) {
  const match = String(value ?? '').match(RESOURCE_ID);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function actionRequest(finding) {
  const resource = finding?.resource ?? finding?.resourceIdentity;
  const pid = pidFrom(resource?.id);
  const eligible = pid
    && resource?.kind === 'daemon'
    && resource.host === 'ruflo'
    && finding?.nextAction?.operation === 'terminate'
    && finding?.ownership?.authority === 'live-process-identity'
    && finding?.ownership?.managed === true
    && executableSafetyClass(finding?.safetyClass);
  return eligible ? { resource, pid } : null;
}

export function createRufloMcpOrphanProvider({
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  list = listMcpTransports,
  classify = orphanedMcpTransports,
  reap = reapMcpTransports,
} = {}) {
  async function rows() {
    const value = await list();
    if (!Array.isArray(value)) throw new Error('process census returned an invalid shape');
    return value;
  }

  async function detect() {
    if (!Number.isInteger(uid) || uid < 0) {
      return {
        status: 'unsupported', complete: false, authority: 'live-process-identity',
        capability: { status: 'unsupported', reason: 'current-user-identity-unavailable' },
        orphans: [],
      };
    }
    try {
      const live = await rows();
      const orphans = classify(live, { uid }).map((row) => ({
        resourceId: `ruflo-mcp-orphan:${row.pid}`,
        pid: row.pid,
        sourceFingerprint: identityFingerprint(row),
        executable: true,
      }));
      return {
        status: 'available', complete: true, authority: 'live-process-identity',
        asOf: new Date().toISOString(), capability: { status: 'available', reason: null }, orphans,
      };
    } catch {
      return {
        status: 'unavailable', complete: false, authority: 'live-process-identity',
        capability: { status: 'unsupported', reason: 'live-process-census-unavailable' },
        orphans: [],
      };
    }
  }

  function findings(facts) {
    if (facts?.status !== 'available' || facts.complete !== true
        || facts.capability?.status !== 'available') return [];
    return facts.orphans.map((orphan) => providerFinding({
      providerId: 'ruflo-mcp-orphan', stableKey: orphan.resourceId,
      state: 'stale-configuration', bucket: 'needsReview',
      classification: 'identity-proven-ruflo-mcp-orphan', safetyClass: 'approval-required',
      resource: {
        id: orphan.resourceId, kind: 'daemon', name: `Ruflo MCP transport ${orphan.pid}`,
        host: 'ruflo', scope: 'machine',
      },
      versions: {},
      ownership: { owner: 'ruflo', authority: 'live-process-identity', managed: true },
      evidence: { sources: ['ruflo-live-process-census'], asOf: facts.asOf,
        freshness: 'fresh', completeness: 'complete', gaps: [] },
      impact: { summary: 'An identity-proven orphaned MCP transport remains live.' },
      operation: 'terminate', label: `Stop Ruflo MCP transport ${orphan.pid}`,
      rollback: 'irreversible', restart: 'not-required', executable: true,
    }));
  }

  function actionFor(finding, facts) {
    const request = actionRequest(finding);
    if (!request || facts?.capability?.status !== 'available') return null;
    const fact = facts.orphans?.find((row) => row.resourceId === request.resource.id);
    if (!fact?.executable) return null;
    return baseAction(finding, {
      providerId: 'ruflo-mcp-orphan', providerVersion: 'v1', operation: 'terminate',
      sourceFingerprint: fact.sourceFingerprint, rollback: 'irreversible', restart: 'not-required',
    });
  }

  async function liveIdentity(action) {
    const pid = pidFrom(action?.resourceIdentity?.id);
    if (!pid || !Number.isInteger(uid) || uid < 0) return { status: 'unsupported', pid };
    let live;
    try { live = await rows(); } catch { return { status: 'unknown', pid }; }
    const samePid = live.find((row) => row?.pid === pid);
    if (!samePid) return { status: 'absent', pid };
    let orphan;
    try { [orphan] = classify([samePid], { uid }); } catch {
      return { status: 'unknown', pid };
    }
    if (!orphan) return { status: 'identity-drift', pid, row: samePid };
    return {
      status: 'orphan', pid, row: orphan,
      sourceFingerprint: identityFingerprint(orphan),
    };
  }

  async function preflight(action) {
    const current = await liveIdentity(action);
    return {
      ok: current.status === 'orphan' && current.sourceFingerprint === action?.sourceFingerprint,
      sourceFingerprint: current.sourceFingerprint ?? null,
    };
  }

  async function apply(action) {
    if (action?.operation !== 'terminate') {
      return { status: 'refused', summary: 'Process operation is invalid.' };
    }
    const current = await liveIdentity(action);
    const postFingerprint = absentFingerprint(current.pid);
    if (current.status === 'absent') {
      return { status: 'unchanged', postFingerprint, summary: 'The exact process is already absent.' };
    }
    if (current.status !== 'orphan' || current.sourceFingerprint !== action.sourceFingerprint) {
      return { status: 'refused', summary: 'Live process owner or identity changed; no signal was sent.' };
    }
    let results;
    try { results = await reap([current.row], { uid }); } catch {
      return { status: 'unknown', summary: 'Termination dispatch outcome is unknown.' };
    }
    const result = Array.isArray(results) && results.find((row) => row?.pid === current.pid);
    if (!result?.killed) {
      return {
        status: result?.identityChanged ? 'refused' : 'unknown',
        summary: result?.identityChanged
          ? 'Final process identity recheck failed; no signal was sent.'
          : 'Termination was not proven.',
      };
    }
    return {
      status: 'applied', postFingerprint,
      summary: 'Identity-proven orphaned Ruflo MCP transport was signalled.',
    };
  }

  async function verify(action, outcome) {
    const current = await liveIdentity(action);
    const expected = absentFingerprint(current.pid);
    return {
      ok: current.status === 'absent' && outcome?.postFingerprint === expected,
      postFingerprint: current.status === 'absent' ? expected : null,
    };
  }

  async function inspectCurrent(entry) {
    const current = await liveIdentity(entry);
    if (current.status === 'orphan') {
      return { complete: true, postFingerprint: current.sourceFingerprint };
    }
    if (current.status === 'absent' && current.pid) {
      return { complete: true, postFingerprint: absentFingerprint(current.pid) };
    }
    return { complete: false, postFingerprint: null };
  }

  return {
    id: 'ruflo-mcp-orphan', version: 'v1', authority: 'live-process-identity', resourceKinds: ['daemon'],
    operations: ['terminate'], rollback: ['irreversible'],
    detect, findings, actionFor, preflight, apply, verify, inspectCurrent,
  };
}
