import os from 'node:os';
import path from 'node:path';

import {
  isRecord, normalizedOccurrence, publicSource, readJsonSource, sha256,
  stableJson, summarizeHostReport,
} from '../common.mjs';

const SCHEMA = Object.freeze({
  id: 'claude-hooks-2.1.258',
  verifiedVersions: ['2.1.258'],
  timeoutUnits: 'seconds',
  evidence: 'https://code.claude.com/docs/en/hooks',
  verifiedAt: '2026-09-01',
});

const MANAGED = Object.freeze({
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
});

function validateDocument(document, { strict = true } = {}) {
  if (!isRecord(document)) return 'settings must be an object';
  if (document.hooks !== undefined && !isRecord(document.hooks)) return 'settings hooks must be an object';
  for (const [event, groups] of Object.entries(document.hooks ?? {})) {
    if (!Array.isArray(groups)) return `${event} hook groups must be an array`;
    for (const [groupIndex, group] of groups.entries()) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return `${event} hook group ${groupIndex} requires a hooks array`;
      if (strict && group.matcher !== undefined && typeof group.matcher !== 'string') return `${event} hook group ${groupIndex} matcher must be a string`;
      for (const [hookIndex, hook] of group.hooks.entries()) {
        if (!isRecord(hook) || (strict && typeof hook.type !== 'string')) return `${event} hook ${groupIndex}/${hookIndex} requires an object${strict ? ' with a type' : ''}`;
        if (strict && hook.timeout !== undefined && (!Number.isFinite(hook.timeout) || hook.timeout < 0)) {
          return `${event} hook ${groupIndex}/${hookIndex} timeout must be a nonnegative number`;
        }
        if (strict && hook.type === 'command' && (typeof hook.command !== 'string' || !hook.command.trim())) {
          return `${event} command hook ${groupIndex}/${hookIndex} requires a command`;
        }
      }
    }
  }
  return null;
}

function readSettings(file, metadata, root, strict = true) {
  const source = readJsonSource(file, root, metadata);
  if (!source || source.status !== 'valid') return source;
  const error = validateDocument(source.document, { strict });
  return error ? { ...source, status: 'invalid', error: `hook schema failed: ${error}` } : source;
}

function sourcesForPluginInstall(ref, install, strict) {
  const sources = [];
  if (!isRecord(install) || typeof install.installPath !== 'string') return sources;
  const root = path.resolve(install.installPath);
  const manifestCandidates = [
    path.join(root, '.claude-plugin', 'plugin.json'),
    path.join(root, '.agent-plugin', 'plugin.json'),
  ];
  const manifest = manifestCandidates.map((file) => readJsonSource(file, root)).find(Boolean);
  if (manifest) sources.push({
    ...manifest, kind: 'plugin-manifest', pluginRef: ref,
    pluginVersion: install.version ?? manifest.document?.version ?? null,
    authority: 'generated-runtime-copy', generatedStatus: 'generated', baseDir: root,
  });
  const targets = [];
  if (manifest?.status === 'valid' && manifest.document?.hooks !== undefined) {
    const declared = Array.isArray(manifest.document.hooks) ? manifest.document.hooks : [manifest.document.hooks];
    for (const value of declared) {
      if (typeof value === 'string' && value.startsWith('./')) targets.push(path.resolve(root, value));
      else if (isRecord(value)) {
        const error = validateDocument(value, { strict });
        sources.push(error
          ? { kind: 'plugin-cache-inline', pluginRef: ref, pluginVersion: install.version ?? null, authority: 'generated-runtime-copy', generatedStatus: 'generated', file: `${manifest.file}#hooks`, status: 'invalid', error }
          : { kind: 'plugin-cache-inline', pluginRef: ref, pluginVersion: install.version ?? null, authority: 'generated-runtime-copy', generatedStatus: 'generated', file: `${manifest.file}#hooks`, status: 'valid', digest: sha256(stableJson(value)), document: value, baseDir: root });
      }
    }
  } else {
    // Claude plugin manifests are optional. Default component discovery still
    // loads hooks/hooks.json, so the auditor must not require a manifest.
    targets.push(path.join(root, 'hooks', 'hooks.json'));
  }
  for (const file of targets) {
    const source = readSettings(file, {
      kind: 'plugin-cache', pluginRef: ref, pluginVersion: install.version ?? null,
      authority: 'generated-runtime-copy', generatedStatus: 'generated', baseDir: root,
    }, root, strict);
    if (source) sources.push(source);
  }
  return sources;
}

function pluginSources(claudeRoot, strict) {
  let registry = readJsonSource(path.join(claudeRoot, 'plugins', 'installed_plugins.json'), claudeRoot, {
    kind: 'plugin-registry', authority: 'claude-managed-registry', generatedStatus: 'generated',
  });
  if (registry?.status === 'valid' && !isRecord(registry.document?.plugins)) {
    registry = { ...registry, status: 'invalid', error: 'plugin registry requires a plugins object' };
  }
  if (!registry || registry.status !== 'valid') return { registry, sources: [] };
  const sources = [];
  for (const [ref, installs] of Object.entries(registry.document.plugins)) {
    if (!Array.isArray(installs)) continue;
    for (const install of installs) sources.push(...sourcesForPluginInstall(ref, install, strict));
  }
  return { registry, sources };
}

function defaultTimeout(event, type) {
  if (event === 'SessionEnd') return 1.5;
  if (event === 'UserPromptSubmit' && ['command', 'http', 'mcp_tool'].includes(type)) return 30;
  if (type === 'prompt') return 30;
  if (type === 'agent') return 60;
  return 600;
}

function timeoutFor(hook, verified, event, sourceKind) {
  const declared = typeof hook.timeout === 'number' ? hook.timeout : null;
  const fallback = defaultTimeout(event, hook.type);
  const plugin = sourceKind === 'plugin-cache' || sourceKind === 'plugin-cache-inline';
  if (verified && event === 'SessionEnd' && plugin) {
    return {
      declared, units: 'seconds', effective: null, default: 1.5, maximum: null,
      status: 'plugin-session-budget-dependent',
      sessionBudget: 'plugin timeouts do not raise the SessionEnd budget; effective time depends on settings-level hooks or the environment override',
    };
  }
  if (verified && event === 'SessionEnd') {
    return {
      declared, units: 'seconds', effective: Math.min(declared ?? fallback, 60),
      default: fallback, maximum: 60, status: declared !== null && declared > 60 ? 'clamped' : 'valid-or-default',
    };
  }
  return {
    declared,
    units: verified ? 'seconds' : 'unknown',
    effective: verified ? (declared ?? fallback) : null,
    default: verified ? fallback : null,
    maximum: null,
    status: verified ? 'valid-or-default' : 'unverified',
  };
}

function recordsFrom(source, version) {
  if (source.status !== 'valid') return [];
  if (source.kind === 'plugin-registry' || source.kind === 'plugin-manifest') return [];
  const verified = SCHEMA.verifiedVersions.includes(version);
  const records = [];
  for (const [event, groups] of Object.entries(source.document.hooks ?? {})) {
    groups.forEach((group, groupIndex) => group.hooks.forEach((hook, hookIndex) => {
      const diagnostics = [{
        category: 'trust', severity: 'info', code: 'trust-independent',
        message: 'Static audit findings do not establish Claude permission or managed-policy state',
      }];
      if (verified && typeof hook.timeout === 'number' && hook.timeout > 600) diagnostics.push({
        category: 'performance', severity: 'warning', code: 'probable-timeout-unit-mismatch',
        message: `Claude hook timeout ${hook.timeout}s is unusually high; confirm it was not authored as milliseconds`,
      });
      if (verified && event === 'SessionEnd' && !source.kind.startsWith('plugin-cache') && hook.timeout > 60) diagnostics.push({
        category: 'compatibility', severity: 'warning', code: 'sessionend-timeout-clamped',
        message: `Claude SessionEnd timeout ${hook.timeout}s exceeds the 60s settings budget and is effectively clamped`,
      });
      if (verified && event === 'SessionEnd' && source.kind.startsWith('plugin-cache') && hook.timeout > 1.5) diagnostics.push({
        category: 'compatibility', severity: 'warning', code: 'plugin-sessionend-budget-not-raised',
        message: 'A plugin SessionEnd timeout does not raise Claude\'s 1.5s default session budget; effective runtime depends on a settings-level budget or environment override',
      });
      records.push(normalizedOccurrence({
        host: 'claude', event, matcher: group.matcher ?? '', type: hook.type, handler: hook,
        indices: { group: groupIndex, hook: hookIndex }, timeout: timeoutFor(hook, verified, event, source.kind), diagnostics,
        selected: source.selected ?? null,
        source: {
          file: source.file, digest: source.digest, sourceKind: source.kind,
          authority: source.authority, generatedStatus: source.generatedStatus,
          owner: source.pluginRef ?? (source.kind === 'managed' ? 'administrator' : source.kind === 'project' ? 'project-owner' : 'user'),
          baseDir: source.baseDir ?? path.dirname(source.file),
          pluginRef: source.pluginRef ?? null, pluginVersion: source.pluginVersion ?? null,
        },
      }));
    }));
  }
  return records;
}

function remediation(records) {
  return records.flatMap((record) => {
    const diagnostic = record.diagnostics.find((item) => [
      'probable-timeout-unit-mismatch', 'sessionend-timeout-clamped', 'plugin-sessionend-budget-not-raised',
    ].includes(item.code));
    if (!diagnostic) return [];
    return [{
    id: `claude-timeout-review-${record.occurrenceId.slice(0, 16)}`,
    host: 'claude', diagnostic: diagnostic.code, target: record.source.file,
    classification: record.source.generatedStatus === 'generated' ? 'upstream-required' : 'approval-required',
    reason: 'Timeout units require source-owner confirmation; changing the definition can change behavior and trust state',
    trustImpact: 'definition changes require the host to re-evaluate trust or managed policy',
    }];
  });
}

export function auditClaudeHooks({
  claudeRoot = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  projectRoots = [process.cwd()],
  managedSettingsFile = MANAGED[process.platform] ?? null,
  claudeVersion = 'unknown',
} = {}) {
  const verified = SCHEMA.verifiedVersions.includes(claudeVersion);
  const sources = [];
  const global = readSettings(path.join(claudeRoot, 'settings.json'), {
    kind: 'global', authority: 'user-owned', generatedStatus: 'direct', baseDir: claudeRoot,
  }, claudeRoot, verified);
  if (global) sources.push(global);
  if (managedSettingsFile) {
    const managed = readSettings(managedSettingsFile, {
      kind: 'managed', authority: 'administrator-managed', generatedStatus: 'direct', baseDir: path.dirname(managedSettingsFile), selected: true,
    }, path.dirname(managedSettingsFile), verified);
    if (managed) sources.push(managed);
  }
  for (const root of [...new Set(projectRoots.map((item) => path.resolve(item)))].sort()) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const source = readSettings(path.join(root, '.claude', name), {
        kind: 'project', authority: 'project-or-user-owned', generatedStatus: 'unknown', baseDir: root,
      }, root, verified);
      if (source) sources.push(source);
    }
  }
  const plugins = pluginSources(claudeRoot, verified);
  if (plugins.registry) sources.push(plugins.registry);
  sources.push(...plugins.sources);
  const records = sources.flatMap((source) => recordsFrom(source, claudeVersion)).sort((a, b) => a.source.file.localeCompare(b.source.file) || a.event.localeCompare(b.event));
  const plan = remediation(records);
  const gaps = [
    'Claude runtime selection, organization policy, and trust decisions are not inferred from static files',
    'Skill, subagent, and session-defined hooks outside settings/plugin manifests are reported only when declared through an inspected plugin hook document',
  ];
  const coverage = { status: 'partial', gaps };
  return {
    schemaVersion: 2, host: 'claude', mode: 'read-only', observedVersion: claudeVersion,
    hostSchema: { ...SCHEMA, confidence: verified ? 'verified' : 'syntax-only' },
    sources: sources.map(publicSource), records, plan, issues: [], coverage,
    summary: summarizeHostReport({ sources, records, plan, coverage: coverage.status }),
  };
}
