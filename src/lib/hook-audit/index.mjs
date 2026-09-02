// Read-only Codex lifecycle-hook discovery and normalization. This module
// deliberately does not expose a writer: trust, generated project files, and
// plugin-cache generations are outside agentic-kit's automatic authority.
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { inspectCodexPlugins } from '../codex-plugins.mjs';
import { readBoundedFile, redactCommand, stableJson } from './common.mjs';
import { readCodexInlineHooks } from './codex-toml.mjs';

const SCHEMA = Object.freeze({
  id: 'codex-hooks-2026-09-01',
  timeoutUnits: 'seconds',
  sessionEnd: { default: 1, maximum: 3 },
  evidence: 'https://developers.openai.com/codex/hooks',
  verifiedAt: '2026-09-01',
  confidence: 'verified',
});

const VERIFIED_CODEX_VERSION = '0.151.0';
const CODEX_EVENTS = new Set([
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'UserPromptSubmit', 'SubagentStop', 'Stop', 'SessionStart', 'SubagentStart', 'SessionEnd',
]);
const CODEX_HANDLER_TYPES = new Set(['command', 'mcp_tool', 'prompt', 'agent']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const pointerPart = (value) => String(value).replaceAll('~', '~0').replaceAll('/', '~1');

function schemaFor(codexVersion) {
  if (codexVersion === VERIFIED_CODEX_VERSION) return SCHEMA;
  return Object.freeze({
    id: 'codex-hooks-syntax-only',
    timeoutUnits: 'unknown',
    sessionEnd: { default: null, maximum: null },
    evidence: SCHEMA.evidence,
    verifiedAt: SCHEMA.verifiedAt,
    confidence: 'syntax-only',
  });
}

const isRecord = (value) => Boolean(value) && !Array.isArray(value) && typeof value === 'object';

function validateMcpHook(hook, event, location) {
  if (event === 'SessionEnd') return `${location} mcp_tool is not supported for SessionEnd`;
  if (typeof hook.server !== 'string' || !hook.server.trim()) return `${location} mcp_tool requires server`;
  if (typeof hook.tool !== 'string' || !hook.tool.trim()) return `${location} mcp_tool requires tool`;
  if (hook.input !== undefined && !isRecord(hook.input)) return `${location} mcp_tool input must be an object`;
  return null;
}

function validateCommonHookFields(hook, location) {
  if (hook.async !== undefined && typeof hook.async !== 'boolean') return `${location} async must be a boolean`;
  if (hook.commandWindows !== undefined && typeof hook.commandWindows !== 'string') return `${location} commandWindows must be a string`;
  if (hook.statusMessage !== undefined && typeof hook.statusMessage !== 'string') return `${location} statusMessage must be a string`;
  if (hook.additionalContextLimit !== undefined
      && (!Number.isInteger(hook.additionalContextLimit) || hook.additionalContextLimit < 0)) {
    return `${location} additionalContextLimit must be a nonnegative integer`;
  }
  return null;
}

function validateHook(hook, event, groupIndex, hookIndex, strictProfile) {
  const location = `${event} hook ${groupIndex}/${hookIndex}`;
  if (!isRecord(hook)) return `${location} must be an object`;
  if (hook.type !== undefined && typeof hook.type !== 'string') {
    return `${location} type must be a string`;
  }
  const type = hook.type ?? 'command';
  if (strictProfile && !CODEX_HANDLER_TYPES.has(type)) return `${location} has unsupported type ${type}`;
  if (hook.timeout !== undefined
      && (typeof hook.timeout !== 'number' || !Number.isFinite(hook.timeout) || hook.timeout < 0)) {
    return `${location} timeout must be a finite nonnegative number`;
  }
  if (type === 'command'
      && (typeof hook.command !== 'string' || hook.command.trim() === '')) {
    return `${event} command hook ${groupIndex}/${hookIndex} requires a non-empty command`;
  }
  if (type === 'mcp_tool') {
    const mcpError = validateMcpHook(hook, event, location);
    if (mcpError) return mcpError;
  }
  return validateCommonHookFields(hook, location);
}

function validateHookGroup(group, event, groupIndex, strictProfile) {
  if (!isRecord(group)) return `${event} hook group ${groupIndex} must be an object`;
  if (group.matcher !== undefined && typeof group.matcher !== 'string') {
    return `${event} hook group ${groupIndex} matcher must be a string`;
  }
  if (!Array.isArray(group.hooks)) return `${event} hook group ${groupIndex} hooks must be an array`;
  for (const [hookIndex, hook] of group.hooks.entries()) {
    const error = validateHook(hook, event, groupIndex, hookIndex, strictProfile);
    if (error) return error;
  }
  return null;
}

function validateHookDocument(document, schema) {
  if (!isRecord(document) || !isRecord(document.hooks)) {
    return 'hook JSON requires a top-level hooks object';
  }
  for (const [event, groups] of Object.entries(document.hooks)) {
    if (schema.confidence === 'verified' && !CODEX_EVENTS.has(event)) return `unsupported Codex hook event ${event}`;
    if (!Array.isArray(groups)) return `${event} hook groups must be an array`;
    for (const [groupIndex, group] of groups.entries()) {
      const error = validateHookGroup(group, event, groupIndex, schema.confidence === 'verified');
      if (error) return error;
    }
  }
  return null;
}

function readHookSource(file, metadata, containmentRoot, schema) {
  const read = readBoundedFile(file, containmentRoot);
  if (read.status === 'absent') return null;
  if (read.status !== 'valid') return { ...metadata, file, ...read };
  try {
    const document = JSON.parse(read.text);
    const schemaError = validateHookDocument(document, schema);
    if (schemaError) return { ...metadata, file, status: 'invalid', digest: read.digest, error: `hook schema failed: ${schemaError}` };
    return { ...metadata, file, status: 'valid', digest: read.digest, document };
  } catch (error) {
    return {
      ...metadata,
      file,
      status: 'invalid',
      digest: read.digest,
      error: `JSON parse failed: ${error.message}`,
    };
  }
}

function normalizeCommand(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function commandFacts(command) {
  const normalized = normalizeCommand(command);
  const redacted = redactCommand(normalized);
  return {
    normalized: redacted,
    digest: sha256(normalized),
    redacted: redacted !== normalized,
    shell: /(?:^|[\s/])(?:env\s+)?(?:sh|bash|zsh|fish|cmd(?:\.exe)?|powershell|pwsh)(?:\s|$)|(?:&&|\|\||[|;<>`])/i.test(normalized),
    projectDirReferences: [...new Set(normalized.match(/\$\{?[A-Z][A-Z0-9_]+/g) ?? [])].sort(),
  };
}

function implementationTarget(command) {
  const normalized = normalizeCommand(command);
  const script = normalized.match(/(?:^|[\s"'])([^\s"']+\.(?:cjs|mjs|js))(?:[\s"']|$)/)?.[1];
  if (script) return script;
  return normalized.split(' ')[0] || '(none)';
}

function sideEffectHints(command) {
  const normalized = normalizeCommand(command);
  const hints = [];
  if (/\bnpx\b/.test(normalized)) hints.push('package-resolution-or-network-possible');
  if (/\b(?:gh|curl|wget)\b/.test(normalized)) hints.push('network-possible');
  if (/\.claude-flow|\.swarm|auto-memory|session-end|post-(?:edit|task|command)/.test(normalized)) {
    hints.push('state-write-possible');
  }
  if (/\b(?:rm|unlink|kill|shutdown)\b/.test(normalized)) hints.push('destructive-process-or-file-action-possible');
  return hints.length ? hints : ['unknown-inspect-implementation'];
}

function sourcePosture(source) {
  if (source.kind.startsWith('plugin-cache')) {
    return { owner: source.pluginRef, authority: 'generated-runtime-copy', generatedStatus: 'generated' };
  }
  if (source.kind.startsWith('project')) {
    return { owner: 'unknown-generator', authority: 'unknown', generatedStatus: 'suspected-generated' };
  }
  return { owner: 'user', authority: 'user-owned', generatedStatus: 'direct' };
}

function timeoutFacts(event, hook, schema) {
  const declared = typeof hook.timeout === 'number' ? hook.timeout : null;
  const maximum = event === 'SessionEnd' ? schema.sessionEnd.maximum : null;
  const defaultValue = event === 'SessionEnd' ? schema.sessionEnd.default : 600;
  const effective = schema.confidence === 'verified'
    ? maximum !== null ? Math.min(declared ?? defaultValue, maximum) : (declared ?? defaultValue)
    : null;
  return {
    declared,
    default: schema.confidence === 'verified' ? defaultValue : null,
    units: schema.timeoutUnits,
    effective,
    maximum,
    status: schema.confidence !== 'verified'
      ? 'unverified'
      : maximum !== null && declared !== null && declared > maximum ? 'clamped' : 'valid-or-default',
    ruleEvidence: maximum !== null ? schema.evidence : null,
  };
}

function diagnosticsFor(event, hook, source, command, schema) {
  const diagnostics = [];
  if (event === 'SessionEnd' && typeof hook.timeout === 'number'
      && schema.sessionEnd.maximum !== null && hook.timeout > schema.sessionEnd.maximum) {
    diagnostics.push({
      category: 'compatibility',
      severity: 'warning',
      code: 'session-end-timeout-clamped',
      message: `SessionEnd timeout ${hook.timeout}s exceeds Codex's ${schema.sessionEnd.maximum}s maximum and is clamped at runtime`,
    });
  }
  if (source.kind === 'project' && command.includes('.claude/')) {
    diagnostics.push({
      category: 'provenance',
      severity: 'warning',
      code: 'claude-projection-in-codex',
      message: 'Codex hook invokes a Claude-oriented project helper; generator provenance must be resolved before healing',
    });
  }
  if (commandFacts(command).shell) {
    diagnostics.push({
      category: 'security', severity: 'review', code: 'dynamic-shell',
      message: 'Command uses a shell wrapper and requires human review of expansion, cwd, and environment behavior',
    });
  }
  diagnostics.push({
    category: 'trust', severity: 'info', code: 'trust-independent',
    message: 'Compatibility and security findings do not establish Codex hook trust',
  });
  return diagnostics;
}

function recordsFromSource(source, codexVersion, schema) {
  if (source.status !== 'valid') return [];
  const posture = sourcePosture(source);
  const records = [];
  for (const [event, groups] of Object.entries(source.document.hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return;
      group.hooks.forEach((hook, hookIndex) => {
        if (!hook || typeof hook !== 'object') return;
        const rawCommand = typeof hook.command === 'string' ? hook.command : '';
        const matcher = typeof group.matcher === 'string' ? group.matcher : '';
        const behaviorInput = stableJson({
          event,
          matcher,
          type: hook.type ?? 'command',
          command: normalizeCommand(rawCommand),
          commandWindows: hook.commandWindows ?? null,
          server: hook.server ?? null,
          tool: hook.tool ?? null,
          input: hook.input ?? null,
          async: hook.async ?? false,
          statusMessage: hook.statusMessage ?? null,
          additionalContextLimit: hook.additionalContextLimit ?? null,
          timeout: typeof hook.timeout === 'number' ? hook.timeout : null,
          cwd: source.baseDir ?? source.projectPath ?? path.dirname(source.file),
        });
        const rawFingerprint = sha256(JSON.stringify(hook));
        const occurrenceId = sha256(stableJson({
          host: 'codex', event, matcher, indices: { group: groupIndex, hook: hookIndex },
          source: { file: source.file, digest: source.digest }, rawFingerprint,
        }));
        records.push({
          schemaVersion: 1,
          host: 'codex',
          scope: {
            kind: source.kind,
            projectPath: source.projectPath ?? null,
            pluginRef: source.pluginRef ?? null,
            pluginVersion: source.pluginVersion ?? null,
          },
          event,
          matcher,
          indices: { group: groupIndex, hook: hookIndex },
          type: hook.type ?? 'command',
          rawCommand: redactCommand(rawCommand),
          command: commandFacts(rawCommand),
          implementationTarget: implementationTarget(rawCommand),
          timeout: timeoutFacts(event, hook, schema),
          source: {
            file: source.file,
            jsonPointer: `/hooks/${pointerPart(event)}/${groupIndex}/hooks/${hookIndex}`,
            digest: source.digest,
            sourceKind: source.kind,
            owner: posture.owner,
            authority: posture.authority,
            generatedStatus: posture.generatedStatus,
            provenanceConfidence: source.kind === 'global' || source.kind === 'global-inline' ? 'high' : source.kind.startsWith('plugin-cache') ? 'high' : 'low',
          },
          runtime: { codexCliVersion: codexVersion },
          sideEffects: sideEffectHints(rawCommand),
          risk: 'HUMAN REVIEW REQUIRED',
          trust: {
            observedState: 'unknown',
            recommendation: 'HUMAN REVIEW REQUIRED',
            evidence: 'Trust hashes are intentionally not inferred from project trust or compatibility state',
          },
          rawFingerprint,
          behaviorFingerprint: sha256(behaviorInput),
          duplicateGroupId: sha256(behaviorInput),
          occurrenceId,
          diagnostics: diagnosticsFor(event, hook, source, rawCommand, schema),
        });
      });
    });
  }
  return records;
}

function planFor(records) {
  return records
    .filter((record) => record.timeout.status === 'clamped')
    .map((record) => ({
      id: `codex-hook-timeout-${record.behaviorFingerprint.slice(0, 12)}-${sha256(`${record.source.file}\0${record.source.jsonPointer}`).slice(0, 12)}`,
      diagnostic: 'session-end-timeout-clamped',
      target: record.source.file,
      sourceDigest: record.source.digest,
      classification: record.scope.kind === 'global' ? 'approval-required' : 'never-automatic',
      reason: record.scope.kind.startsWith('plugin-cache')
        ? 'repair the authoritative plugin source and reinstall; never edit the cache generation'
        : record.scope.kind.startsWith('project')
          ? 'project generator/authority is unresolved; repair the proven canonical source first'
          : 'user-owned direct hook changes require an explicit per-action approval',
      trustImpact: 'none; Codex will separately require review if a definition changes',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Produce a deterministic, read-only hook inventory and remediation plan. */
export function auditCodexHooks({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  projectRoots = [process.cwd()],
  pluginCacheDir = path.join(codexHome, 'plugins', 'cache'),
  codexVersion = 'unknown',
} = {}) {
  const schema = schemaFor(codexVersion);
  const sources = [];
  const globalSource = readHookSource(path.join(codexHome, 'hooks.json'), { kind: 'global' }, codexHome, schema);
  if (globalSource) sources.push(globalSource);
  const globalInline = readCodexInlineHooks(path.join(codexHome, 'config.toml'), codexHome, {
    kind: 'global-inline', authority: 'user-owned', generatedStatus: 'direct', baseDir: codexHome,
  });
  if (globalInline) {
    const error = globalInline.status === 'valid' ? validateHookDocument(globalInline.document, schema) : null;
    sources.push(error ? { ...globalInline, status: 'invalid', error: `hook schema failed: ${error}` } : globalInline);
  }
  for (const projectPath of [...new Set(projectRoots.map((root) => path.resolve(root)))].sort()) {
    const source = readHookSource(path.join(projectPath, '.codex', 'hooks.json'), { kind: 'project', projectPath }, projectPath, schema);
    if (source) sources.push(source);
    const inline = readCodexInlineHooks(path.join(projectPath, '.codex', 'config.toml'), projectPath, {
      kind: 'project-inline', projectPath, authority: 'project-owned', generatedStatus: 'unknown', baseDir: projectPath,
    });
    if (inline) {
      const error = inline.status === 'valid' ? validateHookDocument(inline.document, schema) : null;
      sources.push(error ? { ...inline, status: 'invalid', error: `hook schema failed: ${error}` } : inline);
    }
  }
  const plugins = inspectCodexPlugins({
    configFile: path.join(codexHome, 'config.toml'),
    cacheDir: pluginCacheDir,
  });
  for (const plugin of plugins.plugins) {
    for (const file of plugin.hookFiles) {
      const source = readHookSource(file, {
        kind: 'plugin-cache', pluginRef: plugin.ref, pluginVersion: plugin.version,
      }, plugin.root, schema);
      if (source) sources.push(source);
    }
    for (const [index, document] of (plugin.inlineHookDocuments ?? []).entries()) {
      const schemaError = validateHookDocument(document, schema);
      sources.push(schemaError ? {
        kind: 'plugin-cache-inline', pluginRef: plugin.ref, pluginVersion: plugin.version,
        file: `${plugin.manifestFile ?? `${plugin.root}/.codex-plugin/plugin.json`}#hooks/${index}`, status: 'invalid', error: schemaError,
      } : {
        kind: 'plugin-cache-inline', pluginRef: plugin.ref, pluginVersion: plugin.version,
        file: `${plugin.manifestFile ?? `${plugin.root}/.codex-plugin/plugin.json`}#hooks/${index}`, status: 'valid',
        digest: sha256(stableJson(document)), document, baseDir: plugin.root,
      });
    }
  }

  sources.sort((a, b) => a.file.localeCompare(b.file));
  const records = sources.flatMap((source) => recordsFromSource(source, codexVersion, schema))
    .sort((a, b) => a.source.file.localeCompare(b.source.file)
      || a.event.localeCompare(b.event)
      || a.indices.group - b.indices.group
      || a.indices.hook - b.indices.hook);
  const plan = planFor(records);
  const pluginIssues = plugins.hookIssues ?? plugins.issues;
  const publicSources = sources.map((source) => {
    const result = { ...source };
    delete result.document;
    return result;
  });
  return {
    schemaVersion: 1,
    mode: 'read-only',
    hostSchema: schema,
    sources: publicSources,
    records,
    plan,
    pluginIssues,
    coverage: {
      status: 'partial',
      gaps: [
        'Trust hashes and project trust are intentionally not inferred',
        'Managed requirements and session override layers require explicit paths when they are outside the inspected user/project roots',
      ],
    },
    summary: {
      sources: sources.length,
      invalidSources: sources.filter((source) => source.status !== 'valid').length,
      configurationIssues: pluginIssues.length,
      hookOccurrences: records.length,
      uniqueBehaviors: new Set(records.map((record) => record.behaviorFingerprint)).size,
      compatibilityWarnings: records.filter((record) => record.diagnostics.some((d) => d.category === 'compatibility')).length,
      automaticActions: plan.filter((action) => action.classification === 'automatic').length,
      approvalRequiredActions: plan.filter((action) => action.classification === 'approval-required').length,
      neverAutomaticActions: plan.filter((action) => action.classification === 'never-automatic').length,
    },
  };
}
