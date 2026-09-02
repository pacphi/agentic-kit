import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_AUDIT_SOURCE_BYTES = 2 * 1024 * 1024;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const isRecord = (value) => Boolean(value) && !Array.isArray(value) && typeof value === 'object';

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export const stableJson = (value) => JSON.stringify(stableValue(value));

function contained(realRoot, realFile) {
  return realFile === realRoot || realFile.startsWith(`${realRoot}${path.sep}`);
}

/** Read a bounded regular file without following a final symlink. */
/** @returns {any} */
export function readBoundedFile(file, containmentRoot, maxBytes = MAX_AUDIT_SOURCE_BYTES) {
  let descriptor;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: 'refused', error: 'source must be a regular non-symlink file' };
    }
    if (stat.size > maxBytes) return { status: 'refused', error: `source exceeds ${maxBytes} byte limit` };
    const realRoot = fs.realpathSync(containmentRoot);
    const realFile = fs.realpathSync(file);
    if (!contained(realRoot, realFile)) {
      return { status: 'refused', error: 'source escapes its containment root through a symlinked ancestor' };
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    descriptor = fs.openSync(file, flags);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes) {
      return { status: 'refused', error: 'opened source is not a bounded regular file' };
    }
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      return { status: 'refused', error: 'source identity changed between inspection and open' };
    }
    const reopenedRealFile = fs.realpathSync(file);
    if (reopenedRealFile !== realFile || !contained(realRoot, reopenedRealFile)) {
      return { status: 'refused', error: 'source path changed between inspection and open' };
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length) return { status: 'invalid', error: 'source changed while it was read' };
    return { status: 'valid', bytes, text: bytes.toString('utf8'), digest: sha256(bytes) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent' };
    return { status: 'invalid', error: error?.message ?? String(error) };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** @returns {any} */
export function readJsonSource(file, containmentRoot, metadata = {}) {
  const read = readBoundedFile(file, containmentRoot);
  if (read.status === 'absent') return null;
  if (read.status !== 'valid') return { ...metadata, file, ...read };
  try {
    return { ...metadata, file, status: 'valid', digest: read.digest, document: JSON.parse(read.text) };
  } catch (error) {
    return { ...metadata, file, status: 'invalid', digest: read.digest, error: `JSON parse failed: ${error.message}` };
  }
}

const SECRET_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL)[A-Z0-9_]*)=([^\s]+)/gi;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

export function redactCommand(value) {
  if (typeof value !== 'string') return '';
  return value.replace(SECRET_ASSIGNMENT, '$1=<redacted>').replace(BEARER, '$1<redacted>');
}

export function commandFacts(command) {
  const normalized = typeof command === 'string' ? command.trim() : '';
  const redacted = redactCommand(normalized);
  return {
    normalized: redacted,
    digest: sha256(normalized),
    shell: /(?:^|[\s/])(?:env\s+)?(?:sh|bash|zsh|fish|cmd(?:\.exe)?|powershell|pwsh)(?:\s|$)|(?:&&|\|\||[|;<>`])/i.test(normalized),
    projectDirReferences: [...new Set(normalized.match(/\$\{?[A-Z][A-Z0-9_]+/g) ?? [])].sort(),
    redacted: redacted !== normalized,
  };
}

export function sideEffectHints(command) {
  const normalized = typeof command === 'string' ? command.trim() : '';
  const hints = [];
  if (/\bnpx\b/.test(normalized)) hints.push('package-resolution-or-network-possible');
  if (/\b(?:gh|curl|wget)\b/.test(normalized)) hints.push('network-possible');
  if (/\.claude-flow|\.swarm|auto-memory|session-end|post-(?:edit|task|command)/.test(normalized)) hints.push('state-write-possible');
  if (/\b(?:rm|unlink|kill|shutdown)\b/.test(normalized)) hints.push('destructive-process-or-file-action-possible');
  return hints.length ? hints : ['unknown-inspect-implementation'];
}

export function publicSource(source) {
  const result = { ...source };
  delete result.document;
  delete result.text;
  return result;
}

export function summarizeHostReport({ sources, records, plan, issues = [], coverage }) {
  return {
    sources: sources.length,
    invalidSources: sources.filter((source) => !['valid', 'opaque'].includes(source.status)).length,
    configurationIssues: issues.length,
    hookOccurrences: records.length,
    uniqueBehaviors: new Set(records.map((record) => record.behaviorFingerprint)).size,
    automaticActions: plan.filter((action) => action.classification === 'automatic-eligible').length,
    approvalRequiredActions: plan.filter((action) => action.classification === 'approval-required').length,
    neverAutomaticActions: plan.filter((action) => action.classification === 'prohibited').length,
    upstreamRequiredActions: plan.filter((action) => action.classification === 'upstream-required').length,
    coverage,
  };
}

function materialHandler(handler, command, source) {
  return stableValue({
    commandDigest: command ? sha256(command) : null,
    commandWindowsDigest: handler.commandWindows ? sha256(handler.commandWindows) : null,
    server: handler.server ?? null,
    tool: handler.tool ?? null,
    input: handler.input ?? null,
    async: handler.async ?? false,
    statusMessage: handler.statusMessage ?? null,
    additionalContextLimit: handler.additionalContextLimit ?? null,
    cwd: handler.cwd ?? source.baseDir ?? null,
  });
}

function publicHandler(handler) {
  return {
    server: handler.server ?? null,
    tool: handler.tool ?? null,
    inputDigest: handler.input === undefined ? null : sha256(stableJson(handler.input)),
    async: handler.async ?? false,
    statusMessage: handler.statusMessage ?? null,
    additionalContextLimit: handler.additionalContextLimit ?? null,
  };
}

/**
 * @param {{host:string,event:string,matcher?:string,type?:string,
 * handler?:Record<string,any>,source:Record<string,any>,indices?:Record<string,number>,
 * timeout?:any,diagnostics?:any[],selected?:boolean|null,risk?:string}} input
 */
export function normalizedOccurrence({
  host, event, matcher = '', type = 'command', handler = {}, source, indices = {},
  timeout = null, diagnostics = [], selected = null, risk = 'HUMAN REVIEW REQUIRED',
} = /** @type {any} */ ({})) {
  const command = Array.isArray(handler.command) ? handler.command.join(' ') : handler.command ?? '';
  const material = {
    host, event, matcher, type,
    handler: materialHandler(handler, command, source),
    timeout,
  };
  const behaviorFingerprint = sha256(stableJson(material));
  return {
    schemaVersion: 2,
    host,
    event,
    matcher,
    type,
    indices,
    command: commandFacts(command),
    handler: publicHandler(handler),
    timeout,
    source,
    selected,
    sideEffects: sideEffectHints(command),
    risk,
    trust: {
      observedState: 'unknown',
      recommendation: 'HUMAN REVIEW REQUIRED',
      evidence: 'Audit evidence never establishes host trust or approval state',
    },
    rawFingerprint: sha256(stableJson(handler)),
    behaviorFingerprint,
    duplicateGroupId: behaviorFingerprint,
    diagnostics,
  };
}
