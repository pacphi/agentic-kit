import path from 'node:path';
import { aqeArtifactCandidate, migrateAqeTimeouts } from '../hook-audit/aqe-artifacts.mjs';
import { sha256 } from '../hook-audit/common.mjs';
import { inspectHookTarget } from './fs-port.mjs';

export function compileAqeArtifactActions(report, options) {
  if (options.platform === 'win32' || report.hostSchema?.confidence !== 'verified') return [];
  const actions = [];
  for (const source of report.sources ?? []) {
    if (source.status !== 'valid' || !['aqe-generated-artifact', 'project'].includes(source.kind)) continue;
    let snapshot;
    try { snapshot = inspectHookTarget(source.file, source.baseDir, options); } catch { continue; }
    if (snapshot.sha256 !== source.digest || snapshot.specialMode !== 0
        || (typeof process.getuid === 'function' && snapshot.uid !== process.getuid())) continue;
    let candidateBytes;
    let pointers = [];
    if (source.kind === 'aqe-generated-artifact') candidateBytes = aqeArtifactCandidate(source);
    else {
      let document;
      try { document = JSON.parse(snapshot.bytes.toString('utf8')); } catch { continue; }
      const migration = migrateAqeTimeouts(document);
      pointers = migration.pointers;
      if (!pointers.length) continue;
      candidateBytes = Buffer.from(`${JSON.stringify(migration.document, null, 2)}\n`);
    }
    if (!candidateBytes || sha256(candidateBytes) === snapshot.sha256) continue;
    const proposals = (report.plan ?? []).filter((item) => item.target === source.file
      && item.diagnostic.startsWith('aqe-'));
    actions.push({ host: 'claude', recipeId: `claude/project/aqe-${source.kind === 'project' ? 'native-timeouts' : path.basename(source.file)}/v1`,
      exactProfileId: report.hostSchema.id, hostVersion: report.observedVersion,
      classification: 'approval-required', executable: true,
      canonicalOwnership: { status: 'proven', ownerId: 'current-user-project',
        evidence: source.kind === 'project' ? 'exact-generated-handler-signatures-and-filesystem-owner' : 'reviewed-full-file-digest-and-filesystem-owner' },
      consumedProviderActionIds: proposals.map((item) => item.id).sort(),
      canonicalTarget: { file: source.file, containmentRoot: source.baseDir },
      observedProjection: { file: source.file, sourceKind: source.kind, pointers },
      expectedPreimage: { sha256: snapshot.sha256, size: snapshot.size, mode: snapshot.mode,
        modeSupported: snapshot.modeSupported, uid: snapshot.uid, gid: snapshot.gid,
        specialMode: snapshot.specialMode, parent: snapshot.parent },
      desiredPostimage: { sha256: sha256(candidateBytes), size: candidateBytes.length,
        mode: snapshot.mode, modeSupported: snapshot.modeSupported },
      behaviorImpact: 'Migrate reviewed AQE lifecycle artifacts: direct installed runner, preserved checkpoint on failure, native seconds; retain unrelated hook group members.',
      trustImpact: 'Host may require review of changed definitions; no trust state is modified.',
      activation: { restart: 'new-session', evidence: 'https://github.com/proffesor-for-testing/agentic-qe/pull/661' },
      rollback: 'Restore exact backed-up preimage only while the postimage remains unchanged.',
      verification: { provider: 'claude', sourceFile: source.file,
        diagnosticCodes: proposals.map((item) => item.diagnostic), findingKeys: [],
        method: 'digest-bound re-audit and idempotent second plan', trustState: 'unobserved' },
      diff: `--- ${source.file}\n+++ ${source.file}\n@@ reviewed AQE lifecycle migration @@`, candidateBytes,
    });
  }
  return actions;
}
