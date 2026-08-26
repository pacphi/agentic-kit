// Earned Agentic-QE external-provider bridge (AQE ADR-127 / issue #628).
//
// A manifest may declare a provider CANDIDATE as data, but it never executes
// directly and never self-activates. bootstrapHostAdapters registers a
// candidate here only after admission, explicit host enablement, and a live
// hash-pinned aqeProvider grant. AQE invokes the stable agentic-kit trampoline;
// the trampoline resolves this process-local registry and runs the real hook
// through runAdapterHook's integrity, cwd, environment, timeout, output-cap,
// and process-group controls.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAdapterHook } from './hook-runner.mjs';
import { immutable } from './schema.mjs';
import { verifyAdapterContent } from './integrity.mjs';

const DEFAULT_MODEL = 'default';
const DEFAULT_MAX_CONCURRENCY = 2;
const OUTER_TIMEOUT_MARGIN_MS = 2_500;
const MAX_PROMPT_BYTES = 1024 * 1024;
const PROBE_PROMPT = 'Reply with exactly: OK';
const CLI_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bin/agentic-kit.mjs');

let providers = new Map();

function requireManifest(manifest) {
  const id = manifest?.host?.id;
  const provider = manifest?.aqe?.provider;
  if (typeof id !== 'string' || !id || !provider?.hook) {
    throw new TypeError('AQE provider bridge requires a validated manifest with host.id and aqe.provider.hook');
  }
  return { id, provider };
}

function publicIntegrity(integrity) {
  return {
    hash: integrity.hash,
    manifestHash: integrity.manifestHash ?? null,
    hookFiles: (integrity.hookFiles ?? []).map((file) => ({ path: file.path, sha256: file.sha256 })),
  };
}

function providerMetadata(id, provider) {
  const models = [...(provider.models ?? [DEFAULT_MODEL])];
  const defaultModel = provider.defaultModel ?? models[0] ?? DEFAULT_MODEL;
  return {
    billingMode: provider.billingMode ?? 'metered-api',
    models,
    defaultModel,
    maxConcurrency: provider.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    stripEnv: [...(provider.stripEnv ?? [])],
    displayName: provider.displayName ?? id,
    ...(provider.hook.timeoutMs === undefined
      ? {}
      : { timeoutMs: provider.hook.timeoutMs + OUTER_TIMEOUT_MARGIN_MS }),
  };
}

function publicRecord(record) {
  return immutable({
    id: record.id,
    hostId: record.id,
    contentHash: record.contentHash,
    integrity: publicIntegrity(record.integrity),
    provider: providerMetadata(record.id, record.provider),
  });
}

/** Register one already-admitted, currently-granted provider. This function
 * cannot perform admission or grant lookup itself; its sole production caller
 * is bootstrapHostAdapters, which owns those gates. It does re-verify the
 * content immediately so a file edit between admission and registration
 * cannot create a live bridge.
 * @param {any} manifest
 * @param {{baseDir?:string|null, integrity?:any, contentHash?:string}} [options] */
export function registerAdmittedAqeProvider(manifest, {
  baseDir = null, integrity, contentHash,
} = {}) {
  const { id, provider } = requireManifest(manifest);
  if (!integrity || typeof integrity.hash !== 'string' || !integrity.hash) {
    throw new TypeError(`AQE provider '${id}' registration requires admission integrity`);
  }
  const expectedHash = contentHash ?? integrity.hash;
  if (expectedHash !== integrity.hash) {
    throw new TypeError(`AQE provider '${id}' content hash does not match admission integrity`);
  }
  verifyAdapterContent(manifest, integrity, { baseDir });
  const argv0 = provider.hook.command[0];
  if (baseDir == null && (argv0.includes('/') || argv0.includes('\\')) && !path.isAbsolute(argv0)) {
    throw new TypeError(`AQE provider '${id}' has a relative hook command but no retained adapter directory`);
  }
  const record = {
    id, manifest, provider, baseDir, integrity, contentHash: expectedHash,
  };
  providers.set(id, record);
  return publicRecord(record);
}

export function resetAdmittedAqeProviders() {
  providers = new Map();
}

/** Public, immutable provider receipts. Manifest and base-directory internals
 * stay private; projection consumers get only identity, integrity provenance,
 * and AQE-safe metadata. */
export function admittedAqeProviders() {
  return Object.freeze([...providers.values()].map(publicRecord));
}

export function admittedAqeProviderFor(id) {
  const record = providers.get(id);
  return record ? publicRecord(record) : null;
}

/** AQE v3.13.12 externalProviders declarations for the currently-live set. */
export function projectedAqeExternalProviders({ projectRoot = process.cwd() } = {}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new TypeError('AQE external-provider projection requires an absolute project root');
  }
  const out = Object.create(null);
  for (const record of providers.values()) {
    const meta = providerMetadata(record.id, record.provider);
    out[record.id] = {
      kind: 'cli',
      // Pin both sides of the invocation. The absolute, package-owned entrypoint
      // avoids PATH substitution; expected hash + project root ensure a stale
      // project declaration cannot silently execute newly-granted adapter bytes.
      command: [
        process.execPath, CLI_ENTRY, 'x', 'aqe-provider', record.id,
        '--expect-hash', record.contentHash,
        '--project-root', projectRoot,
      ],
      billingMode: meta.billingMode,
      models: [...meta.models],
      defaultModel: meta.defaultModel,
      modelFlag: '--model',
      maxConcurrency: meta.maxConcurrency,
      stripEnv: [...meta.stripEnv],
      displayName: meta.displayName,
      ...(meta.timeoutMs === undefined ? {} : { timeoutMs: meta.timeoutMs }),
    };
  }
  return immutable(out);
}

function selectedEnvironment(record, env, { model, projectRoot }) {
  const selected = {
    AK_AQE_PROVIDER: record.id,
    AK_AQE_MODEL: model,
    AK_AQE_PROJECT_CWD: projectRoot,
  };
  for (const name of record.provider.hook.passEnv ?? []) {
    if (typeof env?.[name] === 'string') selected[name] = env[name];
  }
  return selected;
}

function validateInvocation(record, {
  stdin, model, projectRoot, expectedHash,
}) {
  if (typeof stdin !== 'string') return 'AQE provider bridge requires a string prompt on stdin';
  if (Buffer.byteLength(stdin, 'utf8') > MAX_PROMPT_BYTES) {
    return `AQE provider prompt exceeds ${MAX_PROMPT_BYTES} bytes`;
  }
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    return 'AQE provider bridge requires an absolute project root';
  }
  if (expectedHash !== undefined && expectedHash !== record.contentHash) {
    return `AQE provider '${record.id}' content hash does not match projected ${String(expectedHash)}`;
  }
  const models = record.provider.models ?? [DEFAULT_MODEL];
  if (typeof model !== 'string' || !model || !models.includes(model)) {
    return `AQE provider '${record.id}' does not declare model '${String(model)}'`;
  }
  return null;
}

async function executeRecord(record, {
  stdin, model, projectRoot, expectedHash, timeoutMs, env = process.env,
}) {
  const problem = validateInvocation(record, {
    stdin, model, projectRoot, expectedHash,
  });
  if (problem) return { ok: false, stdoutText: '', stderrText: '', exitCode: null, detail: problem };
  const result = await runAdapterHook({
    hook: record.provider.hook,
    hostId: record.id,
    verb: 'aqe-provider',
    stdin,
    timeoutMs,
    env: selectedEnvironment(record, env, { model, projectRoot }),
    cwd: record.baseDir ?? projectRoot,
    manifest: record.manifest,
    integrity: record.integrity,
    baseDir: record.baseDir,
  });
  if (!result.ok) {
    return {
      ok: false,
      stdoutText: '',
      stderrText: result.stderrText ?? '',
      exitCode: result.exitCode,
      detail: (result.stderrText ?? '').trim() || result.detail || `AQE provider '${record.id}' failed`,
    };
  }
  return {
    ok: true,
    stdoutText: result.stdoutText ?? '',
    stderrText: result.stderrText ?? '',
    exitCode: result.exitCode,
    detail: null,
  };
}

/** Production execution surface. Absence means the adapter is not currently
 * admitted, enabled, and granted in this process; never fall back to a raw
 * manifest command.
 * @param {string} id
 * @param {{stdin?:string, model?:string, projectRoot?:string, timeoutMs?:number,
 *   expectedHash?:string, env?:NodeJS.ProcessEnv}} [options] */
export async function runAdmittedAqeProvider(id, {
  stdin, model, projectRoot = process.cwd(), expectedHash, timeoutMs, env = process.env,
} = {}) {
  const record = providers.get(id);
  if (!record) {
    return {
      ok: false, stdoutText: '', stderrText: '', exitCode: null,
      detail: `AQE provider '${String(id)}' is not active (admission, enablement, consent, or grant is missing/stale)`,
    };
  }
  const selectedModel = model ?? record.provider.defaultModel ?? record.provider.models?.[0] ?? DEFAULT_MODEL;
  return executeRecord(record, {
    stdin, model: selectedModel, projectRoot, expectedHash, timeoutMs, env,
  });
}

/** Evidence-first conformance seam. The caller must already have proven
 * admission and supplies that exact manifest/integrity; no registry or grant
 * is consulted. Execution is otherwise identical to production.
 * @param {{manifest?:any, baseDir?:string|null, integrity?:any,
 *   projectRoot?:string, timeoutMs?:number}} [options] */
export async function runAdmittedAqeProviderProbe({
  manifest, baseDir = null, integrity, projectRoot, timeoutMs,
} = {}) {
  const { id, provider } = requireManifest(manifest);
  if (!integrity || typeof integrity.hash !== 'string' || !integrity.hash) {
    return { ok: false, stdoutText: '', stderrText: '', exitCode: null, detail: `AQE provider '${id}' probe requires admission integrity` };
  }
  const record = { id, manifest, provider, baseDir, integrity, contentHash: integrity.hash };
  const model = provider.defaultModel ?? provider.models?.[0] ?? DEFAULT_MODEL;
  return executeRecord(record, {
    stdin: PROBE_PROMPT,
    model,
    projectRoot,
    expectedHash: undefined,
    timeoutMs,
    env: process.env,
  });
}
