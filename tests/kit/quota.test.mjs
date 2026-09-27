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
  collectCodexLimits, CODEX_TTL_MS, unsupportedQuotaHosts, readLimits,
  classifyClaudeTeeChannel, CLAUDE_TEE_CHANNELS,
  collectCodexLimitsDetailed, CODEX_UNAVAILABLE_REASONS,
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

// ── classifyClaudeTeeChannel — which statusLine could feed the tee (#238 M3) ─
//
// The tee lives only inside the kit footer (`ruflo-seg:BEGIN`) that sync injects
// into a ruflo helper. A user-level statusLine that runs some other script can
// never write claude-rate-limits.json, and the Limits panel used to hide that.
// Every case below points the classifier at a temp settings file: the default
// (the real ~/.claude/settings.json) is never read by a test.

const FOOTER_SCRIPT = '#!/usr/bin/env node\n/* ruflo-seg:BEGIN */\nfunction rufloQuotaTeeSegment(){}\n/* ruflo-seg:END */\n';
const FOREIGN_SCRIPT = '#!/usr/bin/env node\nconsole.log("my own statusline");\n';

/** A temp home with one settings file and optional scripts; returns paths. */
function teeFixture({ statusLine, raw, scripts = {} } = {}) {
  const home = tmp();
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  for (const [rel, body] of Object.entries(scripts)) {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  if (raw !== undefined) fs.writeFileSync(settingsFile, raw);
  else if (statusLine !== undefined) fs.writeFileSync(settingsFile, JSON.stringify({ statusLine }));
  return { home, settingsFile };
}
const cmd = (command) => ({ type: 'command', command });

test('classifyClaudeTeeChannel: no settings file or no statusLine is "none"', () => {
  const { home, settingsFile } = teeFixture();
  assert.equal(classifyClaudeTeeChannel({ settingsFile, home }), 'none', 'absent settings file');
  const empty = teeFixture({ raw: JSON.stringify({ model: 'x' }) });
  assert.equal(classifyClaudeTeeChannel({ settingsFile: empty.settingsFile, home: empty.home }), 'none');
  const noCommand = teeFixture({ statusLine: { type: 'command' } });
  assert.equal(classifyClaudeTeeChannel({ settingsFile: noCommand.settingsFile, home: noCommand.home }), 'none');
});

test('classifyClaudeTeeChannel: an unreadable settings file is "unknown", never a guess', () => {
  const { home, settingsFile } = teeFixture({ raw: '{not json' });
  assert.equal(classifyClaudeTeeChannel({ settingsFile, home }), 'unknown');
});

test('classifyClaudeTeeChannel: a script carrying the kit footer is "kit-footer"', () => {
  const abs = teeFixture({ scripts: { '.claude/helpers/statusline.cjs': FOOTER_SCRIPT } });
  const script = path.join(abs.home, '.claude', 'helpers', 'statusline.cjs');
  fs.writeFileSync(abs.settingsFile, JSON.stringify({ statusLine: cmd(`node ${script}`) }));
  assert.equal(classifyClaudeTeeChannel({ settingsFile: abs.settingsFile, home: abs.home }), 'kit-footer');
  // Home-relative spellings resolve against the injected home.
  for (const spelling of ['~/.claude/helpers/statusline.cjs', '$HOME/.claude/helpers/statusline.cjs',
    '${HOME}/.claude/helpers/statusline.cjs', '"$HOME/.claude/helpers/statusline.cjs"']) {
    fs.writeFileSync(abs.settingsFile, JSON.stringify({ statusLine: cmd(`node ${spelling}`) }));
    assert.equal(classifyClaudeTeeChannel({ settingsFile: abs.settingsFile, home: abs.home }), 'kit-footer', spelling);
  }
});

test('classifyClaudeTeeChannel: a quoted script path containing spaces is still read', () => {
  const fx = teeFixture({ scripts: { 'My Tools/status line.cjs': FOOTER_SCRIPT } });
  const script = path.join(fx.home, 'My Tools', 'status line.cjs');
  fs.writeFileSync(fx.settingsFile, JSON.stringify({ statusLine: cmd(`node "${script}"`) }));
  assert.equal(classifyClaudeTeeChannel({ settingsFile: fx.settingsFile, home: fx.home }), 'kit-footer');
});

test('classifyClaudeTeeChannel: a foreign statusline script is "custom" (the #238 reporter shape)', () => {
  const fx = teeFixture({ scripts: { '.cache/ruvnet-brain/ruvnet-brain-statusline.cjs': FOREIGN_SCRIPT } });
  fs.writeFileSync(fx.settingsFile, JSON.stringify({
    statusLine: cmd('node ~/.cache/ruvnet-brain/ruvnet-brain-statusline.cjs'),
  }));
  assert.equal(classifyClaudeTeeChannel({ settingsFile: fx.settingsFile, home: fx.home }), 'custom');
  // An inline command, a missing script, and a non-file target are custom too:
  // none of them can run the footer's tee.
  for (const command of ['echo "hello"', 'node ~/nowhere/statusline.cjs', `node ${fx.home}`]) {
    fs.writeFileSync(fx.settingsFile, JSON.stringify({ statusLine: cmd(command) }));
    assert.equal(classifyClaudeTeeChannel({ settingsFile: fx.settingsFile, home: fx.home }), 'custom', command);
  }
});

test('classifyClaudeTeeChannel: the ruflo project-helper command is "project-helper"', () => {
  // The exact POSIX and Windows forms ruflo 3.45.0 writes
  // (@claude-flow/cli dist/src/init/settings-generator.js generateStatusLineConfig):
  // which script runs depends on the project each session starts in.
  const posix = 'sh -c \'D="${CLAUDE_PROJECT_DIR:-.}"; [ -f "$D/.claude/helpers/statusline.cjs" ] || D="${HOME}"; exec node "$D/.claude/helpers/statusline.cjs"\'';
  const win32 = 'node -e "const fs=require(\'fs\'),p=require(\'path\');const d=process.env.CLAUDE_PROJECT_DIR||\'.\';const f=p.join(d,\'.claude/helpers/statusline.cjs\');const h=p.join(process.env.USERPROFILE||process.env.HOME||\'.\', \'.claude/helpers/statusline.cjs\');require(fs.existsSync(f)?f:h);"';
  for (const command of [posix, win32]) {
    const fx = teeFixture({ statusLine: cmd(command) });
    assert.equal(classifyClaudeTeeChannel({ settingsFile: fx.settingsFile, home: fx.home }), 'project-helper', command);
  }
});

test('classifyClaudeTeeChannel returns only a class — never a path', () => {
  const fx = teeFixture({ scripts: { 'private-dir/statusline.cjs': FOREIGN_SCRIPT } });
  fs.writeFileSync(fx.settingsFile, JSON.stringify({
    statusLine: cmd(`node ${path.join(fx.home, 'private-dir', 'statusline.cjs')}`),
  }));
  const out = classifyClaudeTeeChannel({ settingsFile: fx.settingsFile, home: fx.home });
  assert.ok(CLAUDE_TEE_CHANNELS.includes(out), `unexpected class ${out}`);
  assert.equal(typeof out, 'string');
  assert.ok(!JSON.stringify(out).includes(fx.home), 'the class must not carry the script path');
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

// ── One pool reported twice ─────────────────────────────────────────────────
//
// LIVE SHAPE, observed 2026-08-29: app-server reports the same weekly pool
// under BOTH the named model-pool lane and the legacy generic `codex` lane —
// identical windowDurationMins, identical resetsAt, identical usedPercent. The
// panel drew two identical meters and the limit detectors counted one pool as
// two. The named lane also carries a 5h window the generic lane never had.
const CODEX_DUP_RESP = {
  rateLimits: {
    limitId: 'codex', limitName: null, planType: 'prolite',
    primary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: 1788624681 },
    secondary: null,
  },
  rateLimitsByLimitId: {
    codex_bengalfox: {
      limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', planType: 'prolite',
      primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1788571234 },
      secondary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: 1788624681 },
    },
    codex: {
      limitId: 'codex', limitName: null, planType: 'prolite',
      primary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: 1788624681 },
      secondary: null,
    },
  },
};

test('a window reported under both the named pool and the generic codex lane renders once', () => {
  const n = normalizeCodexLimits(CODEX_DUP_RESP);
  // The generic lane held nothing but the duplicate, so it goes with it —
  // an empty "codex" lane would still draw a "no window reported" row.
  assert.deepEqual(n.lanes.map((l) => l.id), ['codex_bengalfox']);
  const windows = n.lanes[0].windows;
  assert.deepEqual(windows.map((w) => w.label), ['5h', 'weekly'],
    'the named lane keeps BOTH its windows — dedup drops the copy, not the pool');
  assert.equal(windows[1].usedPercent, 21);
  assert.equal(windows[1].resetsAt, 1788624681);
});

test('lanes whose percentages differ are different pools, and both render', () => {
  const resp = structuredClone(CODEX_DUP_RESP);
  resp.rateLimitsByLimitId.codex.primary.usedPercent = 22;
  const n = normalizeCodexLimits(resp);
  assert.deepEqual(n.lanes.map((l) => l.id), ['codex_bengalfox', 'codex']);
  assert.equal(n.lanes[1].windows.length, 1, 'the generic weekly survives on a percentage difference');
  // Same guard on the reset instant: matching duration alone is not identity.
  const other = structuredClone(CODEX_DUP_RESP);
  other.rateLimitsByLimitId.codex.primary.resetsAt = 1788624999;
  assert.equal(normalizeCodexLimits(other).lanes.length, 2);
});

test('a generic-only payload is untouched — older codex builds keep their one lane', () => {
  const n = normalizeCodexLimits({
    rateLimitsByLimitId: { codex: CODEX_DUP_RESP.rateLimitsByLimitId.codex },
  });
  assert.deepEqual(n.lanes.map((l) => l.id), ['codex']);
  assert.equal(n.lanes[0].windows.length, 1);
  assert.equal(n.lanes[0].windows[0].label, 'weekly');
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

// ── Why Codex limits are unavailable (#238 P4) ──────────────────────────────
//
// Every app-server failure used to collapse to codex:null, and the panel
// guessed "not installed, not logged in, or did not answer". The collector now
// keeps the failure CLASS (never vendor text or stderr) so the panel can say
// which. These children are modeled on the exchange's documented shape; which
// class a real logged-out or API-key account produces is not asserted here.

/** A child whose reply to each JSON-RPC line is decided by `script`. */
function scriptedSpawn(script, { onSpawn } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      write(line) {
        const reply = script(JSON.parse(line));
        if (reply) setImmediate(() => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', ...reply })}\n`));
        return true;
      },
    };
    if (onSpawn) setImmediate(() => onSpawn(child));
    return child;
  };
}
const initOk = (msg) => (msg.id === 1 ? { id: 1, result: {} } : null);

const UNAVAILABLE_SCENARIOS = [
  ['codex missing from PATH', {
    spawnImpl: scriptedSpawn(() => null, {
      onSpawn: (c) => c.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })),
    }),
  }, { reason: 'not-installed' }],
  ['a spawn that throws', {
    spawnImpl: () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }); },
  }, { reason: 'spawn-failed' }],
  ['a CLI that rejects its flags and exits', {
    spawnImpl: scriptedSpawn(() => null, { onSpawn: (c) => c.emit('exit', 2, null) }),
  }, { reason: 'exited', exitCode: 2 }],
  ['an RPC error on the rate-limit read', {
    spawnImpl: scriptedSpawn((m) => initOk(m)
      ?? (m.id === 2 ? { id: 2, error: { code: -32600, message: 'not logged in as someone@example.com' } } : null)),
  }, { reason: 'rpc-error', rpcCode: -32600 }],
  ['an answer with no usable window', {
    spawnImpl: scriptedSpawn((m) => initOk(m) ?? (m.id === 2 ? { id: 2, result: { rateLimits: null } } : null)),
  }, { reason: 'no-limit-windows' }],
  ['an app-server that never answers', {
    spawnImpl: scriptedSpawn(() => null), timeoutMs: 30,
  }, { reason: 'timeout' }],
];

for (const [name, opts, expected] of UNAVAILABLE_SCENARIOS) {
  test(`collectCodexLimitsDetailed names the failure class: ${name}`, async () => {
    const out = await collectCodexLimitsDetailed({ cacheFile: path.join(tmp(), 'none.json'), ...opts });
    assert.equal(out.limits, null, 'no answer and no cache is still null');
    assert.deepEqual(out.unavailable, expected);
    assert.ok(CODEX_UNAVAILABLE_REASONS.includes(out.unavailable.reason));
    assert.ok(!JSON.stringify(out.unavailable).includes('example.com'),
      'vendor error text never reaches the payload — only the class and a numeric code');
  });
}

test('collectCodexLimitsDetailed reports nothing unavailable on an answer or a fresh cache', async () => {
  const cacheFile = path.join(tmp(), 'codex-rate-limits.json');
  const answered = await collectCodexLimitsDetailed({ cacheFile, spawnImpl: fakeSpawn(CODEX_RESP), now: 1000 });
  assert.equal(answered.unavailable, null);
  assert.equal(answered.limits.planType, 'prolite');
  const cached = await collectCodexLimitsDetailed({
    cacheFile, now: 1001, spawnImpl: () => { throw new Error('must not spawn on a fresh cache'); },
  });
  assert.equal(cached.unavailable, null);
  assert.equal(cached.limits.fetchedAt, 1000);
});

test('a stale cache served after a failed refresh still carries why the refresh failed', async () => {
  const cacheFile = path.join(tmp(), 'codex-rate-limits.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ provider: 'codex', fetchedAt: 1, lanes: [{ id: 'codex' }] }));
  const out = await collectCodexLimitsDetailed({
    cacheFile, now: 10 + CODEX_TTL_MS,
    spawnImpl: scriptedSpawn(() => null, { onSpawn: (c) => c.emit('exit', 2, null) }),
  });
  assert.equal(out.limits.fetchedAt, 1, 'stale beats silent-nothing');
  assert.deepEqual(out.unavailable, { reason: 'exited', exitCode: 2 });
});

// ── unsupportedQuotaHosts — F-10: label absence instead of leaving it silent ─
//
// ADR-0010 sanctions exactly two channels (claude's statusline tee, codex's
// app-server). This does not add a third — it never probes anything — it only
// says so, for any OTHER registry-managed host the caller reports enabled.

test('unsupportedQuotaHosts labels an enabled managed host with no channel', () => {
  const out = unsupportedQuotaHosts({ enabledHosts: { opencode: true } });
  assert.deepEqual(out, [
    { provider: 'opencode', supported: false, reason: 'no quota surface for this host' },
  ]);
});

test('unsupportedQuotaHosts omits a host the caller has not enabled', () => {
  assert.deepEqual(unsupportedQuotaHosts(), []);
  assert.deepEqual(unsupportedQuotaHosts({ enabledHosts: {} }), []);
  assert.deepEqual(unsupportedQuotaHosts({ enabledHosts: { opencode: false } }), []);
});

test('unsupportedQuotaHosts never labels the two sanctioned channels', () => {
  const out = unsupportedQuotaHosts({ enabledHosts: { claude: true, codex: true, opencode: true } });
  assert.deepEqual(out.map((h) => h.provider), ['opencode']);
});

// ── readLimits — the combined /api/limits payload ───────────────────────────

test('readLimits: claude/codex outputs are byte-identical whether or not others are reported', async () => {
  const dir = tmp();
  const claudeFile = path.join(dir, 'claude-rate-limits.json');
  fs.writeFileSync(claudeFile, JSON.stringify(CLAUDE_TEE));
  const codexCacheFile = path.join(dir, 'codex-rate-limits.json');
  const claudeSettingsFile = path.join(dir, 'settings.json');

  const withoutOthers = await readLimits({
    now: 1000, claudeFile, codexCacheFile, spawnImpl: fakeSpawn(CODEX_RESP), claudeSettingsFile,
  });
  const withOthers = await readLimits({
    now: 1000, claudeFile, codexCacheFile: path.join(dir, 'codex-rate-limits-2.json'),
    spawnImpl: fakeSpawn(CODEX_RESP), enabledHosts: { claude: true, codex: true, opencode: true },
    claudeSettingsFile,
  });

  assert.deepEqual(withOthers.claude, withoutOthers.claude);
  assert.deepEqual(withOthers.codex, withoutOthers.codex);
  assert.deepEqual(withoutOthers.others, []);
  assert.deepEqual(withOthers.others, [
    { provider: 'opencode', supported: false, reason: 'no quota surface for this host' },
  ]);
});

test('readLimits defaults to no unsupported-host labels when enabledHosts is not passed', async () => {
  const out = await readLimits({
    now: 1000, claudeFile: path.join(tmp(), 'absent.json'),
    codexCacheFile: path.join(tmp(), 'codex.json'), spawnImpl: failSpawn,
    claudeSettingsFile: path.join(tmp(), 'settings.json'),
  });
  assert.deepEqual(out.others, []);
});

test('readLimits carries the Claude tee channel class beside an unchanged claude field', async () => {
  const fx = teeFixture({ scripts: { 'brain.cjs': FOREIGN_SCRIPT } });
  fs.writeFileSync(fx.settingsFile, JSON.stringify({ statusLine: cmd('node ~/brain.cjs') }));
  const out = await readLimits({
    now: 1000, claudeFile: path.join(tmp(), 'absent.json'),
    codexCacheFile: path.join(tmp(), 'codex.json'), spawnImpl: failSpawn,
    claudeSettingsFile: fx.settingsFile, home: fx.home,
  });
  assert.equal(out.claude, null, 'no tee file still reads as null — the claude contract is unchanged');
  assert.equal(out.claudeChannel, 'custom');
});

test('readLimits carries why Codex limits are unavailable beside an unchanged codex field', async () => {
  const out = await readLimits({
    now: 1000, claudeFile: path.join(tmp(), 'absent.json'),
    codexCacheFile: path.join(tmp(), 'codex.json'), claudeSettingsFile: path.join(tmp(), 'settings.json'),
    spawnImpl: scriptedSpawn(() => null, {
      onSpawn: (c) => c.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })),
    }),
  });
  assert.equal(out.codex, null);
  assert.deepEqual(out.codexUnavailable, { reason: 'not-installed' });
  const ok = await readLimits({
    now: 1000, claudeFile: path.join(tmp(), 'absent.json'),
    codexCacheFile: path.join(tmp(), 'codex.json'), claudeSettingsFile: path.join(tmp(), 'settings.json'),
    spawnImpl: fakeSpawn(CODEX_RESP),
  });
  assert.equal(ok.codexUnavailable, null);
});
