// Live-check evidence (decision 9a of the 2026-09-26 audit, #237 S4): the one
// store for what a LIVE check last found. `ak sync`'s embedding step and the
// `ak x verify` suites write it; the read-only `ak status` (and the dashboard,
// which renders status rows) read it and show each result with its age.
// Status never probes to fill it.
//
// One small JSON file per check id under `<stateBase>/agentic-kit/live-checks/`,
// next to ADR-0058's ruflo-components evidence cache. Per-id files mean two
// processes recording different checks at once (a sync and a verify, or the
// parallel checks of `ak status --live`) cannot lose each other's results.
//
// A record carries an `inputsKey`: a short hash of the configuration (and, for
// package-bound checks, the installed ruflo version) the check ran against.
// A reader with a different key gets the record back marked `invalidated`, so
// a configuration change clears the claim without status ever writing. A
// record older than the TTL is marked `stale`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import { writePrivateFileAtomic } from './file-write.mjs';
import { stripUnsafeChars } from './text-safety.mjs';
import { resolveAqeEmbedding } from './aqe-embedding-config.mjs';
import { warn } from './output.mjs';

/** The checks whose results are remembered: the quick, free live checks. */
export const LIVE_CHECK_IDS = Object.freeze(['aqe-embedding', 'mcp', 'providers', 'security', 'deja-vu', 'memory']);
const STATUSES = new Set(['passed', 'failed', 'inconclusive']);
const SOURCES = new Set(['sync', 'verify', 'status-live']);
/** Same window as ADR-0058's evidence (EVIDENCE_STALE_MS in ruflo-components/evidence.mjs). */
export const LIVE_CHECK_TTL_MS = 24 * 3600_000;
const REASON_MAX = 200;

/** `<stateBase>/agentic-kit/live-checks` — derived like ADR-0058's evidence file (apply.mjs). */
export const liveCheckDir = () => path.join(path.dirname(paths.maintenanceControlDir()), 'live-checks');
const fileFor = (id) => path.join(liveCheckDir(), `${id}.json`);

function assertKnownId(id) {
  if (!LIVE_CHECK_IDS.includes(id)) throw new TypeError(`unknown live check id: ${String(id).slice(0, 40)}`);
}

/** Printable, single-line, bounded. Stored reasons come from the kit's own
 *  messages and enumerated probe reasons, but are stripped at record time
 *  anyway so no render path has to be the only defence. */
function cleanReason(reason) {
  if (reason == null) return null;
  const text = stripUnsafeChars(reason).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
}

/**
 * Remember one live-check result. Invalid input is a programming error and
 * throws; an unwritable store returns false (the caller says so) and never
 * fails the sync or verify that produced the result.
 * @param {{id:string,status:string,reason?:string|null,source:string,inputsKey:string}} result
 * @param {{now?:number}} [options]
 * @returns {boolean}
 */
export function recordLiveCheck({ id, status, reason = null, source, inputsKey }, { now = Date.now() } = {}) {
  assertKnownId(id);
  if (!STATUSES.has(status)) throw new TypeError(`unknown live check status: ${String(status).slice(0, 40)}`);
  if (!SOURCES.has(source)) throw new TypeError(`unknown live check source: ${String(source).slice(0, 40)}`);
  if (typeof inputsKey !== 'string' || !inputsKey) throw new TypeError('live check inputsKey is required');
  const record = { version: 1, id, status, reason: cleanReason(reason), source,
    checkedAt: new Date(now).toISOString(), inputsKey };
  try {
    writePrivateFileAtomic(fileFor(id), `${JSON.stringify(record)}\n`);
    return true;
  } catch { return false; }
}

/**
 * The last remembered result for `id`, or null when there is none (or it is
 * unreadable). Never writes. `invalidated` is true when the caller's inputs key
 * differs from the one the check ran against; `stale` when older than `ttlMs`.
 * @param {string} id
 * @param {{inputsKey?:string,now?:number,ttlMs?:number}} [options]
 */
export function readLiveCheck(id, { inputsKey, now = Date.now(), ttlMs = LIVE_CHECK_TTL_MS } = {}) {
  assertKnownId(id);
  let record;
  try { record = JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); } catch { return null; }
  const checkedAtMs = Date.parse(record?.checkedAt);
  if (!STATUSES.has(record?.status) || !SOURCES.has(record?.source) || !Number.isFinite(checkedAtMs)) return null;
  const ageMs = Math.max(0, now - checkedAtMs);
  return {
    status: record.status,
    reason: typeof record.reason === 'string' ? cleanReason(record.reason) : null,
    source: record.source,
    checkedAt: new Date(checkedAtMs).toISOString(),
    ageMs,
    stale: ageMs > ttlMs,
    invalidated: inputsKey !== undefined && record.inputsKey !== inputsKey,
  };
}

// ── inputs keys ──────────────────────────────────────────────────────────────

/** Key-order-independent JSON, so an equal configuration always hashes equal. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value ?? null;
}
const digest = (parts) => crypto.createHash('sha256').update(JSON.stringify(stable(parts))).digest('hex').slice(0, 16);

function fileDigest(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

/** Installed ruflo version, or null. Must never throw: `globalRoot()` throws
 *  when npm is not on PATH (see ruflo-components/evidence.mjs). */
function rufloVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(paths.rufloRoot(), 'package.json'), 'utf8')).version ?? null; }
  catch { return null; }
}

/** The embedding check runs against the resolved backend: a managed selection
 *  pins the endpoint, while unmanaged mode probes the shell's endpoint. */
function embeddingInputs(cfg, env) {
  try {
    const resolved = resolveAqeEmbedding(cfg, env);
    return { aqe: cfg.aqe !== false, mode: resolved.mode,
      endpoint: resolved.env.AQE_EMBEDDER_ENDPOINT || null, provisioning: resolved.provisioning ?? null };
  } catch { return { invalid: true }; }
}

const INPUTS = {
  'aqe-embedding': ({ cfg, env }) => embeddingInputs(cfg, env),
  mcp: ({ cfg }) => ({ hosts: cfg.integrations?.hosts ?? null, codexConfig: fileDigest(paths.codexConfigPath()) }),
  providers: ({ cfg, cwd }) => ({ hosts: cfg.integrations?.hosts ?? null, providers: cfg.providers ?? null,
    aqe: cfg.aqe !== false, project: path.resolve(cwd) }),
  security: () => ({ ruflo: rufloVersion() }),
  'deja-vu': ({ cfg }) => ({ dejaVu: cfg.integrations?.tools?.dejaVu ?? null }),
  memory: () => ({ ruflo: rufloVersion() }),
};

/**
 * The inputs key a check ran against. Writers and readers MUST both call this
 * so the same configuration yields the same key. Never throws.
 * @param {string} id
 * @param {{cfg?:any,env?:NodeJS.ProcessEnv,cwd?:string}} [facts]
 */
export function liveCheckInputsKey(id, { cfg = {}, env = process.env, cwd = process.cwd() } = {}) {
  assertKnownId(id);
  let parts;
  try { parts = INPUTS[id]({ cfg: cfg ?? {}, env, cwd }); } catch { parts = { unavailable: true }; }
  return digest({ id, ...parts });
}

// ── writer helpers ───────────────────────────────────────────────────────────

const firstSentence = (text) => String(text ?? '').split(/\.\s/)[0].replace(/\.$/, '');

/** A `prepareAqeEmbedding` result as a live-check outcome, or null when no
 *  live request ran (unmanaged embeddings are skipped, not passed). Any
 *  non-pass is a failure — the same reading `ak sync` prints. */
export function embeddingCheckOutcome(result) {
  if (!result || result.status === 'skipped') return null;
  if (result.ok === true && result.status === 'ok') return { status: 'passed', reason: null };
  return { status: 'failed', reason: result.evidence?.reason ?? (firstSentence(result.detail) || 'embedding setup incomplete') };
}

/** A `probeAqeEmbeddings` result as a live-check outcome (verify's reading). */
export function embeddingProbeOutcome(live) {
  return live?.status === 'passed'
    ? { status: 'passed', reason: null }
    : { status: 'failed', reason: live?.reason ?? live?.status ?? 'embedding probe failed' };
}

/**
 * Record `outcome` for `id` against the caller's current inputs, and say so
 * when it could not be remembered. Returns whether it was recorded.
 * @param {string} id
 * @param {{status:string,reason?:string|null}|null} outcome
 * @param {{source:string,cfg?:any,env?:NodeJS.ProcessEnv,cwd?:string,now?:number}} context
 */
export function rememberLiveCheck(id, outcome, { source, cfg, env, cwd, now } = /** @type {any} */ ({})) {
  if (!outcome) return false;
  const recorded = recordLiveCheck({ id, status: outcome.status, reason: outcome.reason ?? null, source,
    inputsKey: liveCheckInputsKey(id, { cfg, env, cwd }) }, { now });
  if (!recorded) warn(`${id}: could not remember this live check result; ak status will not show it`);
  return recorded;
}

// ── reader helpers ───────────────────────────────────────────────────────────

/** Human age: "just now", "5m ago", "3h ago", "2d ago". */
export function formatLiveCheckAge(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const SOURCE_LABEL = { sync: 'ak sync', verify: 'ak x verify', 'status-live': 'ak status --live' };

/**
 * One status clause for a remembered result. An invalidated result shows no
 * verdict or reason: it describes a configuration that no longer applies.
 * @param {ReturnType<typeof readLiveCheck>} evidence
 * @param {{recheck:string}} options  the command that re-runs this check
 */
export function describeLiveCheck(evidence, { recheck }) {
  const age = formatLiveCheckAge(evidence.ageMs);
  if (evidence.invalidated) return `configuration changed since the last live check (${age}); re-check with ${recheck}`;
  const reason = evidence.status !== 'passed' && evidence.reason ? `: ${evidence.reason}` : '';
  const stale = evidence.stale ? `; stale, re-check with ${recheck}` : '';
  return `last live check ${evidence.status} ${age} (${SOURCE_LABEL[evidence.source]})${reason}${stale}`;
}

/**
 * Row level for a remembered result. A failure is a warning (as in sync and
 * ADR-0055) — never `fail`, which sync's convergence proof counts — and stays a
 * warning when stale, because nothing has shown it was fixed. Only a fresh,
 * still-applicable pass is green; a stale pass is information.
 * @param {ReturnType<typeof readLiveCheck>} evidence
 */
export function liveCheckLevel(evidence) {
  if (evidence.invalidated) return 'info';
  if (evidence.status === 'failed') return 'warn';
  return evidence.status === 'passed' && !evidence.stale ? 'ok' : 'info';
}
