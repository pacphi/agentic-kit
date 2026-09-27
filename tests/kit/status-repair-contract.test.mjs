// The status-row repair contract (#237): a row's `fix` says what would make
// it healthy, and `repair` says WHO performs it — 'sync' (an `ak sync` step
// does it) or 'manual' (a human must). `ak sync` plans only 'sync' fixes, so a
// row sync cannot act on never enters its plan, and the census below proves
// every subsystem that can emit a 'sync' fix has a sync step that runs for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, captureLog, rmrf, sandboxProject, writeKitConfig, offlineKitConfig,
  fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';
import { isolateProject } from './helpers/project-isolation.mjs';

const HOME = sandboxHome('ak-repair-contract');
const paths = await import('../../src/lib/paths.mjs');
const { row } = await import('../../src/commands/status/row.mjs');
const sync = await import('../../src/commands/sync.mjs');
const status = await import('../../src/commands/status.mjs');
const { rowLine } = await import('../../src/lib/dashboard/groups.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
const { hostsWithLifecycle } = await import('../../src/lib/adapters/lifecycle-registry.mjs');
assertSandboxed(paths, HOME);
isolateProject('ak-repair-contract-cwd');

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-repair-contract');
paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));

function seedHome(cfg = offlineKitConfig()) {
  rmrf(paths.claudeDir(), paths.codexDir(), paths.configDir());
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  writeKitConfig(HOME, cfg);
}

async function inProject(fn) {
  const prior = process.cwd();
  process.chdir(PROJECT);
  try { return await fn(); } finally { process.chdir(prior); }
}

// ── the row() contract ───────────────────────────────────────────────────────

test('a row with a fix defaults to a sync repair; a row without one has no repair', () => {
  assert.deepEqual(row('x', 'warn', 'm', 'sync does it'),
    { subsystem: 'x', level: 'warn', message: 'm', fix: 'sync does it', repair: 'sync' });
  assert.deepEqual(row('x', 'ok', 'm'), { subsystem: 'x', level: 'ok', message: 'm', fix: null, repair: null });
  assert.equal(row('x', 'warn', 'm', null, { repair: 'manual' }).repair, null,
    'a repair without a fix is meaningless and collapses to null');
});

test('a manual fix is marked manual', () => {
  assert.deepEqual(row('x', 'warn', 'm', 'run: something yourself', { repair: 'manual' }),
    { subsystem: 'x', level: 'warn', message: 'm', fix: 'run: something yourself', repair: 'manual' });
});

test('an unknown repair value is rejected at the boundary', () => {
  assert.throws(() => row('x', 'warn', 'm', 'f', { repair: 'someday' }), /repair/);
});

// ── sync plans only what it performs ─────────────────────────────────────────

const FLAGS = (over = {}) => ({ 'dry-run': true, 'no-upgrade': false, yes: false, json: false, ...over });

test('sync plans sync fixes and never plans manual ones', async () => {
  seedHome();
  const { out } = await inProject(() => captureLog(() => sync.run({
    flags: FLAGS(), pkgRoot: PKG_ROOT,
    collectFn: async () => [
      row('daemons', 'warn', 'stale daemons', 'sync reaps stale daemons'),
      row('memory-pin', 'warn', 'pin points nowhere', 'repoint it in .claude/settings.local.json env, or remove the pin', { repair: 'manual' }),
    ],
  })));
  const planned = out.split('\n').filter((l) => l.trim().startsWith('•'));
  assert.equal(planned.length, 1, out);
  assert.match(planned[0], /\[daemons\] sync reaps stale daemons/);
  assert.match(out, /1 item\(s\) need a manual step/);
});

test('with only manual fixes left, sync neither plans them nor claims everything is healthy', async () => {
  seedHome();
  const { result, out } = await inProject(() => captureLog(() => sync.run({
    flags: FLAGS(), pkgRoot: PKG_ROOT,
    collectFn: async () => [
      row('aqe', 'info', 'readiness unverified', 'run: ak x verify aqe', { repair: 'manual' }),
    ],
  })));
  assert.equal(result, 0);
  assert.doesNotMatch(out, /sync plan/);
  assert.doesNotMatch(out, /all subsystems healthy/);
  assert.match(out, /nothing sync can do — 1 item\(s\) need a manual step/);
});

// ── rendering ────────────────────────────────────────────────────────────────

test('the dashboard marks a manual fix and keeps the arrow for a sync fix', () => {
  const manual = rowLine(row('memory-pin', 'warn', 'm', 'remove the pin', { repair: 'manual' }));
  const auto = rowLine(row('daemons', 'warn', 'm', 'sync reaps stale daemons'));
  assert.match(manual, /data-repair="manual"/);
  assert.match(manual, />manual</);
  assert.match(auto, /data-repair="sync"/);
  assert.match(auto, /&rarr;/);
  assert.doesNotMatch(auto, />manual</);
});

test('text status labels a manual fix and --json carries the repair field', async () => {
  seedHome();
  fs.mkdirSync(path.join(PROJECT, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, '.claude', 'settings.local.json'),
    JSON.stringify({ env: { CLAUDE_FLOW_DB_PATH: path.join(PROJECT, 'nowhere', 'memory.db') } }));
  try {
    const text = await inProject(() => captureLog(() => status.run({ flags: {}, pkgRoot: PKG_ROOT })));
    const pinLine = text.out.split('\n').find((l) => /CLAUDE_FLOW_DB_PATH pins/.test(l));
    assert.match(pinLine, /→ manual: repoint it/);
    const json = await inProject(() => captureLog(() => status.run({ flags: { json: true }, pkgRoot: PKG_ROOT })));
    const pin = JSON.parse(json.out).rows.find((r) => r.subsystem === 'memory-pin');
    assert.equal(pin.repair, 'manual');
    assert.ok(JSON.parse(json.out).rows.every((r) => (r.fix ? ['sync', 'manual'].includes(r.repair) : r.repair === null)),
      'every --json row carries a repair consistent with its fix');
  } finally {
    rmrf(path.join(PROJECT, '.claude'));
  }
});

test('a host that needs a login is a manual step — the hosts sync step installs, it never logs in', async () => {
  const hosts = (await import('../../src/commands/status/sections/hosts.mjs')).default;
  const rows = await hosts.collect({
    cfg: { integrations: { hosts: { claude: true } }, routing: { primaryHost: 'claude' } },
    integrationFacts: { hosts: { claude: { present: true } } },
    hostDeps: {
      installState: async () => ({ method: 'external', version: '9.9.9' }),
      authState: () => ({ mode: 'none', billing: 'unknown', source: null, note: null }),
    },
  });
  const login = rows.find((r) => r.fix === 'claude login');
  assert.ok(login, `expected a login row, got ${JSON.stringify(rows)}`);
  assert.equal(login.repair, 'manual');
});

// correctness-mcp-register-false-no-step: the mcp step runs only when
// kit.json's mcp.register is true, so with registration unmanaged the mcp
// rows must not promise a sync repair — or every sync fails on 'no-step'.
test('with mcp.register false the mcp rows promise no sync repair, and sync does not fail on them', async () => {
  const { mcpRows } = await import('../../src/commands/status/sections/mcp.mjs');
  const snapshot = {
    claudeFlow: true,
    effective: { claudeFlow: { command: 'ruflo', args: ['mcp', 'start'] } }, // no managed browser env
    claudeFlowScopes: ['user'],
    denyCount: 0,
    autoMigratableLegacyScopes: ['user'],
    preservedLegacyScopes: [],
  };
  const unmanaged = mcpRows(snapshot, { agentBrowser: true, mcp: { register: false } });
  const withFix = unmanaged.filter((r) => r.fix);
  assert.equal(withFix.length, 2, `both drift rows still say what would fix them: ${JSON.stringify(unmanaged)}`);
  assert.deepEqual(withFix.filter((r) => r.repair === 'sync'), [],
    'no step registers or migrates MCP while mcp.register is false');
  const managed = mcpRows(snapshot, { agentBrowser: true, mcp: { register: true } });
  assert.equal(managed.filter((r) => r.repair === 'sync').length, 2, 'control: managed registration keeps its sync repairs');

  seedHome(offlineKitConfig({ mcp: { register: false, excludeFamilies: [] } }));
  const { result, out } = await inProject(() => captureLog(() => sync.run({
    flags: FLAGS({ 'dry-run': false, 'no-upgrade': true }), pkgRoot: PKG_ROOT, collectFn: async () => unmanaged,
  })));
  assert.equal(result, 0, out);
  assert.doesNotMatch(out, /unresolved/);
});

test('the CVE overlay fix is performed by the statusline step', () => {
  const cfg = loadKitConfig();
  const fired = sync.SYNC_STEPS.filter((s) => s.when(new Set(['statusline/cve']), { 'no-upgrade': false }, cfg))
    .map((s) => s.id);
  assert.ok(fired.includes('statusline'), `statusline/cve must fire the statusline step; fired: ${fired}`);
});

// ── census: every 'sync' fix has a sync step that runs for it ────────────────

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** Top-level arguments of every `row(` call (string/template/comment aware). */
function rowCalls(src) {
  const calls = [];
  const re = /(?<![\w.$])row\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + 4; let depth = 1; let cur = ''; const args = [];
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') {
        let j = i + 1; let nested = 0;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (c === '`' && src[j] === '$' && src[j + 1] === '{') { nested++; j += 2; continue; }
          if (c === '`' && nested && src[j] === '}') { nested--; j++; continue; }
          if (src[j] === c && !nested) break;
          j++;
        }
        cur += src.slice(i, j + 1); i = j + 1; continue;
      }
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c) && --depth === 0) break;
      if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; i++; continue; }
      cur += c; i++;
    }
    if (cur.trim()) args.push(cur.trim());
    calls.push({ line: src.slice(0, m.index).split('\n').length, args });
  }
  return calls;
}

// A `row(<variable>, …)` call names its subsystem at runtime; each such site
// lists the values it can take. A new variable site fails the census until it
// is added here.
const ADMITTED_HOST = 'example-admitted-host';
const VARIABLE_SUBSYSTEMS = {
  'src/commands/status/host-detail.mjs': { subsystem: ['opencode'], hostId: [ADMITTED_HOST] },
};
// Repairs sync.run performs outside SYNC_STEPS, on every run.
const TAIL_COVERAGE = {
  'host-alignment': 'sync.run always runs alignHosts({ apply: true }) for the working project after the steps',
};

test('every subsystem that can emit a sync fix has a sync step that runs for it', () => {
  seedHome();
  // Census cfg: every opt-in managed, so each step's own enablement gate is open.
  fs.writeFileSync(paths.claudeUserMcpPath(), JSON.stringify({ mcpServers: { ruvector: { command: 'ruvector' } } }));
  const cfg = {
    ...loadKitConfig(),
    agentBrowser: true, ruvnetBrain: true, aqe: true, agentdb: true, security: true,
    mcp: { register: true, excludeFamilies: [] },
    codexContext: { owned: true },
    statusline: { codex: { preset: 'census' } },
    integrations: { ...loadKitConfig().integrations, hosts: { claude: true, codex: true, opencode: true } },
  };
  const flags = { 'no-upgrade': false };
  const lifecycleHosts = new Set(hostsWithLifecycle());
  const covered = (subsystem) => {
    const subs = new Set([subsystem]);
    const steps = sync.SYNC_STEPS
      .filter((s) => s.id !== 'host-lifecycles' && s.when(subs, flags, cfg)).map((s) => s.id);
    // host-lifecycles runs every sync but acts only for a lifecycle host it is asked to refresh.
    if ((lifecycleHosts.has(subsystem) || subsystem === ADMITTED_HOST) && sync.lifecycleRefreshRequired(subs, subsystem)) {
      steps.push('host-lifecycles');
    }
    if (TAIL_COVERAGE[subsystem]) steps.push('sync tail');
    return steps;
  };

  const uncovered = [];
  const unmapped = [];
  let syncSites = 0;
  for (const file of sourceFiles(path.join(PKG_ROOT, 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/status\/row\.mjs'|from '\.\.?\/row\.mjs'|from '\.\.\/row\.mjs'/.test(src)) continue;
    const rel = path.relative(PKG_ROOT, file).split(path.sep).join('/');
    for (const { line, args } of rowCalls(src)) {
      if (args.length < 4 || args[3] === 'null') continue; // no fix
      if (/repair:\s*'manual'/.test(args[4] ?? '') && !/\?/.test(args[4] ?? '')) continue; // always manual
      const literal = /^'([^']+)'$/.exec(args[0]);
      const subsystems = literal ? [literal[1]] : VARIABLE_SUBSYSTEMS[rel]?.[args[0]];
      if (!subsystems) { unmapped.push(`${rel}:${line} row(${args[0]}, …)`); continue; }
      for (const subsystem of subsystems) {
        syncSites++;
        if (covered(subsystem).length === 0) uncovered.push(`${rel}:${line} [${subsystem}] ${args[3].slice(0, 80)}`);
      }
    }
  }
  assert.ok(syncSites > 30, `the scanner found only ${syncSites} sync-fix sites — it is not reading the sources`);
  assert.deepEqual(unmapped, [], 'variable-subsystem rows with a fix need their values in VARIABLE_SUBSYSTEMS');
  assert.deepEqual(uncovered, [],
    'these rows promise a sync repair that no sync step performs — add the step, or mark the row { repair: \'manual\' }');
});
