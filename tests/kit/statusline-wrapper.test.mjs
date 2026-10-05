// The kit's statusline footer and bin fix must never be written into Ruflo's signed
// helper. Ruflo 3.51+ ships .claude/helpers/helpers.manifest.json (per-file sha256, ed25519)
// and `ruflo hooks statusline --json` — the very call every render makes — restores any
// critical helper whose hash differs (Ruflo helper-refresh.ts, the heal-on-tamper path). So the kit owns
// a loader that patches the helper IN MEMORY and leaves statusline.cjs byte-identical.
// Hermetic: a synthetic helper and global root stand in for Ruflo; nothing real is touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';
import { fixStatusline } from '../../src/lib/statusline.mjs';
import statuslineSection from '../../src/commands/status/sections/statusline.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
import { redirectToolState, spawnEnv } from './helpers/home-sandbox.mjs';

const toolState = redirectToolState('ak-slw');
after(() => toolState.restore());

// Ruflo's real helper prints through console.log(generateStatusline()) and resolves its CLI
// through resolveCliBinCandidates(); this stand-in prints both so a test can RUN the loader.
const HOST = `#!/usr/bin/env node
let ver = "3.0.0";
function resolveCliBinCandidates() { return ['/orig']; }
function generateStatusline() {
  return 'BINS:' + resolveCliBinCandidates().join('|') + ' SEG:' + typeof rufloActivationSegments;
}
console.log(generateStatusline())
`;

// Ruflo's stock statusLine command, as `ruflo init` writes it.
const STOCK_COMMAND = 'sh -c \'D="${CLAUDE_PROJECT_DIR:-.}"; [ -f "$D/.claude/helpers/statusline.cjs" ] || D="${HOME}"; exec node "$D/.claude/helpers/statusline.cjs"\'';

function fixture({ settings = { statusLine: { type: 'command', command: STOCK_COMMAND, refreshMs: 5000 } } } = {}) {
  const dir = tempDir('ak-slw');
  const proj = path.join(dir, 'proj');
  const helpers = path.join(proj, '.claude', 'helpers');
  fs.mkdirSync(helpers, { recursive: true });
  fs.writeFileSync(path.join(helpers, 'statusline.cjs'), HOST);
  if (settings) fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  const groot = path.join(dir, 'groot');
  fs.mkdirSync(path.join(groot, 'ruflo'), { recursive: true });
  _setGlobalRootForTest(groot);
  return {
    dir, proj, helpers,
    sl: path.join(helpers, 'statusline.cjs'),
    loader: path.join(helpers, 'ak-statusline.cjs'),
    footer: path.join(helpers, 'ak-statusline-footer.cjs'),
    settingsFile: path.join(proj, '.claude', 'settings.json'),
  };
}

const render = (f, file) => execFileSync(process.execPath, [file], {
  cwd: f.proj, encoding: 'utf8', env: spawnEnv(path.join(f.dir, 'home')),
});

test('fixStatusline leaves Ruflo\'s signed helper byte-identical and installs the kit loader beside it', () => {
  const f = fixture();
  const r = fixStatusline(f.proj);
  assert.equal(r.applied, true);
  assert.equal(fs.readFileSync(f.sl, 'utf8'), HOST, 'statusline.cjs must keep its signed content');
  assert.ok(fs.existsSync(f.loader), 'loader written');
  assert.ok(fs.existsSync(f.footer), 'footer + bin fix written');
  assert.match(fs.readFileSync(f.footer, 'utf8'), /ruflo-seg:BEGIN/);
  assert.match(fs.readFileSync(f.footer, 'utf8'), /ruflo-bin:BEGIN/);
});

test('statusLine.command prefers the loader and falls back to the stock helper', () => {
  const f = fixture();
  fixStatusline(f.proj);
  const settings = JSON.parse(fs.readFileSync(f.settingsFile, 'utf8'));
  assert.match(settings.statusLine.command, /ak-statusline\.cjs/);
  assert.match(settings.statusLine.command, /helpers\/statusline\.cjs/, 'the stock helper stays the fallback');
  assert.equal(settings.statusLine.refreshMs, 5000, 'other statusLine keys are preserved');
});

test('wiring adds no statusLine keys beyond the command', () => {
  const f = fixture({ settings: { statusLine: { type: 'command', command: STOCK_COMMAND } } });
  fixStatusline(f.proj);
  const { statusLine } = JSON.parse(fs.readFileSync(f.settingsFile, 'utf8'));
  assert.deepEqual(Object.keys(statusLine).sort(), ['command', 'type']);
});

test('the loader runs the helper with the footer and the real-bin fix patched in memory', () => {
  const f = fixture();
  const rufloBin = path.join(f.proj, 'node_modules', 'ruflo', 'bin');
  fs.mkdirSync(rufloBin, { recursive: true });
  fs.writeFileSync(path.join(rufloBin, 'ruflo.js'), '');
  fixStatusline(f.proj);
  const out = render(f, f.loader);
  assert.ok(out.indexOf(path.join(rufloBin, 'ruflo.js')) !== -1, 'real bin is a candidate');
  assert.ok(out.indexOf(path.join(rufloBin, 'ruflo.js')) < out.indexOf('/orig'), 'real bins come first');
  assert.match(out, /SEG:function/, 'the footer is defined in the helper scope');
  assert.equal(fs.readFileSync(f.sl, 'utf8'), HOST, 'rendering never writes the helper');
});

test('the loader falls back to the stock helper when the footer file is unreadable', () => {
  const f = fixture();
  fixStatusline(f.proj);
  fs.rmSync(f.footer);
  assert.equal(render(f, f.loader).trim(), 'BINS:/orig SEG:undefined');
});

test('an injected helper from an older ak is restored to its stock content', () => {
  const f = fixture();
  const legacy = HOST
    .replace('let ver', '/* ruflo-seg:BEGIN */\nfunction rufloActivationSegments(){ return ""; }\n/* ruflo-seg:END */\n/* ruflo-bin:BEGIN */\ntry {} catch(e){}\n/* ruflo-bin:END */\nlet ver')
    .replace('console.log(generateStatusline())', 'console.log(generateStatusline() + rufloActivationSegments(process.cwd()))');
  fs.writeFileSync(f.sl, legacy);
  const r = fixStatusline(f.proj);
  assert.equal(r.applied, true);
  assert.equal(fs.readFileSync(f.sl, 'utf8'), HOST);
});

test('a converged project stays converged, and a dry run writes nothing', () => {
  const f = fixture();
  assert.equal(fixStatusline(f.proj, { dryRun: true }).applied, true, 'drift is reported');
  assert.equal(fs.existsSync(f.loader), false, 'dry run writes no loader');
  assert.equal(JSON.parse(fs.readFileSync(f.settingsFile, 'utf8')).statusLine.command, STOCK_COMMAND);
  fixStatusline(f.proj);
  const before = [f.loader, f.footer, f.settingsFile, f.sl].map((p) => fs.readFileSync(p, 'utf8'));
  assert.equal(fixStatusline(f.proj).applied, false, 'a converged project reports no change');
  assert.deepEqual([f.loader, f.footer, f.settingsFile, f.sl].map((p) => fs.readFileSync(p, 'utf8')), before);
});

test('status reports drift until the loader is wired and converged afterwards', async () => {
  const f = fixture();
  const stale = (await statuslineSection.collect({ cfg: {}, cwd: f.proj })).find((r) => r.subsystem === 'statusline');
  assert.equal(stale.level, 'warn');
  fixStatusline(f.proj);
  const ok = (await statuslineSection.collect({ cfg: {}, cwd: f.proj })).find((r) => r.subsystem === 'statusline');
  assert.equal(ok.level, 'ok', ok.message);
});

test('status flags a loader that no statusLine command runs', async () => {
  const f = fixture({ settings: { statusLine: { type: 'command', command: 'echo custom' } } });
  fixStatusline(f.proj);
  const row = (await statuslineSection.collect({ cfg: {}, cwd: f.proj })).find((r) => r.subsystem === 'statusline');
  assert.equal(row.level, 'warn');
  assert.match(row.message, /statusLine/);
  assert.equal(JSON.parse(fs.readFileSync(f.settingsFile, 'utf8')).statusLine.command, 'echo custom', 'a custom command is never overwritten');
});
