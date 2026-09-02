import path from 'node:path';

import { SUPPORTED_CONTRACT, validateAdapterEntryForInspection } from '../../adapters/admission.mjs';
import { hashAdapterContent, baseDirForSource } from '../../adapters/integrity.mjs';
import {
  normalizedOccurrence, publicSource, readJsonSource, summarizeHostReport,
} from '../common.mjs';

function isRemote(source) {
  return /^https?:\/\//.test(source) || source.startsWith('npm:');
}

function hookEntries(manifest) {
  const entries = [];
  for (const [verb, definition] of Object.entries(manifest.lifecycle ?? {})) {
    if (definition?.hook) entries.push({ event: `lifecycle.${verb}`, hook: definition.hook });
  }
  if (manifest.execution?.run?.hook) entries.push({ event: 'execution.run', hook: manifest.execution.run.hook });
  if (manifest.aqe?.provider?.hook) entries.push({ event: 'aqe.provider', hook: manifest.aqe.provider.hook });
  return entries;
}

function recordsFrom(source, manifest, integrity) {
  return hookEntries(manifest).map(({ event, hook }, index) => normalizedOccurrence({
    host: manifest.host.id, event, type: 'argv-subprocess', handler: { command: hook.command },
    indices: { hook: index }, selected: null,
    timeout: {
      declared: hook.timeoutMs ?? null, units: 'milliseconds', effective: hook.timeoutMs ?? null,
      default: null, maximum: null, status: 'manifest-validated',
    },
    source: {
      file: source.file, digest: source.digest, sourceKind: 'external-adapter-manifest',
      authority: 'operator-configured-unadmitted-for-audit', generatedStatus: 'direct',
      owner: manifest.host.id, baseDir: source.baseDir, adapterVersion: manifest.version,
      contentHash: integrity.hash, hookFiles: integrity.hookFiles,
    },
    diagnostics: [{
      category: 'authority', severity: 'review', code: 'consent-and-grants-not-inferred',
      message: 'Manifest validity and content identity do not prove consent, capability grants, runtime reachability, or target-host compatibility',
    }],
  }));
}

/** @param {{config?:any,cwd?:string}} options */
export function auditExternalHooks({ config = {}, cwd = process.cwd() } = /** @type {any} */ ({})) {
  const sources = [];
  const records = [];
  const issues = [];
  for (const entry of Array.isArray(config.hostAdapters) ? config.hostAdapters : []) {
    const name = typeof entry?.name === 'string' ? entry.name : '(unknown)';
    const declared = typeof entry?.source === 'string' ? entry.source : '';
    if (!declared) {
      issues.push(`${name}: adapter source is missing`);
      continue;
    }
    if (isRemote(declared)) {
      sources.push({
        kind: 'external-adapter-manifest', file: declared, status: 'opaque', digest: null,
        authority: 'operator-configured', generatedStatus: 'remote',
        error: 'remote sources are not fetched by a default-safe offline audit',
      });
      continue;
    }
    const file = path.resolve(cwd, declared);
    const root = path.dirname(file);
    const source = readJsonSource(file, root, {
      kind: 'external-adapter-manifest', authority: 'operator-configured', generatedStatus: 'direct', baseDir: root,
    });
    if (!source) {
      sources.push({ kind: 'external-adapter-manifest', file, status: 'invalid', error: 'configured manifest is absent' });
      continue;
    }
    sources.push(source);
    if (source.status !== 'valid') continue;
    try {
      const inspected = validateAdapterEntryForInspection(entry, source.document);
      if (!inspected.ok) {
        source.status = 'inadmissible';
        source.error = `${inspected.failure.reason}: ${inspected.failure.detail}`;
        issues.push(`${name}: ${source.error}`);
        continue;
      }
      const { manifest } = inspected;
      const baseDir = baseDirForSource(file);
      const integrity = hashAdapterContent(manifest, { baseDir });
      records.push(...recordsFrom({ ...source, baseDir }, manifest, integrity));
    } catch (error) {
      source.status = 'invalid';
      source.error = error?.message ?? String(error);
    }
  }
  records.sort((a, b) => a.host.localeCompare(b.host) || a.event.localeCompare(b.event));
  const plan = records.map((record) => ({
    id: `external-review-${record.occurrenceId.slice(0, 16)}`,
    host: record.host, diagnostic: 'target-host-compatibility-unproven', target: record.source.file,
    classification: 'approval-required',
    reason: 'An operator must verify host/version compatibility, consent, grants, and the pinned hook-file identity before activation',
    trustImpact: 'Any manifest or declared-hook-file change would produce a new content hash and require fresh admission, consent, and grants; this audit changed none of those states',
  }));
  const gaps = [
    'Remote HTTPS and npm adapter sources are reported but never fetched during the default offline audit',
    'Adapter consent, grants, reachability, and executable target versions remain independent evidence dimensions',
    'The current adapter contract has no target host-version compatibility range; every external hook therefore requires human verification',
  ];
  const coverage = { status: 'partial', gaps };
  return {
    schemaVersion: 2, host: 'external', mode: 'read-only', observedVersion: `contract-${SUPPORTED_CONTRACT}`, hostSchema: {
      id: 'agentic-kit-host-adapter-v1', confidence: 'manifest-validated',
      evidence: 'docs/adr/0031-capability-graduation-and-upstream-requests.md', verifiedAt: '2026-09-01',
    },
    sources: sources.map(publicSource), records, plan, issues, coverage,
    summary: summarizeHostReport({ sources, records, plan, issues, coverage: coverage.status }),
  };
}
