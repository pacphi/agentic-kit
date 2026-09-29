// Provider-mediated quota reads (ADR-0010). The ONLY honest denominators for
// "how much of my plan have I used" are the vendors' own percentages, and both
// vendors expose them without ak ever touching a credential:
//
//   Claude — Claude Code PUSHES a `rate_limits` object (session/weekly/
//     per-model used-percentage + reset epochs) into every statusLine
//     invocation (code.claude.com/docs/en/statusline.md). The kit's managed
//     statusline tees that JSON to claude-rate-limits.json; this module only
//     READS the tee. Push, not pull: with no recent Claude session the file
//     goes stale, and staleness is REPORTED, never papered over.
//   Codex — `codex app-server` (JSON-RPC over stdio) answers
//     `account/rateLimits/read` using codex's own auth. ak spawns the vendor's
//     CLI read-only (same trust model as the dashboard's `ak status` shell-out)
//     and caches the normalized answer with a TTL.
//
// Explicit NON-paths, per the research behind ADR-0010: no `/api/oauth/usage`
// (undocumented; consumer-OAuth use outside Claude Code is ToS-prohibited and
// server-enforced), no Keychain/credentials reads, no chatgpt.com backend
// endpoints (private; requires bearer-token handling ak must not do).
//
// Labeling policy (F-10): any OTHER registry-managed host (adapters/
// registries.mjs) that the caller reports enabled gets an explicit
// `{ supported: false }` entry instead of being silently absent — this adds
// no channel and performs no probe, it only says "no quota surface exists
// for this host" so a user can tell that apart from "broken".
//
// Field-name trap, load-bearing: Codex's `primary`/`secondary` window fields do
// NOT reliably mean "5-hour"/"weekly" — a live prolite account answered with
// `primary.windowDurationMins = 10080` (the weekly) and `secondary = null`.
// Everything here therefore keys windows on their DURATION, never their slot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { configDir, claudeSettingsPath } from './paths.mjs';
import { managedHostIds } from './adapters/registries.mjs';
import { recordedHostPresence } from './providers.mjs';

export const claudeLimitsFile = () => path.join(configDir(), 'claude-rate-limits.json');
export const codexLimitsFile = () => path.join(configDir(), 'codex-rate-limits.json');

/** How long a cached Codex answer stays fresh, and how long a Claude tee stays
 *  fresh enough to show without a stale badge. Named because the UI's honesty
 *  ("as of Nm ago") depends on them. */
export const CODEX_TTL_MS = 5 * 60 * 1000;
export const CLAUDE_FRESH_MS = 10 * 60 * 1000;

// null/undefined must stay null — Number(null) is 0, and a null resets_at
// coerced to 0 would render as an epoch-1970 reset time.
const num = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** minutes → the label a person would use. Duration-derived, never slot-derived. */
export function windowLabel(minutes) {
  if (!Number.isFinite(minutes)) return 'window';
  if (minutes === 300) return '5h';
  if (minutes === 10080) return 'weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// ── Claude (statusline tee) ─────────────────────────────────────────────────

/**
 * Normalize the tee'd statusLine payload. The documented shape is
 * `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}` with
 * resets_at in EPOCH SECONDS; per-model weekly buckets (`seven_day_opus`, …)
 * appear for some plans, and each window may be independently absent. Pure;
 * returns null when there is nothing usable.
 */
export function normalizeClaudeLimits(raw) {
  const rl = raw?.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const KNOWN_MINUTES = { five_hour: 300, seven_day: 10080 };
  const windows = [];
  for (const [key, w] of Object.entries(rl)) {
    if (!w || typeof w !== 'object') continue;
    const usedPercent = num(w.used_percentage);
    if (usedPercent === null) continue;
    windows.push({
      id: key,
      label: key.startsWith('seven_day_')
        ? `weekly · ${key.slice('seven_day_'.length)}`
        : windowLabel(KNOWN_MINUTES[key] ?? NaN),
      usedPercent,
      windowMinutes: KNOWN_MINUTES[key] ?? (key.startsWith('seven_day') ? 10080 : null),
      resetsAt: num(w.resets_at),
    });
  }
  if (!windows.length) return null;
  return {
    provider: 'claude',
    source: 'statusline',
    fetchedAt: num(raw.teedAt) ?? null,
    sessionId: typeof raw.session_id === 'string' ? raw.session_id : null,
    windows,
  };
}

/** Read the statusline tee. Absent/unparseable → null (the UI's empty state
 *  explains how to produce one — run a Claude session with the managed
 *  statusline — rather than pretending the measurement failed). */
export function readClaudeLimits({ file = claudeLimitsFile() } = {}) {
  try { return normalizeClaudeLimits(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return null; }
}

// ── Claude tee channel (read-only; #238 M3) ─────────────────────────────────
//
// The tee exists only inside the kit footer that sync injects into a ruflo
// statusline helper (it needs that template's own stdin reader). Whether an
// empty Claude panel can ever fill therefore depends on which statusLine a
// session runs, and Claude Code resolves that by precedence: managed, then
// command line, then the project's .claude/settings.local.json, then its
// .claude/settings.json, then the user's ~/.claude/settings.json
// (code.claude.com/docs/en/settings). The dashboard cannot know which project
// the next session starts in, so it classifies the USER-level statusLine, the
// one every project without its own inherits, and lets the panel state the
// precedence rule beside the class.
//
// Read-only and path-free: this reads the settings file and, at most, the
// script files the command names (stat first; regular files under a size cap),
// and returns ONLY a class — never the command or a path. No file is written,
// so ADR-0010's single sanctioned channel is unchanged.

/** Every class classifyClaudeTeeChannel can return. */
export const CLAUDE_TEE_CHANNELS = Object.freeze(['none', 'kit-footer', 'project-helper', 'custom', 'unknown']);
const KIT_FOOTER_MARKER = 'ruflo-seg:BEGIN';
const MAX_STATUSLINE_SCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_STATUSLINE_SCRIPTS = 8;
// A script the command names: double-quoted, single-quoted (both may hold
// spaces), or a bare token. Only the JavaScript family, since the tee is JS.
const STATUSLINE_SCRIPT_TOKEN = /"([^"]*?\.[cm]?js)"|'([^']*?\.[cm]?js)'|([^\s"'`;|&()=,]+?\.[cm]?js)(?![\w.])/g;
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|%HOME%)(?=[\\/]|$)/;
// The one project-relative script the kit injects into (fixStatusline).
const PROJECT_HELPER_SUFFIX = '.claude/helpers/statusline.cjs';

function statusLineScripts(command) {
  const out = [];
  for (const m of command.matchAll(STATUSLINE_SCRIPT_TOKEN)) {
    const token = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (token && !out.includes(token)) out.push(token);
    if (out.length >= MAX_STATUSLINE_SCRIPTS) break;
  }
  return out;
}

function scriptCarriesFooter(file, fsImpl) {
  try {
    const st = fsImpl.statSync(file);
    if (!st.isFile() || st.size > MAX_STATUSLINE_SCRIPT_BYTES) return false;
    return fsImpl.readFileSync(file, 'utf8').includes(KIT_FOOTER_MARKER);
  } catch { return false; }
}

/** One named script → 'kit-footer' | 'project-helper' | 'custom'. A path that
 *  stays relative (after home expansion) resolves against each session's
 *  project, so only the helper the kit injects into can carry the footer. */
function scriptChannel(token, { fsImpl, home }) {
  const expanded = token.replace(HOME_PREFIX, () => home);
  const projectRelative = /CLAUDE_PROJECT_DIR/.test(expanded) || /^\$\{?D\}?[\\/]/.test(expanded)
    || !(path.isAbsolute(expanded) || path.win32.isAbsolute(expanded));
  if (projectRelative) {
    return expanded.replace(/\\/g, '/').endsWith(PROJECT_HELPER_SUFFIX) ? 'project-helper' : 'custom';
  }
  return scriptCarriesFooter(expanded, fsImpl) ? 'kit-footer' : 'custom';
}

/**
 * Classify the user-level Claude statusLine by whether it can feed the quota
 * tee: 'none' (no user-level statusLine), 'kit-footer' (its script carries the
 * footer), 'project-helper' (it runs each project's ruflo helper, so it depends
 * on the project), 'custom' (anything else: another script, an inline command,
 * a missing file), or 'unknown' (the settings file exists but cannot be read).
 *
 * @param {{ settingsFile?: string, fsImpl?: any, home?: string }} [o]
 * @returns {'none'|'kit-footer'|'project-helper'|'custom'|'unknown'}
 */
export function classifyClaudeTeeChannel({
  settingsFile = claudeSettingsPath(), fsImpl = fs, home = os.homedir(),
} = {}) {
  let settings;
  try { settings = JSON.parse(fsImpl.readFileSync(settingsFile, 'utf8')); }
  catch (error) { return error?.code === 'ENOENT' ? 'none' : 'unknown'; }
  const command = settings?.statusLine?.command;
  if (typeof command !== 'string' || !command.trim()) return 'none';
  const classes = statusLineScripts(command).map((token) => scriptChannel(token, { fsImpl, home }));
  if (classes.includes('kit-footer')) return 'kit-footer';
  return classes.includes('project-helper') ? 'project-helper' : 'custom';
}

// ── Codex (app-server) ──────────────────────────────────────────────────────

/** The legacy lane id, from before app-server named its model pools. */
const GENERIC_CODEX_LANE = 'codex';

/**
 * app-server reports one pool under BOTH its named lane and the legacy generic
 * `codex` lane — the same window twice. Left alone, the panel draws two
 * identical meters and the limit detectors count one pool as two.
 *
 * Two windows are the same pool only when duration, reset instant, AND
 * utilization all match exactly. A difference in any of them means two real
 * pools and both stay: a percentage guard is what keeps this from folding a
 * genuinely distinct pool that happens to share a reset clock. Duration and
 * reset must both be RECORDED — deduping on two absent values would be
 * dropping a window for want of evidence rather than because of it.
 *
 * The named lane wins: "GPT-5.3-Codex-Spark · weekly" says which pool it is
 * and "codex · weekly" does not. Older builds ship only the generic lane,
 * which has nothing to dedupe against and comes back untouched.
 */
function dedupeGenericLane(lanes) {
  const generic = lanes.find((l) => l.id === GENERIC_CODEX_LANE);
  if (!generic || lanes.length < 2) return lanes;
  const named = lanes.filter((l) => l !== generic).flatMap((l) => l.windows);
  generic.windows = generic.windows.filter((w) => !(
    w.windowMinutes !== null && w.resetsAt !== null
    && named.some((n) => n.windowMinutes === w.windowMinutes
      && n.resetsAt === w.resetsAt && n.usedPercent === w.usedPercent)
  ));
  return generic.windows.length ? lanes : lanes.filter((l) => l !== generic);
}

/**
 * Normalize a GetAccountRateLimitsResponse. Lanes come from
 * `rateLimitsByLimitId` (per-model pools, e.g. `codex` + `codex_bengalfox`)
 * with the legacy single-bucket `rateLimits` as fallback, and a pool reported
 * under both a named and the generic lane is kept once. Pure.
 */
export function normalizeCodexLimits(resp, { fetchedAt = null } = {}) {
  if (!resp || typeof resp !== 'object') return null;
  const byId = resp.rateLimitsByLimitId && typeof resp.rateLimitsByLimitId === 'object'
    ? resp.rateLimitsByLimitId
    : (resp.rateLimits ? { [resp.rateLimits.limitId ?? 'codex']: resp.rateLimits } : {});
  const lanes = [];
  for (const [id, snap] of Object.entries(byId)) {
    if (!snap || typeof snap !== 'object') continue;
    const windows = [];
    for (const w of [snap.primary, snap.secondary]) {
      if (!w || typeof w !== 'object') continue;
      const usedPercent = num(w.usedPercent);
      if (usedPercent === null) continue;
      const windowMinutes = num(w.windowDurationMins);
      windows.push({
        id: `${id}:${windowMinutes ?? 'window'}`,
        label: windowLabel(windowMinutes ?? NaN),
        usedPercent, windowMinutes,
        resetsAt: num(w.resetsAt),
      });
    }
    lanes.push({
      id,
      name: typeof snap.limitName === 'string' && snap.limitName ? snap.limitName : id,
      planType: typeof snap.planType === 'string' ? snap.planType : null,
      windows,
    });
  }
  if (!lanes.length) return null;
  const deduped = dedupeGenericLane(lanes);
  const rc = resp.rateLimitResetCredits;
  const resetCredits = rc && typeof rc === 'object' && Number.isFinite(Number(rc.availableCount))
    ? {
      availableCount: Number(rc.availableCount),
      credits: (Array.isArray(rc.credits) ? rc.credits : [])
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          status: typeof c.status === 'string' ? c.status : null,
          title: typeof c.title === 'string' ? c.title : null,
          expiresAt: num(c.expiresAt),
        })),
    }
    : null;
  return {
    provider: 'codex',
    source: 'app-server',
    fetchedAt,
    planType: deduped.find((l) => l.planType)?.planType ?? null,
    lanes: deduped,
    resetCredits,
  };
}

/**
 * One JSON-RPC exchange with `codex app-server`: initialize, then
 * account/rateLimits/read, then kill the child (it does not exit on EOF —
 * verified live — so the timeout and the kill are both load-bearing).
 * Read-only sandbox, `never` for approval — this call issues no commands, so
 * it must never block on a prompt; `-a untrusted` was removed upstream
 * (codex-cli now only accepts `on-request`/`never` — confirmed against
 * codex-cli 0.150.1, which hard-errors on `untrusted` and silently starved
 * the cache for 10 days before this fix). Resolves the raw response object,
 * or null on any failure.
 */
export function codexAppServerRateLimits(opts = {}) {
  return codexAppServerExchange(opts).then((out) => out.result);
}

/** Every failure class codexAppServerExchange can report (#238 P4). */
export const CODEX_UNAVAILABLE_REASONS = Object.freeze([
  'not-installed', 'spawn-failed', 'exited', 'timeout', 'rpc-error', 'no-limit-windows',
  'host-not-found', 'host-unconfirmed',
]);

const spawnFailure = (error) => ({ reason: error?.code === 'ENOENT' ? 'not-installed' : 'spawn-failed' });

/**
 * The same exchange, keeping WHY it produced nothing: `{ result, failure }`
 * where `failure` is null on an answer, else `{ reason }` plus `exitCode`
 * (an early exit, e.g. 2 when a CLI rejects the flags) or `rpcCode` (a
 * JSON-RPC error on the read). Only the class and a number are kept: stderr
 * stays ignored and the vendor's error message is dropped, because it can
 * carry account or path detail the dashboard has no business relaying.
 */
export function codexAppServerExchange({ timeoutMs = 15_000, spawnImpl = spawn, bin = 'codex' } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, ['-s', 'read-only', '-a', 'never', 'app-server'],
        { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) { resolve({ result: null, failure: spawnFailure(error) }); return; }
    let buf = '';
    let settled = false;
    const done = (result, failure = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve({ result, failure });
    };
    const timer = setTimeout(() => done(null, { reason: 'timeout' }), timeoutMs);
    child.on('error', (error) => done(null, spawnFailure(error)));
    child.on('exit', (code) => done(null, Number.isInteger(code)
      ? { reason: 'exited', exitCode: code } : { reason: 'exited' }));
    child.stdout.on('data', (chunk) => {
      buf += String(chunk);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.id === 1) {
          // initialized → notify per protocol, then ask the real question.
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} })}\n`);
          } catch (error) { done(null, spawnFailure(error)); }
        } else if (msg?.id === 2) {
          if (msg.result && typeof msg.result === 'object') done(msg.result);
          else done(null, Number.isInteger(msg.error?.code)
            ? { reason: 'rpc-error', rpcCode: msg.error.code } : { reason: 'rpc-error' });
        }
      }
    });
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { clientInfo: { name: 'agentic-kit', title: 'agentic-kit dashboard', version: '0' } },
      })}\n`);
    } catch (error) { done(null, spawnFailure(error)); }
  });
}

/**
 * The last cached Codex answer, raw (not re-normalized), or null when there is
 * none yet / it is unreadable. Pure file read, no freshness judgment — callers
 * decide TTL/staleness themselves (collectCodexLimitsDetailed) or serve it
 * verbatim while skipping the spawn (readLimits, when Codex presence is not
 * confirmed).
 * @param {{ cacheFile?: string }} [o]
 */
export function readCodexLimitsCache({ cacheFile = codexLimitsFile() } = {}) {
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return null; }
}

/**
 * Cached Codex quota. Fresh cache → served as-is; stale → one app-server call,
 * cache rewritten on success; failure → the stale cache (age visible via
 * `fetchedAt`) rather than nothing, or null when there has never been an
 * answer (codex absent / logged out).
 *
 * @param {{ ttlMs?: number, cacheFile?: string, now?: number,
 *           timeoutMs?: number, spawnImpl?: any, bin?: string }} [opts]
 */
export async function collectCodexLimits(opts = {}) {
  return (await collectCodexLimitsDetailed(opts)).limits;
}

/**
 * collectCodexLimits with the failure kept: `{ limits, unavailable }`.
 * `unavailable` is null when the answer is fresh (from the app-server or the
 * TTL cache), else the failure class of THIS refresh, including when a stale
 * cache is served in its place, so the panel can say both "as of 3h ago"
 * and why it is not newer.
 *
 * @param {{ ttlMs?: number, cacheFile?: string, now?: number,
 *           timeoutMs?: number, spawnImpl?: any, bin?: string }} [o]
 */
export async function collectCodexLimitsDetailed({
  ttlMs = CODEX_TTL_MS, cacheFile = codexLimitsFile(), now = Date.now(),
  timeoutMs, spawnImpl, bin,
} = {}) {
  const cached = readCodexLimitsCache({ cacheFile });
  if (cached && Number.isFinite(cached.fetchedAt) && now - cached.fetchedAt < ttlMs) {
    return { limits: cached, unavailable: null };
  }

  const { result, failure } = await codexAppServerExchange({ timeoutMs, spawnImpl, bin });
  const fresh = normalizeCodexLimits(result, { fetchedAt: now });
  // stale beats silent-nothing; null when never answered
  if (!fresh) return { limits: cached, unavailable: failure ?? { reason: 'no-limit-windows' } };
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    // 0600 like the usage cache: plan type and utilization are the user's own
    // account details, not world-readable material.
    fs.writeFileSync(tmp, JSON.stringify(fresh), { mode: 0o600 });
    fs.renameSync(tmp, cacheFile);
  } catch { /* an unwritable cache costs a refetch, never the answer */ }
  return { limits: fresh, unavailable: null };
}

// ── Unsupported hosts (F-10 labeling policy) ────────────────────────────────

/**
 * Every OTHER registry-managed host (session-driving, per adapters/
 * registries.mjs `managedHostIds()`) beyond the two ADR-0010-sanctioned
 * channels, labeled `{ supported: false }` instead of left absent — IF the
 * caller reports it enabled. A host the caller does not report as enabled is
 * omitted entirely: a user who never turned it on should see nothing, not a
 * label. Adds no channel; performs no probe. Pure.
 *
 * @param {{ enabledHosts?: Record<string, boolean> }} [o]
 */
export function unsupportedQuotaHosts({ enabledHosts = {} } = {}) {
  return managedHostIds()
    .filter((id) => id !== 'claude' && id !== 'codex' && enabledHosts[id] === true)
    .map((provider) => ({ provider, supported: false, reason: 'no quota surface for this host' }));
}

// ── Combined read (the /api/limits payload) ─────────────────────────────────

/**
 * Both providers, plus the freshness contract the UI renders: `fetchedAt` on
 * each side and `generatedAt` overall. Claude is a pure file read (push
 * model); Codex may spawn one vendor subprocess, TTL-bounded, and ONLY when
 * the last recorded `host-setup` evidence (providers.mjs `recordedHostPresence`,
 * written by `detectHosts` on every `/api/status` poll for every host —
 * managed or not, ADR-0010) says the codex CLI was found — recent evidence, not
 * a fresh probe: this function never spawns `which`/`codex --version` itself.
 * Presence `'not-found'`/`'unconfirmed'` serves the last cached answer (if
 * any) with `codexUnavailable` naming which, and skips the spawn entirely.
 * `others` lists any additional enabled host with no sanctioned quota channel
 * (F-10); omitting `enabledHosts` (the default) leaves it empty, so
 * claude/codex output is unchanged unless a caller opts in. `claudeChannel` is
 * the user-level statusLine's class (classifyClaudeTeeChannel), and
 * `codexUnavailable` the failure class of the latest Codex refresh (null when
 * the answer is fresh); both are siblings so `claude` and `codex` keep their
 * null-or-data contracts.
 *
 * @param {{ now?: number, claudeFile?: string, codexCacheFile?: string, ttlMs?: number,
 *           timeoutMs?: number, spawnImpl?: any, bin?: string,
 *           enabledHosts?: Record<string, boolean>,
 *           claudeSettingsFile?: string, home?: string,
 *           codexPresence?: () => 'found'|'not-found'|'unconfirmed' }} [o]
 */
export async function readLimits({
  now = Date.now(), claudeFile, codexCacheFile, ttlMs, timeoutMs, spawnImpl, bin, enabledHosts,
  claudeSettingsFile, home, codexPresence,
} = {}) {
  const claude = readClaudeLimits({ file: claudeFile ?? claudeLimitsFile() });
  const claudeChannel = classifyClaudeTeeChannel({ settingsFile: claudeSettingsFile ?? claudeSettingsPath(), home });
  const presence = (codexPresence ?? (() => recordedHostPresence('codex', { now })))();
  const { limits: codex, unavailable: codexUnavailable } = presence === 'found'
    ? await collectCodexLimitsDetailed({
      ttlMs, cacheFile: codexCacheFile ?? codexLimitsFile(), now, timeoutMs, spawnImpl, bin,
    })
    : {
      limits: readCodexLimitsCache({ cacheFile: codexCacheFile ?? codexLimitsFile() }),
      unavailable: { reason: presence === 'not-found' ? 'host-not-found' : 'host-unconfirmed' },
    };
  const others = unsupportedQuotaHosts({ enabledHosts });
  return { generatedAt: new Date(now).toISOString(), claude, claudeChannel, codex, codexUnavailable, others };
}
