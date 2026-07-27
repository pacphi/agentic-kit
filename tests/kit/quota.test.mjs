// quota.mjs — provider-mediated quota reads (ADR-0010). Normalizers are pure
// and pinned against LIVE-observed payload shapes; the collector is tested
// through its injection seams (spawnImpl, cacheFile), never a real codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  windowLabel, normalizeClaudeLimits, normalizeCodexLimits, readClaudeLimits,
  collectCodexLimits, CODEX_TTL_MS,
} from '../../src/lib/quota.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ak-quota-'));

// ── windowLabel — duration-derived, never slot-derived ───────────────────────

test('windowLabel names the two known windows and degrades sanely', () => {
  assert.equal(windowLabel(300), '5h');
  assert.equal(windowLabel(10080), 'weekly');
  assert.equal(windowLabel(2880), '2d');
  assert.equal(windowLabel(120), '2h');
  assert.equal(windowLabel(90), '90m');
  assert.equal(windowLabel(NaN), 'window');
});

// ── Claude normalizer (statusline tee shape, code.claude.com statusline docs) ─

const CLAUDE_TEE = {
  teedAt: 1785000000000,
  session_id: 'abc-123',
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1785010000 },
    seven_day: { used_percentage: 89, resets_at: 1785400000 },
    seven_day_sonnet: { used_percentage: 46, resets_at: 1785400000 },
  },
};

test('normalizeClaudeLimits maps documented windows, per-model buckets included', () => {
  const n = normalizeClaudeLimits(CLAUDE_TEE);
  assert.equal(n.provider, 'claude');
  assert.equal(n.source, 'statusline');
  assert.equal(n.fetchedAt, 1785000000000);
  assert.equal(n.sessionId, 'abc-123');
  const byId = Object.fromEntries(n.windows.map((w) => [w.id, w]));
  assert.equal(byId.five_hour.usedPercent, 23.5);
  assert.equal(byId.five_hour.label, '5h');
  assert.equal(byId.five_hour.windowMinutes, 300);
  assert.equal(byId.five_hour.resetsAt, 1785010000);
  assert.equal(byId.seven_day.label, 'weekly');
  assert.equal(byId.seven_day.windowMinutes, 10080);
  assert.equal(byId.seven_day_sonnet.label, 'weekly · sonnet');
  assert.equal(byId.seven_day_sonnet.windowMinutes, 10080);
});

test('normalizeClaudeLimits tolerates an independently absent window', () => {
  const n = normalizeClaudeLimits({ rate_limits: { seven_day: { used_percentage: 41.2 } } });
  assert.equal(n.windows.length, 1);
  assert.equal(n.windows[0].resetsAt, null);
});

test('normalizeClaudeLimits returns null when nothing is usable', () => {
  assert.equal(normalizeClaudeLimits(null), null);
  assert.equal(normalizeClaudeLimits({}), null);
  assert.equal(normalizeClaudeLimits({ rate_limits: {} }), null);
  assert.equal(normalizeClaudeLimits({ rate_limits: { five_hour: { used_percentage: 'nope' } } }), null);
});

test('readClaudeLimits returns null for a missing or corrupt tee file', () => {
  const dir = tmp();
  assert.equal(readClaudeLimits({ file: path.join(dir, 'absent.json') }), null);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.equal(readClaudeLimits({ file: bad }), null);
});

// ── Codex normalizer (GetAccountRateLimitsResponse, pinned to a LIVE answer) ─

const CODEX_RESP = {
  rateLimits: {
    limitId: 'codex', limitName: null, planType: 'prolite',
    primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1785694902 },
    secondary: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex', limitName: null, planType: 'prolite',
      primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1785694902 },
      secondary: null,
    },
    codex_bengalfox: {
      limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', planType: 'prolite',
      primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1785767166 },
      secondary: null,
    },
  },
  rateLimitResetCredits: {
    availableCount: 2,
    credits: [
      { id: 'RateLimitResetCredit_x', resetType: 'codexRateLimits', status: 'available', grantedAt: 1782933074, expiresAt: 1785525074, title: 'Full reset' },
      { id: 'RateLimitResetCredit_y', resetType: 'codexRateLimits', status: 'available', grantedAt: 1782933074, expiresAt: null, title: 'Full reset' },
    ],
  },
};

test('normalizeCodexLimits emits one lane per limit id with duration-labelled windows', () => {
  const n = normalizeCodexLimits(CODEX_RESP, { fetchedAt: 42 });
  assert.equal(n.provider, 'codex');
  assert.equal(n.fetchedAt, 42);
  assert.equal(n.planType, 'prolite');
  const lanes = Object.fromEntries(n.lanes.map((l) => [l.id, l]));
  assert.equal(lanes.codex.name, 'codex'); // null limitName falls back to id
  assert.equal(lanes.codex_bengalfox.name, 'GPT-5.3-Codex-Spark');
  // THE NAMING TRAP: primary here is the WEEKLY window; the label must come
  // from windowDurationMins, never from the slot name.
  assert.equal(lanes.codex.windows[0].label, 'weekly');
  assert.equal(lanes.codex.windows[0].usedPercent, 3);
  assert.equal(lanes.codex.windows[0].resetsAt, 1785694902);
});

test('normalizeCodexLimits carries reset credits with expiries', () => {
  const n = normalizeCodexLimits(CODEX_RESP);
  assert.equal(n.resetCredits.availableCount, 2);
  assert.equal(n.resetCredits.credits.length, 2);
  assert.equal(n.resetCredits.credits[0].expiresAt, 1785525074);
  assert.equal(n.resetCredits.credits[1].expiresAt, null);
});

test('normalizeCodexLimits falls back to the legacy single-bucket view', () => {
  const n = normalizeCodexLimits({ rateLimits: CODEX_RESP.rateLimits });
  assert.equal(n.lanes.length, 1);
  assert.equal(n.lanes[0].id, 'codex');
});

test('normalizeCodexLimits returns null on nothing usable', () => {
  assert.equal(normalizeCodexLimits(null), null);
  assert.equal(normalizeCodexLimits({}), null);
});

// ── collectCodexLimits — cache TTL + failure semantics ───────────────────────

/** A spawnImpl whose child answers the JSON-RPC exchange with `resp`, or dies. */
function fakeSpawn(resp) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      write(line) {
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          setImmediate(() => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`));
        } else if (msg.id === 2) {
          setImmediate(() => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: resp })}\n`));
        }
        return true;
      },
    };
    return child;
  };
}
const failSpawn = () => { throw new Error('ENOENT'); };

test('collectCodexLimits answers via the RPC seam and writes a 0600 cache', async () => {
  const cacheFile = path.join(tmp(), 'codex-rate-limits.json');
  const out = await collectCodexLimits({ cacheFile, spawnImpl: fakeSpawn(CODEX_RESP), now: 1000 });
  assert.equal(out.planType, 'prolite');
  assert.equal(out.fetchedAt, 1000);
  const st = fs.statSync(cacheFile);
  if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600);
});

test('collectCodexLimits serves a fresh cache without spawning at all', async () => {
  const cacheFile = path.join(tmp(), 'codex-rate-limits.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ provider: 'codex', fetchedAt: 5000, lanes: [{ id: 'codex' }] }));
  const out = await collectCodexLimits({
    cacheFile, now: 5000 + CODEX_TTL_MS - 1,
    spawnImpl: () => { throw new Error('must not spawn on a fresh cache'); },
  });
  assert.equal(out.fetchedAt, 5000);
});

test('collectCodexLimits falls back to the STALE cache when the spawn fails', async () => {
  const cacheFile = path.join(tmp(), 'codex-rate-limits.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ provider: 'codex', fetchedAt: 1, lanes: [{ id: 'codex' }] }));
  const out = await collectCodexLimits({ cacheFile, now: 10 + CODEX_TTL_MS, spawnImpl: failSpawn });
  assert.equal(out.fetchedAt, 1); // stale beats silent-nothing; age stays visible
});

test('collectCodexLimits returns null when there has never been an answer', async () => {
  const out = await collectCodexLimits({ cacheFile: path.join(tmp(), 'none.json'), spawnImpl: failSpawn });
  assert.equal(out, null);
});
