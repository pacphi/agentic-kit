import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, identity, now } from './helpers/telemetry.mjs';
const storePath = '../../src/lib/telemetry/store.mjs';
const bin = new URL('../../bin/agentic-kit.mjs', import.meta.url);
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-telemetry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function cli(args) { return spawnSync(process.execPath, [fileURLToPath(bin), 'telemetry', ...args], { encoding: 'utf8' }); }

test('should_advertiseTelemetry_when_requestingCommandHelp', () => {
  assert.match(cli(['--help']).stdout, /ak telemetry export/);
});
test('should_preserveIdentity_when_reopeningInstallationStore', async t => {
  const { readOrCreateIdentity } = await import(storePath); const dir = temporary(t);
  assert.deepEqual(readOrCreateIdentity(dir), readOrCreateIdentity(dir));
});
test('should_rejectCorruptIdentity_when_existingStoreIsInvalid', async t => {
  const { readOrCreateIdentity } = await import(storePath); const dir = temporary(t);
  fs.writeFileSync(path.join(dir, 'identity.json'), '{}', { mode: 0o600 });
  assert.throws(() => readOrCreateIdentity(dir), /identity/i);
});
test('should_refuseSymlinkIdentity_when_loadingState', async t => {
  const { readOrCreateIdentity } = await import(storePath); const dir = temporary(t);
  fs.writeFileSync(path.join(dir, 'target'), JSON.stringify(identity));
  fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'identity.json'));
  assert.throws(() => readOrCreateIdentity(dir));
});
test('should_notOverwriteExistingOutput_when_exportDestinationExists', async t => {
  const { writeNewJson } = await import(storePath); const file = path.join(temporary(t), 'export.json');
  fs.writeFileSync(file, 'original');
  assert.throws(() => writeNewJson(file, {}));
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
});
test('should_boundInputReads_when_fileExceedsLimit', async t => {
  const { readJsonFile } = await import(storePath); const file = path.join(temporary(t), 'large.json');
  fs.writeFileSync(file, ' '.repeat(100));
  assert.throws(() => readJsonFile(file, 20), /bound/i);
});
test('should_validateAndAggregateFiles_when_usingRealCli', async t => {
  const dir = temporary(t); const file = path.join(dir, 'snapshot.json');
  fs.writeFileSync(file, JSON.stringify(await fixture()));
  assert.equal(cli(['validate', file]).status, 0);
  const result = cli(['aggregate', file, file, '--as-of', now]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).usage.metrics.input.value, 100);
});
test('should_exposeJsonSchema_when_requested', () => {
  const result = cli(['schema']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).properties.schemaVersion.const, 1);
});
test('should_keepErrorsGeneric_when_malformedFilesContainSecrets', t => {
  const file = path.join(temporary(t), 'SECRET.json'); fs.writeFileSync(file, 'SECRET');
  const result = cli(['validate', file]);
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET/);
});
test('should_degradeSourcesIndependently_when_usageReaderFails', async () => {
  const { collectSnapshot } = await import('../../src/lib/telemetry/collect.mjs');
  const snapshot = await collectSnapshot({ identity, days: 30, generatedAt: now, producerVersion: '1.0.0',
    readUsage: async () => { throw new Error('SECRET'); }, readInventory: () => null, readReceipts: () => [] });
  assert.equal(snapshot.usage.state, 'unavailable');
  assert.equal(snapshot.maintenance.state, 'available');
});
test('should_exportHermeticLocalEvidence_when_invokingRealCli', t => {
  const dir = temporary(t);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_STATE_HOME: path.join(dir, 'state'), APPDATA: path.join(dir, 'config'), LOCALAPPDATA: path.join(dir, 'state'),
    CLAUDE_CONFIG_DIR: path.join(dir, '.claude') };
  const invoke = args => spawnSync(process.execPath, [fileURLToPath(bin), 'telemetry', ...args], { encoding: 'utf8', env });
  const first = invoke(['export']);
  assert.equal(first.status, 0, first.stderr);
  const a = JSON.parse(first.stdout);
  const second = invoke(['export']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).installationId, a.installationId);
  assert.equal(a.inventory.state, 'unavailable');
  assert.equal(a.maintenance.state, 'unavailable');
  assert.equal(a.usage.sessions.length, 0);
});
test('should_projectActualParserEvidence_when_localFixtureCorpusIsRead', async t => {
  const { collectSnapshot } = await import('../../src/lib/telemetry/collect.mjs');
  const { buildIndex } = await import('../../src/lib/usage-index.mjs');
  const dir = temporary(t);
  fs.cpSync(new URL('../fixtures/usage', import.meta.url), path.join(dir, 'corpus'), { recursive: true });
  const roots = { claude: path.join(dir, 'corpus/claude'), codex: path.join(dir, 'corpus/codex') };
  const readUsage = options => buildIndex({ ...options, roots, cachePath: path.join(dir, 'cache.json'),
    deps: { costOf: ({ input, output, cacheRead, cacheWrite }) => (input + output + cacheRead + cacheWrite) / 1000,
      pricesAsOf: '2026-07-01', classify: () => ({}), detectInsights: () => [] } });
  const snapshot = await collectSnapshot({ identity, producerVersion: '1.0.0', days: 30,
    generatedAt: '2026-07-25T12:00:00.000Z', readUsage, readInventory: () => null, readReceipts: () => null });
  assert.ok(snapshot.usage.sessions.length > 0);
  assert.ok(snapshot.usage.sessions.some(s => s.input > 0));
  assert.doesNotMatch(JSON.stringify(snapshot), /Users-me|aaaa1111|rollout|corpus/);
});
test('should_rejectInvalidOptions_before_creatingIdentity', async t => {
  const { run } = await import('../../src/commands/telemetry.mjs');
  const dir = path.join(temporary(t), 'identity');
  const error = t.mock.method(console, 'error', () => {});
  const code = await run({ flags: { days: '0' }, positionals: ['export'], pkgRoot: fileURLToPath(new URL('../..', import.meta.url)), deps: { identityDir: dir } });
  assert.equal(code, 2); assert.equal(fs.existsSync(dir), false); assert.equal(error.mock.callCount(), 1);
});
test('should_writePrivateCompleteJson_when_newOutputIsRequested', async t => {
  const { writeNewJson, readJsonFile } = await import(storePath);
  const file = path.join(temporary(t), 'new.json'); writeNewJson(file, { valid: true });
  assert.deepEqual(readJsonFile(file), { valid: true });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test('should_rejectReplacedFiles_when_openedInodeDiffers', async t => {
  const { readJsonFile } = await import(storePath); const file = path.join(temporary(t), 'data.json');
  fs.writeFileSync(file, '{}');
  const original = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (...args) => { const stat = original(...args); stat.ino++; return stat; });
  assert.throws(() => readJsonFile(file), /bounds/);
});
test('should_rejectPublicIdentityDirectory_when_permissionsAreLoose', { skip: process.platform === 'win32' }, async t => {
  const { readOrCreateIdentity } = await import(storePath); const dir = temporary(t); fs.chmodSync(dir, 0o755);
  assert.throws(() => readOrCreateIdentity(dir), /private/);
});
test('should_rejectPublicIdentityFile_when_permissionsAreLoose', { skip: process.platform === 'win32' }, async t => {
  const { readOrCreateIdentity } = await import(storePath); const dir = temporary(t); readOrCreateIdentity(dir);
  fs.chmodSync(path.join(dir, 'identity.json'), 0o644);
  assert.throws(() => readOrCreateIdentity(dir), /private/);
});
test('should_failSafely_when_publishingIdentityCannotLink', async t => {
  const { readOrCreateIdentity } = await import(storePath); const dir = temporary(t);
  t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  assert.throws(() => readOrCreateIdentity(dir), /denied/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
test('should_rejectBadCommandForms_when_cliArgumentsConflict', () => {
  for (const args of [['missing'], ['validate'], ['aggregate'], ['export', '--days', '366'],
    ['export', '--days', '1.5'], ['schema', '--days', '30'], ['schema', 'extra']]) {
    assert.equal(cli(args).status, 2, args.join(' '));
  }
});
test('should_readRetainedMaintenance_when_exportingOffline', t => {
  const dir = temporary(t); const state = path.join(dir, 'state');
  const root = path.join(state, 'agentic-kit', 'maintenance', 'transactions');
  fs.mkdirSync(path.join(root, 'mnt-corrupt'), { recursive: true, mode: 0o700 });
  const result = spawnSync(process.execPath, [fileURLToPath(bin), 'telemetry', 'export'], { encoding: 'utf8',
    env: { ...process.env, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: path.join(dir, 'config'),
      XDG_STATE_HOME: state, LOCALAPPDATA: state, APPDATA: path.join(dir, 'config'), CLAUDE_CONFIG_DIR: path.join(dir, '.claude') } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).maintenance.receipts[0].status, 'unknown-recovery-required');
});
test('should_countRawBytes_when_inputContainsWhitespace', async t => {
  const module = await import(storePath);
  assert.equal(typeof module.readJsonDocument, 'function');
  const file = path.join(temporary(t), 'padded.json'); fs.writeFileSync(file, '  {}  ');
  assert.deepEqual(module.readJsonDocument(file), { value: {}, bytes: 6 });
});
test('should_notEchoUnknownOptionValues_when_cliParsingFails', () => {
  const result = cli(['export', '--secret-token=PRIVATE-MARKER']);
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-MARKER|secret-token/);
});
