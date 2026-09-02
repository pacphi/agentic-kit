import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalizedOccurrence, publicSource, readBoundedFile, readJsonSource,
  summarizeHostReport,
} from '../common.mjs';

const SCHEMA = Object.freeze({
  id: 'opencode-plugins-1.18.25',
  verifiedVersions: ['1.18.25'],
  evidence: 'https://opencode.ai/docs/plugins/',
  verifiedAt: '2026-09-01',
});

const KNOWN_EVENTS = [
  'command.executed', 'file.edited', 'file.watcher.updated', 'installation.updated',
  'lsp.client.diagnostics', 'lsp.updated', 'message.part.removed', 'message.part.updated',
  'message.removed', 'message.updated', 'permission.replied', 'permission.updated',
  'server.connected', 'session.compacted', 'session.created', 'session.deleted',
  'session.diff', 'session.error', 'session.idle', 'session.status', 'session.updated',
  'todo.updated', 'tool.execute.after', 'tool.execute.before', 'tui.prompt.append',
  'tui.command.execute', 'tui.toast.show',
];

function readConfig(file, root, metadata) {
  if (file.endsWith('.jsonc')) {
    const read = readBoundedFile(file, root);
    if (read.status === 'absent') return null;
    return {
      ...metadata, file, digest: read.digest ?? null,
      status: read.status === 'valid' ? 'opaque' : read.status,
      error: read.status === 'valid' ? 'JSONC is valid OpenCode input but is not normalized by the read-only auditor' : read.error,
    };
  }
  return readJsonSource(file, root, metadata);
}

function pluginFiles(directory, root, metadata) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    return error?.code === 'ENOENT' ? [] : [{ ...metadata, file: directory, status: 'invalid', error: error.message }];
  }
  return entries.filter((entry) => entry.isFile() && /\.(?:js|mjs|cjs|ts)$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const file = path.join(directory, entry.name);
    const read = readBoundedFile(file, root);
    if (read.status !== 'valid') return { ...metadata, file, ...read };
    const events = KNOWN_EVENTS.filter((event) => read.text.includes(event));
    return { ...metadata, file, status: 'opaque', digest: read.digest, detectedEvents: events, baseDir: root };
  });
}

function configRecords(source) {
  if (source.status !== 'valid') return [];
  const plugins = Array.isArray(source.document?.plugin) ? source.document.plugin : [];
  return plugins.filter((plugin) => typeof plugin === 'string').map((plugin, index) => normalizedOccurrence({
    host: 'opencode', event: 'PluginLoad', type: 'package-plugin', handler: { input: { plugin } },
    indices: { plugin: index }, selected: null,
    source: {
      file: source.file, digest: source.digest, sourceKind: source.kind,
      authority: source.authority, generatedStatus: source.generatedStatus,
      owner: source.kind === 'project' ? 'project-owner' : 'user', baseDir: source.baseDir,
    },
    diagnostics: [{
      category: 'security', severity: 'review', code: 'full-process-plugin',
      message: 'OpenCode plugins execute in the host process; package source, install version, and permissions require review',
    }],
  }));
}

function moduleRecords(source) {
  if (source.status !== 'opaque') return [];
  const events = source.detectedEvents?.length ? source.detectedEvents : ['PluginRuntime'];
  return events.map((event, index) => normalizedOccurrence({
    host: 'opencode', event, type: 'module-plugin', handler: { input: { moduleDigest: source.digest } },
    indices: { event: index }, selected: null,
    source: {
      file: source.file, digest: source.digest, sourceKind: source.kind,
      authority: source.authority, generatedStatus: source.generatedStatus,
      owner: source.owner, baseDir: source.baseDir,
    },
    diagnostics: [{
      category: 'security', severity: 'review', code: 'opaque-full-process-plugin',
      message: 'Static event-name discovery cannot prove plugin behavior; inspect and trust the complete module',
    }],
  }));
}

export function auditOpenCodeHooks({
  opencodeRoot = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode'),
  projectRoots = [process.cwd()],
  opencodeVersion = 'unknown',
  ownership = null,
} = {}) {
  const sources = [];
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const source = readConfig(path.join(opencodeRoot, name), opencodeRoot, {
      kind: 'global', authority: ownership?.mcp === 'ak' ? 'mixed-receipt-owned' : 'user-owned',
      generatedStatus: ownership?.mcp === 'ak' ? 'partially-generated' : 'direct', baseDir: opencodeRoot,
    });
    if (source) sources.push(source);
  }
  sources.push(...pluginFiles(path.join(opencodeRoot, 'plugins'), opencodeRoot, {
    kind: 'global-plugin', authority: 'user-or-receipt-owned', generatedStatus: 'unknown', owner: 'unknown',
  }));
  for (const root of [...new Set(projectRoots.map((item) => path.resolve(item)))].sort()) {
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      const source = readConfig(path.join(root, name), root, {
        kind: 'project', authority: 'project-owned', generatedStatus: 'direct', baseDir: root,
      });
      if (source) sources.push(source);
    }
    sources.push(...pluginFiles(path.join(root, '.opencode', 'plugins'), root, {
      kind: 'project-plugin', authority: 'project-owned', generatedStatus: 'direct', owner: 'project-owner',
    }));
  }
  const records = sources.flatMap((source) => [...configRecords(source), ...moduleRecords(source)])
    .sort((a, b) => a.source.file.localeCompare(b.source.file) || a.event.localeCompare(b.event));
  const plan = records.map((record) => ({
    id: `opencode-review-${record.occurrenceId.slice(0, 16)}`,
    host: 'opencode', diagnostic: record.diagnostics[0]?.code ?? 'plugin-review', target: record.source.file,
    classification: record.source.generatedStatus === 'partially-generated' ? 'approval-required' : 'approval-required',
    reason: 'OpenCode plugins execute with host-process authority; remediation requires source-owner review and a restart',
    trustImpact: 'OpenCode does not expose a Codex-style hook trust hash; OS and OpenCode permissions remain separate controls',
  }));
  const gaps = [
    'JSONC is detected but not normalized, so later JSONC layers make effective selection unknown',
    'Plugin modules are never imported or executed; event discovery is intentionally conservative and behavior remains opaque',
    'Organization-supplied configuration and environment overrides are not proven by static local discovery',
  ];
  const coverage = { status: 'partial', gaps };
  return {
    schemaVersion: 2, host: 'opencode', mode: 'read-only',
    hostSchema: { ...SCHEMA, confidence: SCHEMA.verifiedVersions.includes(opencodeVersion) ? 'verified' : 'syntax-only' },
    sources: sources.map(publicSource), records, plan, issues: [], coverage,
    summary: summarizeHostReport({ sources, records, plan, coverage: coverage.status }),
  };
}
