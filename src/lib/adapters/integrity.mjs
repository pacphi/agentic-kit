// Adapter content identity and hook-file integrity (ADR-0029/0031).
// Manifest consent alone cannot pin a file-backed hook: the manifest can stay
// byte-identical while the script it names changes. This module keeps the
// existing manifest hash as the base identity and adds deterministic,
// per-relative-file SHA-256 digests when a hook declares adapter-owned files.
// It deliberately does not attempt to discover a language's transitive
// imports; adapter authors must declare every adapter-owned file they execute.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_LIKE_RE = /\.(?:mjs|cjs|js|ts|py|rb|sh|pl|exe|bat|cmd|com|ps1)$/i;
const SCRIPT_SOURCE_RE = /\.(?:mjs|cjs|js|ts|py|rb|sh|pl|ps1)$/i;
export const MAX_ADAPTER_HOOK_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ADAPTER_HOOK_BUNDLE_BYTES = 8 * 1024 * 1024;

export class AdapterIntegrityError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'AdapterIntegrityError';
    this.reason = reason;
  }
}

/** The adapter directory for a persisted local manifest, or null for a
 * source whose bundle is not retained locally. A failed realpath is honest
 * null: callers must refuse path-backed hooks rather than guessing cwd. */
export function baseDirForSource(source) {
  if (typeof source !== 'string' || !source
    || source.startsWith('https://') || source.startsWith('http://') || source.startsWith('npm:')) {
    return null;
  }
  try {
    return path.dirname(fs.realpathSync(source));
  } catch {
    return null;
  }
}

/** Deterministic, locale-independent JSON used by the existing manifest
 * consent hash and by the combined adapter-content hash below. */
export function canonicalizeManifest(value) {
  return JSON.stringify(value, (_key, val) => (
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val
  ));
}

export function hashManifest(value) {
  return createHash('sha256').update(canonicalizeManifest(value)).digest('hex');
}

function hookEntries(manifest) {
  const entries = [];
  for (const [verb, definition] of Object.entries(manifest?.lifecycle ?? {})) {
    if (definition?.hook) entries.push({ label: `lifecycle.${verb}`, hook: definition.hook });
  }
  const executionHook = manifest?.execution?.run?.hook;
  if (executionHook) entries.push({ label: 'execution.run', hook: executionHook });
  const aqeProviderHook = manifest?.aqe?.provider?.hook;
  if (aqeProviderHook) entries.push({ label: 'aqe.provider', hook: aqeProviderHook });
  return entries;
}

function normaliseHookFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new AdapterIntegrityError('invalid-hook-file', 'hook.files entries must be non-empty relative paths');
  }
  const portable = value.replaceAll('\\', '/');
  const normalised = path.posix.normalize(portable);
  if (path.posix.isAbsolute(normalised) || path.win32.isAbsolute(value)
    || normalised === '.' || normalised === '..' || normalised.startsWith('../')) {
    throw new AdapterIntegrityError('invalid-hook-file', `'${value}' must stay below the manifest directory`);
  }
  return normalised;
}

/** Return one sorted, de-duplicated inventory of all declared hook files. */
export function declaredHookFiles(manifest) {
  const files = [];
  for (const { hook } of hookEntries(manifest)) {
    for (const file of hook.files ?? []) files.push(normaliseHookFile(file));
  }
  const unique = [...new Set(files)].sort();
  if (unique.length !== files.length) {
    throw new AdapterIntegrityError('invalid-hook-file', 'hook.files contains duplicate paths after normalization');
  }
  return unique;
}

function scriptPathToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const equals = token.indexOf('=');
  const value = equals >= 0 ? token.slice(equals + 1) : token;
  if (!value) return null;
  if (SCRIPT_LIKE_RE.test(value) || value.startsWith('./') || value.startsWith('../')
    || value.startsWith('.\\') || value.startsWith('..\\')) return value;
  return null;
}

function pathTokenForInventory(token, baseDir, { argv0 = false } = {}) {
  const value = scriptPathToken(token);
  if (!value) return null;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    // An absolute argv[0] ending in a native executable extension is an
    // installed interpreter/binary, not an adapter-owned hook file. Its
    // location is already explicit and does not resolve through cwd. This
    // keeps Windows `node.exe`/`hermes.exe` commands path-independent while
    // absolute script argv[0] values still go through the file inventory.
    if (argv0 && !SCRIPT_SOURCE_RE.test(value)) return null;
    if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) {
      throw new AdapterIntegrityError('hook-files-unavailable', `'${token}' is a path-backed hook but no retained adapter directory is available`);
    }
    const root = path.resolve(baseDir);
    const candidate = path.resolve(value);
    const outside = path.relative(root, candidate);
    if (outside === '..' || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside)) {
      throw new AdapterIntegrityError('invalid-hook-file', `'${token}' escapes the adapter directory`);
    }
    return normaliseHookFile(outside);
  }
  return normaliseHookFile(value);
}

/** Find script-like command arguments that must be covered by hook.files.
 * Inline evaluator source (`node -e <source>`) is manifest content already;
 * treating arbitrary strings inside that source as file paths would create
 * false positives and would not improve the manifest pin. */
function commandFileTokens(manifest, baseDir) {
  const tokens = [];
  for (const { label, hook } of hookEntries(manifest)) {
    const command = hook.command ?? [];
    for (let index = 0; index < command.length; index += 1) {
      if (index > 0 && ['-e', '--eval', '-p', '--print'].includes(command[index - 1])) continue;
      const relative = pathTokenForInventory(command[index], baseDir, { argv0: index === 0 });
      if (relative) tokens.push({ label, token: command[index], relative });
    }
  }
  return tokens;
}

function adapterFilePath(baseDir, relative) {
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) {
    throw new AdapterIntegrityError('hook-files-unavailable', 'file-backed hooks require an absolute adapter directory');
  }
  const root = path.resolve(baseDir);
  const candidate = path.resolve(root, ...relative.split('/'));
  const outside = path.relative(root, candidate);
  if (outside === '..' || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside)) {
    throw new AdapterIntegrityError('invalid-hook-file', `'${relative}' escapes the adapter directory`);
  }
  return candidate;
}

function isContained(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function digestFile(baseDir, relative, { fsImpl, maxFileBytes }) {
  const filename = adapterFilePath(baseDir, relative);
  let stat;
  let realRoot;
  let realFile;
  try {
    stat = fsImpl.lstatSync(filename);
    realRoot = fsImpl.realpathSync(baseDir);
    realFile = fsImpl.realpathSync(filename);
  } catch (error) {
    throw new AdapterIntegrityError('hook-file-unreadable', `'${relative}' could not be read: ${error?.message ?? String(error)}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AdapterIntegrityError('hook-file-not-regular', `'${relative}' is not a regular file`);
  }
  if (!isContained(realRoot, realFile)) {
    throw new AdapterIntegrityError('invalid-hook-file', `'${relative}' escapes the real adapter directory`);
  }
  if (stat.size > maxFileBytes) {
    throw new AdapterIntegrityError('hook-file-too-large', `'${relative}' exceeds the ${maxFileBytes} byte limit`);
  }
  let descriptor;
  try {
    descriptor = fsImpl.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fsImpl.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxFileBytes) {
      throw new AdapterIntegrityError('hook-file-not-regular', `'${relative}' is not a bounded regular file`);
    }
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new AdapterIntegrityError('hook-file-changed', `'${relative}' changed between inspection and open`);
    }
    if (fsImpl.realpathSync(filename) !== realFile) {
      throw new AdapterIntegrityError('hook-file-changed', `'${relative}' changed path between inspection and open`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fsImpl.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fsImpl.fstatSync(descriptor);
    if (offset !== bytes.length || after.size !== opened.size || after.dev !== opened.dev
        || after.ino !== opened.ino || after.mtimeMs !== opened.mtimeMs) {
      throw new AdapterIntegrityError('hook-file-changed', `'${relative}' changed while it was read`);
    }
    return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  } catch (error) {
    if (error instanceof AdapterIntegrityError) throw error;
    throw new AdapterIntegrityError('hook-file-unreadable', `'${relative}' could not be read: ${error?.message ?? String(error)}`);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

/** Compute the content identity used by consent and grants. */
/** @param {any} manifest @param {{baseDir?: string|null,fsImpl?:typeof fs,maxFileBytes?:number,maxTotalBytes?:number}} [options] */
export function hashAdapterContent(manifest, {
  baseDir, fsImpl = fs, maxFileBytes = MAX_ADAPTER_HOOK_FILE_BYTES,
  maxTotalBytes = MAX_ADAPTER_HOOK_BUNDLE_BYTES,
} = {}) {
  const manifestHash = hashManifest(manifest);
  const files = declaredHookFiles(manifest);
  const commandFiles = commandFileTokens(manifest, baseDir);

  if (files.length > 0 || commandFiles.length > 0) {
    if (baseDir == null) {
      throw new AdapterIntegrityError(
        'hook-files-unavailable',
        'path-backed adapter hooks require a retained local bundle; remote sources may use PATH binaries or inline commands only',
      );
    }
    const inventory = new Set(files);
    for (const item of commandFiles) {
      if (!inventory.has(item.relative)) {
        throw new AdapterIntegrityError(
          'hook-file-not-declared',
          `${item.label} command references '${item.token}' but hook.files does not declare '${item.relative}'`,
        );
      }
    }
  }

  let totalBytes = 0;
  const hookFiles = files.map((relative) => {
    const digest = digestFile(baseDir, relative, { fsImpl, maxFileBytes });
    totalBytes += digest.size;
    if (totalBytes > maxTotalBytes) {
      throw new AdapterIntegrityError('hook-bundle-too-large', `declared hook files exceed the ${maxTotalBytes} byte bundle limit`);
    }
    return { path: relative, sha256: digest.sha256, size: digest.size };
  });
  const hash = hookFiles.length
    // Preserve the v1 consent identity. Size is enforcement evidence, not a
    // hash-shape migration that would silently invalidate existing consent.
    ? hashManifest({ manifest, hookFiles: hookFiles.map(({ path: file, sha256 }) => ({ path: file, sha256 })) })
    : manifestHash;
  return { hash, manifestHash, hookFiles };
}

/** Re-read the declared files immediately before spawning. This closes the
 * trust gap Adrian identified; it is intentionally a pre-spawn check, not a
 * claim of race-free snapshotting. Immutable retained bundles are a later
 * option if the contract needs stronger TOCTOU guarantees. */
/** @param {any} manifest @param {{hash: string}} integrity @param {{baseDir?: string|null}} [options] */
export function verifyAdapterContent(manifest, integrity, { baseDir } = {}) {
  if (!integrity || typeof integrity.hash !== 'string' || !integrity.hash) {
    throw new AdapterIntegrityError('integrity-missing', 'admitted adapter has no content identity');
  }
  const current = hashAdapterContent(manifest, { baseDir });
  if (current.hash !== integrity.hash) {
    throw new AdapterIntegrityError(
      'hook-content-changed',
      `declared hook content changed after consent (expected ${integrity.hash}, found ${current.hash})`,
    );
  }
  return current;
}
