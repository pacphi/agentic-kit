#!/usr/bin/env node
//
// statusline-window-ledger.test.cjs — the Claude context-window ledger writer
// embedded in the statusline footer template (ADR-0042 amendment).
//
// Claude transcripts never record the context window, but the statusline
// payload carries `context_window.context_window_size`. The template appends a
// per-session CHANGE LOG `[{t, size, model}]` to
// <configdir>/claude-context-windows/<session_id>.json so the usage parser can
// pair each historical message with the window that was in effect. This test
// extracts the writer from the kit template exactly as statusline-segments does
// and drives it against TEMP config dirs only (XDG_CONFIG_HOME) — it never
// touches the real ~/.config/agentic-kit.
//
// Run: node tests/statusline-window-ledger.test.cjs   (exit 0 = pass, 1 = fail)

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'templates', 'statusline-footer.cjs');
const block = fs.readFileSync(SRC, 'utf8')
  .match(/\/\* ruflo-seg:BEGIN \*\/([\s\S]*?)\/\* ruflo-seg:END \*\//)[1];

// eslint-disable-next-line no-eval -- first-party template source, see statusline-segments.test.cjs
const load = (name, prefix = '') => eval('(function(){' + prefix + block + '\nreturn ' + name + ';})()');
const windowTee = load('rufloWindowTeeSegment');
const quotaTee = load('rufloQuotaTeeSegment');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  \x1b[32m✓\x1b[0m ' + name); passed++; }
  catch (e) { console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg || 'mismatch'}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`); }

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** Run `fn(configHome)` with XDG_CONFIG_HOME pointing at a fresh temp dir. */
function withConfig(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-window-ledger-'));
  // The template resolves the kit config dir like paths.mjs: %APPDATA% on win32, XDG elsewhere.
  // Set both so the real config dir is never touched on any platform.
  const before = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA };
  process.env.XDG_CONFIG_HOME = home;
  process.env.APPDATA = home;
  try { return fn(home); }
  finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const ledgerDir = (home) => path.join(home, 'agentic-kit', 'claude-context-windows');
const ledgerFile = (home, sid = SID) => path.join(ledgerDir(home), sid + '.json');
const readLog = (home, sid) => JSON.parse(fs.readFileSync(ledgerFile(home, sid), 'utf8'));
const payload = (o = {}) => ({
  session_id: SID, model: { id: 'claude-opus-4-7' }, context_window: { context_window_size: 1000000 }, ...o,
});
const tee = (data, extra = {}) => windowTee({ fs, path, os, getStdinData: () => data, ...extra });
const posix = process.platform !== 'win32';

console.log('statusline context-window ledger writer');

test('first observation writes one entry with t, size and model (no rate_limits needed)', () => withConfig((home) => {
  const before = Date.now();
  tee(payload());
  const log = readLog(home);
  eq(log.length, 1);
  assert(log[0].t >= before && log[0].t <= Date.now(), 't must be the observation epoch ms');
  eq({ size: log[0].size, model: log[0].model }, { size: 1000000, model: 'claude-opus-4-7' });
}));

test('the ledger dir is 0700 and the file is 0600 (POSIX)', () => withConfig((home) => {
  tee(payload());
  if (!posix) return;
  assert((fs.statSync(ledgerDir(home)).mode & 0o777) === 0o700, 'dir must be 0700');
  assert((fs.statSync(ledgerFile(home)).mode & 0o777) === 0o600, 'file must be 0600');
}));

test('an unchanged size and model does not rewrite the file', () => withConfig((home) => {
  tee(payload());
  const file = ledgerFile(home);
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(file, past, past);
  const bytes = fs.readFileSync(file, 'utf8');
  tee(payload());
  tee(payload());
  eq(fs.readFileSync(file, 'utf8'), bytes, 'content must be untouched');
  assert(Math.abs(fs.statSync(file).mtimeMs - past.getTime()) < 2000, 'mtime must be untouched (no write happened)');
}));

test('a window size change appends a second entry', () => withConfig((home) => {
  tee(payload());
  tee(payload({ context_window: { context_window_size: 200000 } }));
  const log = readLog(home);
  eq(log.map((e) => e.size), [1000000, 200000]);
}));

test('a model change at the same size appends an entry', () => withConfig((home) => {
  tee(payload());
  tee(payload({ model: { id: 'claude-sonnet-5' } }));
  eq(readLog(home).map((e) => e.model), ['claude-opus-4-7', 'claude-sonnet-5']);
}));

test('a payload without a positive numeric window records nothing', () => withConfig((home) => {
  for (const cw of [undefined, null, {}, { context_window_size: 0 }, { context_window_size: -5 },
    { context_window_size: '1000000' }, { context_window_size: NaN }, { context_window_size: Infinity }]) {
    tee(payload({ context_window: cw }));
  }
  assert(!fs.existsSync(ledgerFile(home)), 'no ledger file may exist');
}));

test('a payload without a model still records the size (model null)', () => withConfig((home) => {
  tee(payload({ model: undefined }));
  eq(readLog(home)[0].model, null);
}));

test('unsafe session ids are rejected: nothing is written anywhere', () => withConfig((home) => {
  for (const sid of ['../evil', 'a/b', 'a\\b', '', '.', '..', 'a.b', 'x'.repeat(200), 'a b', null, undefined, 42, {}]) {
    tee(payload({ session_id: sid }));
  }
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } })(home);
  eq(files, [], 'no file may be created for an unsafe id');
}));

test('the log is capped at the latest 64 entries', () => withConfig((home) => {
  for (let i = 1; i <= 100; i++) tee(payload({ context_window: { context_window_size: 1000 + i } }));
  const log = readLog(home);
  eq(log.length, 64);
  eq(log.at(-1).size, 1100);
  eq(log[0].size, 1037);
}));

test('a corrupt existing ledger is replaced by a fresh one-entry log', () => withConfig((home) => {
  fs.mkdirSync(ledgerDir(home), { recursive: true });
  fs.writeFileSync(ledgerFile(home), '{not json');
  tee(payload());
  eq(readLog(home).length, 1);
}));

test('a new session file prunes files older than 35 days; a fresh one and an existing session do not', () => withConfig((home) => {
  fs.mkdirSync(ledgerDir(home), { recursive: true });
  const old = ledgerFile(home, 'old-session'), fresh = ledgerFile(home, 'fresh-session');
  fs.writeFileSync(old, '[]'); fs.writeFileSync(fresh, '[]');
  const stale = new Date(Date.now() - 40 * 86400_000);
  fs.utimesSync(old, stale, stale);
  tee(payload());                       // creates SID's file -> prune runs here
  assert(!fs.existsSync(old), 'stale file must be pruned when a new session file is created');
  assert(fs.existsSync(fresh), 'recent file must survive');
  const old2 = ledgerFile(home, 'old-two');
  fs.writeFileSync(old2, '[]'); fs.utimesSync(old2, stale, stale);
  tee(payload({ context_window: { context_window_size: 200000 } })); // append to existing session
  assert(fs.existsSync(old2), 'appending to an existing session must not prune');
}));

test('failure is silent: an unwritable config root never throws', () => withConfig((home) => {
  const blocker = path.join(home, 'blocker');
  fs.writeFileSync(blocker, 'x');
  process.env.XDG_CONFIG_HOME = blocker; // mkdir under a regular file -> ENOTDIR
  process.env.APPDATA = blocker;
  tee(payload());
  windowTee({ fs: { ...fs, mkdirSync() { throw new Error('boom'); } }, path, os, getStdinData: () => payload() });
  windowTee({ fs, path, os, getStdinData() { throw new Error('stdin exploded'); } });
  windowTee({ fs, path, os });          // no getStdinData at all
}));

test('the full renderer still returns text and records the ledger as a side effect', () => withConfig((home) => {
  const render = load('rufloActivationSegments', 'function getStdinData(){ return globalThis.__akPayload; }');
  globalThis.__akPayload = payload();
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-window-cwd-'));
    const out = render(cwd);
    assert(typeof out === 'string', 'renderer must still return a string');
    eq(readLog(home).length, 1);
  } finally { delete globalThis.__akPayload; }
}));

// ── kit config dir parity with src/lib/paths.mjs configBase() ───────────────
// win32: %APPDATA% (fallback ~/AppData/Roaming), XDG ignored. POSIX: XDG_CONFIG_HOME
// || ~/.config, byte-for-byte as before. Injected via ctx.env/ctx.platform/ctx.os.
function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ak-cfg-parity-')); }
const RATE = { five_hour: { used_percentage: 12 } };

test('win32: the ledger lands under %APPDATA%/agentic-kit even when XDG_CONFIG_HOME is set', () => {
  const appdata = tmpHome(), xdg = tmpHome(), home = tmpHome();
  tee(payload(), { platform: 'win32', env: { APPDATA: appdata, XDG_CONFIG_HOME: xdg }, os: { homedir: () => home } });
  assert(fs.existsSync(path.join(appdata, 'agentic-kit', 'claude-context-windows', SID + '.json')), 'ledger must be under APPDATA');
  eq(fs.readdirSync(xdg), [], 'XDG_CONFIG_HOME must be ignored on win32');
  eq(fs.readdirSync(home), [], 'nothing under home');
});

test('win32 without APPDATA falls back to ~/AppData/Roaming', () => {
  const home = tmpHome();
  tee(payload(), { platform: 'win32', env: {}, os: { homedir: () => home } });
  assert(fs.existsSync(path.join(home, 'AppData', 'Roaming', 'agentic-kit', 'claude-context-windows', SID + '.json')));
});

test('win32: the rate-limits tee (pre-existing mismatch) now lands under %APPDATA%/agentic-kit', () => {
  const appdata = tmpHome(), xdg = tmpHome();
  quotaTee({ fs, path, os, platform: 'win32', env: { APPDATA: appdata, XDG_CONFIG_HOME: xdg }, getStdinData: () => payload({ rate_limits: RATE }) });
  const tee = JSON.parse(fs.readFileSync(path.join(appdata, 'agentic-kit', 'claude-rate-limits.json'), 'utf8'));
  eq(tee.rate_limits, RATE);
  eq(fs.readdirSync(xdg), []);
});

test('POSIX is unchanged: XDG_CONFIG_HOME wins, else ~/.config, for both the ledger and the tee', () => {
  const xdg = tmpHome(), home = tmpHome();
  const env = { XDG_CONFIG_HOME: xdg };
  tee(payload(), { platform: 'linux', env, os: { homedir: () => home } });
  quotaTee({ fs, path, os: { homedir: () => home }, platform: 'linux', env, getStdinData: () => payload({ rate_limits: RATE }) });
  assert(fs.existsSync(path.join(xdg, 'agentic-kit', 'claude-context-windows', SID + '.json')));
  assert(fs.existsSync(path.join(xdg, 'agentic-kit', 'claude-rate-limits.json')));
  const home2 = tmpHome();
  tee(payload(), { platform: 'darwin', env: {}, os: { homedir: () => home2 } });
  quotaTee({ fs, path, os: { homedir: () => home2 }, platform: 'darwin', env: {}, getStdinData: () => payload({ rate_limits: RATE }) });
  assert(fs.existsSync(path.join(home2, '.config', 'agentic-kit', 'claude-context-windows', SID + '.json')));
  assert(fs.existsSync(path.join(home2, '.config', 'agentic-kit', 'claude-rate-limits.json')));
  eq(fs.readdirSync(home), [], 'XDG set: home untouched');
});

const EXPECTED = 17;
if (passed + failed !== EXPECTED) {
  console.error(`\nPLAN MISMATCH: expected ${EXPECTED} tests, ran ${passed + failed}`);
  process.exit(1);
}
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
