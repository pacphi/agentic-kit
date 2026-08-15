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
import path from 'node:path';
import { spawn } from 'node:child_process';
import { configDir } from './paths.mjs';
import { managedHostIds } from './adapters/registries.mjs';

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

// ── Codex (app-server) ──────────────────────────────────────────────────────

/**
 * Normalize a GetAccountRateLimitsResponse. Lanes come from
 * `rateLimitsByLimitId` (per-model pools, e.g. `codex` + `codex_bengalfox`)
 * with the legacy single-bucket `rateLimits` as fallback. Pure.
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
    planType: lanes.find((l) => l.planType)?.planType ?? null,
    lanes,
    resetCredits,
  };
}

/**
 * One JSON-RPC exchange with `codex app-server`: initialize, then
 * account/rateLimits/read, then kill the child (it does not exit on EOF —
 * verified live — so the timeout and the kill are both load-bearing).
 * Read-only, untrusted sandbox flags; codex handles its own auth and refresh.
 * Resolves the raw response object, or null on any failure.
 */
export function codexAppServerRateLimits({ timeoutMs = 15_000, spawnImpl = spawn, bin = 'codex' } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, ['-s', 'read-only', '-a', 'untrusted', 'app-server'],
        { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { resolve(null); return; }
    let buf = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    child.on('error', () => done(null));
    child.on('exit', () => done(null));
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
          } catch { done(null); }
        } else if (msg?.id === 2) {
          done(msg.result && typeof msg.result === 'object' ? msg.result : null);
        }
      }
    });
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { clientInfo: { name: 'agentic-kit', title: 'agentic-kit dashboard', version: '0' } },
      })}\n`);
    } catch { done(null); }
  });
}

/**
 * Cached Codex quota. Fresh cache → served as-is; stale → one app-server call,
 * cache rewritten on success; failure → the stale cache (age visible via
 * `fetchedAt`) rather than nothing, or null when there has never been an
 * answer (codex absent / logged out).
 *
 * @param {{ ttlMs?: number, cacheFile?: string, now?: number,
 *           timeoutMs?: number, spawnImpl?: any, bin?: string }} [o]
 */
export async function collectCodexLimits({
  ttlMs = CODEX_TTL_MS, cacheFile = codexLimitsFile(), now = Date.now(),
  timeoutMs, spawnImpl, bin,
} = {}) {
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* first run */ }
  if (cached && Number.isFinite(cached.fetchedAt) && now - cached.fetchedAt < ttlMs) return cached;

  const resp = await codexAppServerRateLimits({ timeoutMs, spawnImpl, bin });
  const fresh = normalizeCodexLimits(resp, { fetchedAt: now });
  if (!fresh) return cached; // stale beats silent-nothing; null when never answered
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    // 0600 like the usage cache: plan type and utilization are the user's own
    // account details, not world-readable material.
    fs.writeFileSync(tmp, JSON.stringify(fresh), { mode: 0o600 });
    fs.renameSync(tmp, cacheFile);
  } catch { /* an unwritable cache costs a refetch, never the answer */ }
  return fresh;
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
 * model); Codex may spawn one vendor subprocess, TTL-bounded. `others` lists
 * any additional enabled host with no sanctioned quota channel (F-10);
 * omitting `enabledHosts` (the default) leaves it empty, so claude/codex
 * output is unchanged unless a caller opts in.
 *
 * @param {{ now?: number, claudeFile?: string, codexCacheFile?: string, ttlMs?: number,
 *           timeoutMs?: number, spawnImpl?: any, bin?: string,
 *           enabledHosts?: Record<string, boolean> }} [o]
 */
export async function readLimits({
  now = Date.now(), claudeFile, codexCacheFile, ttlMs, timeoutMs, spawnImpl, bin, enabledHosts,
} = {}) {
  const claude = readClaudeLimits({ file: claudeFile ?? claudeLimitsFile() });
  const codex = await collectCodexLimits({
    ttlMs, cacheFile: codexCacheFile ?? codexLimitsFile(), now, timeoutMs, spawnImpl, bin,
  });
  const others = unsupportedQuotaHosts({ enabledHosts });
  return { generatedAt: new Date(now).toISOString(), claude, codex, others };
}
