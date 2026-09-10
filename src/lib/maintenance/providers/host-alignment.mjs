import os from 'node:os';
import { inspectHostAlignment, applyHostAlignment, hostAlignmentFindingId } from '../../host-alignment.mjs';
import { projectReference } from '../evidence.mjs';
import { baseAction, providerFinding, sha256 } from './shared.mjs';

const ID = 'host-alignment';
const VERSION = 'v1';
const fingerprint = (finding, snapshot) => sha256({ id: hostAlignmentFindingId(finding), source: snapshot?.digest, identity: snapshot?.identity });
const absent = id => sha256({ id, absent: true });
const displayName = finding => `Host alignment: ${/^[a-zA-Z0-9._-]{1,80}$/.test(finding.name ?? '') ? finding.name : 'configuration'}`;

/** @param {{projectRoots?:string[],home?:string,inspect?:typeof inspectHostAlignment,applyAlignment?:typeof applyHostAlignment,discoverProjects?:(home:string)=>string[]}} [options] */
export function createHostAlignmentProvider({
  projectRoots = [process.cwd()], home = os.homedir(), inspect = inspectHostAlignment, applyAlignment = applyHostAlignment,
  discoverProjects = () => [],
} = {}) {
  function detect() {
    const report = inspect({ projectRoots: [...new Set([...projectRoots, ...discoverProjects(home)])], home });
    const entries = report.findings.filter(f => f.level === 'fail').map(finding => ({
      id: hostAlignmentFindingId(finding), host: finding.host,
      scope: finding.scope === 'local' ? 'project' : finding.scope,
      project: finding.project ?? null, file: finding.file, name: displayName(finding),
      code: finding.code, message: finding.message, remedy: finding.remedy,
      repairable: finding.repairable, sourceFingerprint: fingerprint(finding, report.snapshots.find(s => s.file === finding.file)),
    }));
    return { status: 'available', complete: !report.findings.some(f => f.code === 'config-unassessed'),
      authority: 'configuration-snapshot', entries, asOf: new Date().toISOString() };
  }

  function findings(facts) {
    return (facts.entries ?? []).map(entry => providerFinding({
      providerId: ID, providerVersion: VERSION, stableKey: entry.id,
      state: 'stale-configuration', bucket: 'needsReview', classification: `host-alignment:${entry.code}`,
      safetyClass: entry.repairable ? 'approval-required' : 'never-automatic',
      resource: { id: entry.id, kind: 'mcpServer', name: entry.name, host: entry.host, scope: entry.scope,
        projectRef: projectReference(entry.project) },
      ownership: { owner: 'user', authority: 'explicit-scoped-approval', managed: false },
      evidence: { sources: ['host-alignment:configuration-snapshot'], asOf: facts.asOf,
        completeness: facts.complete ? 'complete' : 'partial' },
      impact: { summary: entry.message, files: 1, preserved: ['AQE and Ruflo native routing', 'Other registrations and settings'],
        preview: ['Remove only the selected retired transport definition.', 'Save a current-state recovery backup beside its configuration.', 'Verify the selected finding is gone. Automatic dashboard Undo is unavailable.'] },
      operation: 'realign', label: 'Realign host transport', executable: entry.repairable,
      rollback: 'irreversible', restart: 'required',
      recommendation: entry.repairable ? 'Preview and approve this exact host transport correction.' : entry.remedy,
      steps: ['Review the selected host, scope and registration.', 'Approve this exact correction.', 'Restart the affected host session and rescan.'],
      preserved: ['AQE provider configuration', 'Ruflo dual-mode routing', 'Other projects and MCP registrations'],
    }));
  }

  function actionFor(finding, facts) {
    if (!facts?.complete || finding.nextAction?.providerId !== ID || finding.nextAction.operation !== 'realign') return null;
    const entry = facts.entries.find(item => item.id === finding.resource?.id && item.repairable);
    if (!entry) return null;
    return baseAction(finding, { providerId: ID, providerVersion: VERSION, operation: 'realign',
      sourceFingerprint: entry.sourceFingerprint, rollback: 'irreversible', restart: 'required' });
  }

  function current(action) {
    if (action?.providerId !== ID || action.operation !== 'realign') return null;
    const facts = detect();
    return facts.complete && facts.entries.find(entry => entry.id === action.resourceIdentity?.id
      && entry.repairable && entry.sourceFingerprint === action.sourceFingerprint) || null;
  }

  async function apply(action) {
    const entry = current(action);
    if (!entry) return { status: 'unknown', summary: 'Host alignment target changed; refresh the preview.' };
    const report = inspect({ projectRoots: entry.project ? [entry.project] : [], home, selectedFindingIds: [entry.id] });
    const observed = report.findings.find(f => hostAlignmentFindingId(f) === entry.id);
    if (!observed || fingerprint(observed, report.snapshots.find(s => s.file === entry.file)) !== action.sourceFingerprint) {
      return { status: 'unknown', summary: 'Host alignment source changed before correction.' };
    }
    const result = await applyAlignment(report, { confirmed: true });
    return result.ok ? { status: 'applied', postFingerprint: absent(entry.id),
      summary: 'Selected host transport realigned; a recovery backup was saved beside the configuration.' }
      : { status: 'unknown', summary: 'Host correction did not verify; inspect the configuration and recovery backups.' };
  }

  function verify(action, outcome) {
    const facts = detect();
    const removed = facts.complete && !facts.entries.some(entry => entry.id === action.resourceIdentity?.id);
    const postFingerprint = removed ? absent(action.resourceIdentity?.id) : null;
    return { ok: !!removed && postFingerprint === outcome.postFingerprint, postFingerprint };
  }

  return { id: ID, version: VERSION, authority: 'configuration-snapshot', status: 'available',
    resourceKinds: ['mcpServer'], operations: ['realign'], rollback: ['irreversible'],
    limitations: [{ code: 'manual-backup-recovery', message: 'Recovery backups are retained; automatic dashboard Undo is unavailable.' }],
    detect, findings, actionFor, apply, verify,
    preflight: async action => { const entry = current(action); return { ok: !!entry, sourceFingerprint: entry?.sourceFingerprint ?? null }; },
  };
}
