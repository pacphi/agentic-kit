// ADR-0048 provider-and-action-policy.md "Managed model removal" (MNT-MDL-*).
// Removes exactly one provider-owned local Ollama model per action, using
// only bounded loopback HTTP reads (`/api/tags`, `/api/ps`) and the
// provider-native `ollama rm` verb. It never elevates privilege and never
// crosses a host/WSL boundary.
//
// The finding this provider consumes must carry `consumers: { complete, list }`
// enumerating every route/runtime consumer of the model (MNT-MDL-003) and,
// when the caller supplies a `modelSnapshot.blobSharing` map, the shared-blob
// count for the model's digest (MNT-MDL-004). Without that evidence the
// physically-reclaimable-bytes premise cannot be proven, so this provider
// refuses to produce a Managed action at all — it does not guess (see
// `INCOMPLETE_SOURCE_FORBIDDEN_CLAIMS` in management/model.mjs).
import os from 'node:os';

import { runNativeCommand } from '../native-command.mjs';
import { baseAction, executableSafetyClass, sha256 } from './shared.mjs';

const SAFE_MODEL_NAME_MAX = 256;
const DIGEST = /^(?:sha256:)?[a-f0-9]{6,128}$/i;
const MAX_RESPONSE_BYTES = 256 * 1024;
// Registered by default (see provider-registry.mjs): kept short so an
// absent or slow Ollama daemon never meaningfully delays an ordinary scan
// or report(). /api/tags and /api/ps run concurrently in detect(), so this
// is also the worst-case wall-clock bound for the whole detect() call.
const FETCH_TIMEOUT_MS = 1_000;
const PROVIDER_ID = 'ollama-model';
const PROVIDER_VERSION = 'v1';

function safeModelName(value) {
  if (typeof value !== 'string' || !value.length || value.length > SAFE_MODEL_NAME_MAX) return null;
  // resourceIdentity fields forbid "/" and "\\" (planner.mjs SAFE_VALUE); a
  // namespaced model name ("org/model") cannot be represented, so it is
  // simply excluded from `facts.tags` and stays report-only.
  if (/[\0\r\n/\\]/.test(value)) return null;
  return value;
}

function loopbackBase(value) {
  const url = new URL(value ?? 'http://127.0.0.1:11434');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new TypeError('the Ollama endpoint must be loopback HTTP');
  }
  return url;
}

async function fetchJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response?.ok) return { ok: false, reason: `http-${response?.status ?? 'failure'}` };
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) return { ok: false, reason: 'response-too-large' };
    try {
      return { ok: true, value: JSON.parse(Buffer.from(buffer).toString('utf8')) };
    } catch {
      return { ok: false, reason: 'invalid-json' };
    }
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'fetch-failed' };
  } finally {
    clearTimeout(timer);
  }
}

function unavailableFacts() {
  return {
    status: 'unavailable', complete: false, authority: 'ollama-api', asOf: null, tags: [], loaded: [],
  };
}

function tagsFrom(value) {
  const rows = Array.isArray(value?.models) ? value.models : null;
  if (!rows) return null;
  return rows.flatMap((row) => {
    const name = safeModelName(row?.name ?? row?.model);
    const digest = typeof row?.digest === 'string' ? row.digest : null;
    if (!name || !digest || !DIGEST.test(digest)) return [];
    return [{ name, digest, sizeBytes: Number.isFinite(row?.size) ? row.size : null }];
  });
}

function loadedFrom(value) {
  const rows = Array.isArray(value?.models) ? value.models : [];
  return rows.flatMap((row) => {
    const name = safeModelName(row?.name ?? row?.model);
    return name ? [{ name }] : [];
  });
}

const sourceFingerprint = (name, digest) => sha256({ provider: `${PROVIDER_ID}/${PROVIDER_VERSION}`, name, digest });
const absentFingerprint = (name) => sha256({ provider: `${PROVIDER_ID}/${PROVIDER_VERSION}`, name, state: 'absent' });

/** Distinguish logical (declared) size from physically reclaimable bytes,
 * accounting for shared blobs (MNT-MDL-004). Returns `{ complete: false }`
 * when the caller has not supplied enough evidence to prove the number —
 * the caller must then treat this model as report-only, not Managed. */
function computeReclaim(tag, modelSnapshot) {
  const logicalBytes = Number.isFinite(tag.sizeBytes) ? tag.sizeBytes : null;
  const sharedCount = modelSnapshot?.blobSharing?.[tag.digest];
  if (logicalBytes == null || !Number.isFinite(sharedCount) || sharedCount < 1) return { complete: false };
  const physicalBytes = sharedCount > 1 ? 0 : logicalBytes;
  return {
    complete: true, logicalBytes, physicalBytes, sharedBlobs: Math.max(0, sharedCount - 1),
  };
}

function routesReferencing(routes, name) {
  return (Array.isArray(routes) ? routes : []).filter((route) => route?.model === name);
}

function consumersComplete(finding, liveRoutes) {
  if (finding?.consumers?.complete !== true) return false;
  const list = Array.isArray(finding.consumers.list) ? finding.consumers.list : [];
  return liveRoutes.every((route) => list.some((consumer) => consumer?.id === route.route));
}

function actionRequest(finding) {
  const resource = finding?.resource ?? finding?.resourceIdentity;
  const name = safeModelName(resource?.id ?? resource?.name);
  const eligible = name
    && resource?.kind === 'model' && resource.host === 'ollama'
    && finding?.nextAction?.operation === 'remove'
    && executableSafetyClass(finding?.safetyClass);
  return eligible ? { resource, name } : null;
}

/** @param {{ run?: any, fetchImpl?: any, baseUrl?: string, modelSnapshot?: any, routes?: Array<{route:string,model:string}>, now?: () => number }} options */
export function createOllamaModelRemoveProvider({
  run = runNativeCommand, fetchImpl = globalThis.fetch, baseUrl = 'http://127.0.0.1:11434',
  modelSnapshot = null, routes = [], now = Date.now,
} = {}) {
  async function detect() {
    let base;
    try { base = loopbackBase(baseUrl); } catch { return unavailableFacts(); }
    // Concurrent, each individually deadline-bounded: this provider is
    // registered by default, so an absent/slow Ollama daemon must never add
    // more than one short, bounded round trip to an ordinary scan — never
    // the sum of two sequential ones.
    const [tagsResult, psResult] = await Promise.all([
      fetchJson(fetchImpl, new URL('/api/tags', base), { method: 'GET' }, FETCH_TIMEOUT_MS),
      fetchJson(fetchImpl, new URL('/api/ps', base), { method: 'GET' }, FETCH_TIMEOUT_MS),
    ]);
    if (!tagsResult.ok) return unavailableFacts();
    const tags = tagsFrom(tagsResult.value);
    if (!tags) return unavailableFacts();
    const loaded = psResult.ok ? loadedFrom(psResult.value) : [];
    const rawCount = Array.isArray(tagsResult.value?.models) ? tagsResult.value.models.length : 0;
    return {
      status: 'available', complete: rawCount === tags.length && psResult.ok,
      authority: 'ollama-api', asOf: new Date(now()).toISOString(), tags, loaded,
    };
  }

  function actionFor(finding, facts) {
    const request = actionRequest(finding);
    if (!request || facts?.status !== 'available' || facts.complete !== true) return null;
    const tag = facts.tags.find((row) => row.name === request.name);
    if (!tag) return null;
    if (finding?.expectedDigest && finding.expectedDigest !== tag.digest) return null;
    if (facts.loaded.some((row) => row.name === request.name)) return null;
    const liveRoutes = routesReferencing(routes, request.name);
    if (!consumersComplete(finding, liveRoutes)) return null;
    const reclaim = computeReclaim(tag, modelSnapshot);
    if (!reclaim.complete) return null;
    // The legacy finding/action impact schema carries one `bytes` number, not
    // a distinct logical/physical pair (MNT-MDL-004), so the physically
    // reclaimable figure — the number that matters for "how much disk space
    // this actually frees" — is what `bytes` reports; the shared-blob nuance
    // is stated in `summary` for the reader.
    const sharingNote = reclaim.sharedBlobs > 0
      ? ` Its content is shared with ${reclaim.sharedBlobs} other model(s), so only ${reclaim.physicalBytes} of its ${reclaim.logicalBytes} logical bytes are actually reclaimed.`
      : '';
    const enrichedFinding = {
      ...finding,
      impact: {
        ...(finding.impact ?? {}),
        summary: `Removes the local Ollama model "${request.name}". Redownload is required to use it again.${sharingNote}`,
        bytes: reclaim.physicalBytes,
      },
    };
    return baseAction(enrichedFinding, {
      providerId: PROVIDER_ID, providerVersion: PROVIDER_VERSION, operation: 'remove',
      sourceFingerprint: sourceFingerprint(request.name, tag.digest), rollback: 'irreversible', restart: 'not-required',
    });
  }

  async function preflight(action) {
    const name = safeModelName(action?.resourceIdentity?.name);
    if (!name || action?.operation !== 'remove') return { ok: false, sourceFingerprint: null };
    const facts = await detect();
    if (facts.status !== 'available' || facts.complete !== true) return { ok: false, sourceFingerprint: null };
    const tag = facts.tags.find((row) => row.name === name);
    if (!tag || facts.loaded.some((row) => row.name === name)) return { ok: false, sourceFingerprint: null };
    const fingerprint = sourceFingerprint(name, tag.digest);
    return { ok: fingerprint === action.sourceFingerprint, sourceFingerprint: fingerprint };
  }

  async function apply(action) {
    const name = safeModelName(action?.resourceIdentity?.name);
    if (!name || action?.operation !== 'remove') {
      return { status: 'refused', summary: 'Model identity is invalid.' };
    }
    const result = await run('ollama', ['rm', name], {
      cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    if (!result.ok) {
      return {
        status: result.timedOut ? 'unknown' : 'unknown',
        summary: 'Ollama did not confirm the removal.',
        ...(Number.isInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
      };
    }
    return { status: 'applied', postFingerprint: absentFingerprint(name), summary: 'Ollama accepted the removal.' };
  }

  async function verify(action, outcome) {
    const name = safeModelName(action?.resourceIdentity?.name);
    const facts = await detect();
    const absent = facts.status === 'available' && facts.complete === true
      && !facts.tags.some((row) => row.name === name);
    const postFingerprint = absent ? absentFingerprint(name) : null;
    return { ok: Boolean(absent) && postFingerprint === outcome?.postFingerprint, postFingerprint };
  }

  async function inspectCurrent(entry) {
    const name = safeModelName(entry?.resourceIdentity?.name);
    const facts = await detect();
    if (facts.status !== 'available' || facts.complete !== true) return { complete: false, postFingerprint: null };
    const tag = facts.tags.find((row) => row.name === name);
    return {
      complete: true,
      postFingerprint: tag ? sourceFingerprint(name, tag.digest) : absentFingerprint(name),
    };
  }

  return {
    id: PROVIDER_ID, version: PROVIDER_VERSION, resourceKinds: ['model'], operations: ['remove'],
    rollback: ['irreversible'], network: 'loopback-only', privilege: 'none',
    detect, actionFor, preflight, apply, verify, inspectCurrent,
  };
}
