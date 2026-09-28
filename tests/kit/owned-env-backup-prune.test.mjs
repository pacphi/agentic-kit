// ADR-0058 §3: after the owned-env engine writes a settings file and its receipt, an older
// safety copy with the same tag is removed only when the copy just made plus the receipt
// already hold everything it held. The AQE pin keeps its own newest-copy rule (ADR-0062).
// Every test runs in a sandboxed home with real files; kit modules load only after the
// redirect, because paths.mjs reads the home folder when it is first imported.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sandboxHome, assertSandboxed, snapshot, assertUnchanged } from './helpers/home-sandbox.mjs';

const home = sandboxHome('ak-backup-prune');
after(() => fs.rmSync(home, { recursive: true, force: true }));
const paths = await import('../../src/lib/paths.mjs');
assertSandboxed(paths, home);
const { planOwnedEnv, applyOwnedEnv, jsonTopLevelEnvEditor, redundantBackups, prunableFolder } = await import('../../src/lib/owned-env-projection.mjs');
const { reconcileClaudeComponentEnv, reconcileMemoryPin } = await import('../../src/lib/claude-env-projection.mjs');
const { reconcileAqePin } = await import('../../src/lib/aqe-project-pin.mjs');
const { reconcileAqeEmbeddingProjections } = await import('../../src/lib/aqe-embedding-projection.mjs');
const { aqeTomlEnvironment } = await import('../../src/lib/aqe-embedding-toml.mjs');

let sequence = 0;
/** A fresh repository inside the sandbox home, so a snapshot of the home covers it. */
function project({ aqe = false } = {}) {
  const root = path.join(home, `proj-${sequence++}`);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  if (aqe) fs.mkdirSync(path.join(root, '.agentic-qe'));
  return fs.realpathSync(root);
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const copiesOf = (file, tag) => fs.readdirSync(path.dirname(file))
  .filter((name) => name.startsWith(`${path.basename(file)}.ak-${tag}-backup.`)).sort();
/** Copies made by the next call, in the order the calls made them. */
function newCopy(file, tag, fn) {
  const before = new Set(copiesOf(file, tag));
  fn();
  const made = copiesOf(file, tag).filter((name) => !before.has(name));
  assert.equal(made.length, 1, `one new copy expected, got ${made.join(', ')}`);
  return made[0];
}

const opts = { receiptSuffix: '.ak-test-receipt.json', format: 'multi', editorFor: (source) => jsonTopLevelEnvEditor(source) };
const want = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === null ? { present: false } : { present: true, value: v }]));
/** One engine write of `desired` to a project's settings.local.json under the tag `test`. */
function run(root, desired) {
  const file = paths.projectSettingsLocal(root);
  const plan = planOwnedEnv({ file, boundary: root, enabled: true }, want(desired), opts);
  if (plan.changed) applyOwnedEnv(plan, { backupTag: 'test' });
  return plan;
}

const machineCfg = (learningProfile) => ({ rufloComponents: { typesafePicker: true, minilmPicker: true, learningProfile } });

test('after three writes with no user edits, only the newest copy remains', () => {
  // The original is already in the editor's own formatting, so even the first copy is provably redundant.
  const settings = writeJson(paths.claudeSettingsPath(), { permissions: { allow: ['Bash(ls)'] }, env: { KEEP: 'x' } });
  const reconcile = (profile) => reconcileClaudeComponentEnv(machineCfg(profile), { rufloVersion: '3.44.0' });
  assert.equal(reconcile('balanced').changed, true);
  assert.equal(reconcile('research').changed, true);
  const newest = newCopy(settings, 'ruflo-components', () => assert.equal(reconcile('balanced').changed, true));
  assert.deepEqual(copiesOf(settings, 'ruflo-components'), [newest]);
  assert.equal(readJson(path.join(path.dirname(settings), newest)).env.RUFLO_INTELLIGENCE_MODE, 'research',
    'the copy kept is the file as it was just before the last write');
  assert.deepEqual(readJson(settings).permissions, { allow: ['Bash(ls)'] });
});

test('a write that deletes the receipt removes nothing; the next write removes what it proves redundant', () => {
  const root = project();
  const local = writeJson(paths.projectSettingsLocal(root), { permissions: { allow: [] } });
  assert.equal(reconcileMemoryPin(root).ok, true);
  assert.equal(reconcileMemoryPin(root, { enabled: false }).changed, true);
  assert.equal(fs.existsSync(`${local}.agentic-kit-memory-pin.json`), false, 'the release deleted the receipt');
  assert.equal(copiesOf(local, 'memory-pin').length, 2, 'a full release proves nothing, so it prunes nothing');
  const newest = newCopy(local, 'memory-pin', () => assert.equal(reconcileMemoryPin(root).changed, true));
  assert.deepEqual(copiesOf(local, 'memory-pin'), [newest]);
});

test('a copy holding a user key that a later user edit removed is kept', () => {
  const root = project();
  const local = writeJson(paths.projectSettingsLocal(root), { env: { KEEP: 'x', OLD: 'mine' } });
  const first = newCopy(local, 'test', () => run(root, { A: '1' }));
  const doc = readJson(local); delete doc.env.OLD; writeJson(local, doc);
  const second = newCopy(local, 'test', () => run(root, { A: '2' }));
  assert.deepEqual(copiesOf(local, 'test'), [first, second].sort(), 'the copy with OLD is the only record of it');
  assert.equal(readJson(path.join(path.dirname(local), first)).env.OLD, 'mine');
  const third = newCopy(local, 'test', () => run(root, { A: '1' }));
  assert.deepEqual(copiesOf(local, 'test'), [first, third].sort(),
    'the copy holding only ak\'s receipted value goes; the one with the user\'s key stays');
});

test('a copy whose owned value is neither in the newest copy nor the receipt is kept', () => {
  const root = project();
  const local = writeJson(paths.projectSettingsLocal(root), { env: { KEEP: 'x' } });
  newCopy(local, 'test', () => run(root, { A: 'v1' }));
  const middle = newCopy(local, 'test', () => run(root, { A: 'v2' }));
  assert.deepEqual(copiesOf(local, 'test'), [middle], 'the first copy held only the receipt\'s before');
  const unknown = `${local}.ak-test-backup.${randomUUID()}`;
  fs.writeFileSync(unknown, JSON.stringify({ env: { KEEP: 'x', A: 'from-elsewhere' } }, null, 2) + '\n');
  const newest = newCopy(local, 'test', () => run(root, { A: 'v3' }));
  assert.deepEqual(copiesOf(local, 'test'), [middle, newest, path.basename(unknown)].sort(),
    'an intermediate ak value (v1) and an unknown value are both kept');
  assert.equal(readJson(path.join(path.dirname(local), middle)).env.A, 'v1');
});

test('a malformed copy, a symlink named like a copy, and another tag\'s copy are never touched', () => {
  const root = project();
  const local = writeJson(paths.projectSettingsLocal(root), { env: { KEEP: 'x' } });
  const dir = path.dirname(local);
  const first = newCopy(local, 'test', () => run(root, { A: '1' }));
  const redundant = fs.readFileSync(local, 'utf8'); // A=1: the receipt's after and the next copy's value
  const planted = {
    malformed: `${local}.ak-test-backup.${randomUUID()}`,
    otherTag: `${local}.ak-other-backup.${randomUUID()}`,
    upperCase: `${local}.ak-test-backup.${randomUUID().toUpperCase()}`,
    notV4: `${local}.ak-test-backup.6ba7b810-9dad-11d1-80b4-00c04fd430c8`,
    trailing: `${local}.ak-test-backup.${randomUUID()}.old`,
  };
  fs.writeFileSync(planted.malformed, '{"env": {"KEEP": "x"');
  for (const file of [planted.otherTag, planted.upperCase, planted.notV4, planted.trailing]) fs.writeFileSync(file, redundant);
  const folder = `${local}.ak-test-backup.${randomUUID()}`;
  fs.mkdirSync(folder);
  const target = path.join(home, `symlink-target-${sequence++}.json`);
  fs.writeFileSync(target, redundant);
  const link = `${local}.ak-test-backup.${randomUUID()}`;
  let linked = true;
  try { fs.symlinkSync(target, link, 'file'); } catch (error) {
    if (process.platform !== 'win32') throw error;
    linked = false; // creating a symlink on Windows needs a privilege the runner may lack
  }
  const keyOf = (file) => path.basename(file) + (fs.lstatSync(file).isDirectory() ? '/' : '');
  const untouched = [...Object.values(planted), folder, ...(linked ? [link] : [])];
  const before = snapshot(dir);
  const newest = newCopy(local, 'test', () => run(root, { A: '2' }));
  assert.equal(fs.existsSync(path.join(dir, first)), false, 'the prune ran: the first copy was redundant');
  const after = snapshot(dir);
  for (const file of untouched) {
    assert.ok(before.has(keyOf(file)), `${keyOf(file)} was planted`);
    assert.equal(after.get(keyOf(file)), before.get(keyOf(file)), `${keyOf(file)} untouched`);
  }
  if (linked) assert.equal(fs.readlinkSync(link), target);
  assert.equal(fs.readFileSync(target, 'utf8'), redundant, 'the symlink\'s target is untouched');
  assert.ok(copiesOf(local, 'test').includes(newest));
});

test('a converged reconcile and a dry run remove nothing', () => {
  const root = project();
  const local = writeJson(paths.projectSettingsLocal(root), { env: { KEEP: 'x' } });
  run(root, { A: '1' });
  // A copy an earlier ak version left behind: redundant, but only a write proves it.
  const leftover = `${local}.ak-test-backup.${randomUUID()}`;
  fs.copyFileSync(local, leftover);
  const before = snapshot(home);
  assert.equal(run(root, { A: '1' }).changed, false, 'converged');
  assertUnchanged(before, home, 'a converged reconcile touched the sandbox home');
  const dry = planOwnedEnv({ file: local, boundary: root, enabled: true }, want({ A: '2' }), opts);
  assert.equal(dry.changed, true, 'a dry run plans a change and applies nothing');
  assertUnchanged(before, home, 'a dry run touched the sandbox home');
  const userSettingsFile = writeJson(path.join(home, `machine-${sequence++}`, 'settings.json'), { env: { KEEP: 'x' } });
  const machine = (profile, dryRun = false) => reconcileClaudeComponentEnv(machineCfg(profile), { rufloVersion: '3.44.0', userSettingsFile, dryRun });
  assert.equal(machine('balanced').changed, true);
  fs.copyFileSync(userSettingsFile, `${userSettingsFile}.ak-ruflo-components-backup.${randomUUID()}`);
  const machineBefore = snapshot(home);
  assert.equal(machine('balanced').changed, false, 'converged');
  assert.equal(machine('research', true).changed, true, 'a dry run reports the change it would make');
  assertUnchanged(machineBefore, home, 'a converged or dry-run reconcile touched the sandbox home');
  run(root, { A: '2' });
  assert.equal(fs.existsSync(leftover), false, 'the next real write removes the leftover it proves redundant');
});

test('aqe-pin still keeps exactly its newest copy (keepBackups unchanged)', () => {
  const root = project({ aqe: true });
  const local = writeJson(paths.projectSettingsLocal(root), { env: { KEEP: 'x' } });
  const cfg = { aqe: true, integrations: { hosts: { claude: true, codex: false } } };
  for (let i = 0; i < 3; i += 1) {
    newCopy(local, 'aqe-pin', () => assert.equal(reconcileAqePin(cfg, root, { tracks: () => false }).ok, true));
    // A user edit between writes: the redundancy rule would keep every copy; the pin's rule keeps one.
    const doc = readJson(local); doc.env[`N${i}`] = 'x'; delete doc.env.AQE_PROJECT_ROOT; writeJson(local, doc);
  }
  const newest = newCopy(local, 'aqe-pin', () => reconcileAqePin(cfg, root, { tracks: () => false }));
  assert.deepEqual(copiesOf(local, 'aqe-pin'), [newest]);
  assert.equal(readJson(path.join(path.dirname(local), newest)).env.N2, 'x', 'the copy kept is the newest');
});

test('redundantBackups refuses when the file sits directly in the home folder', () => {
  const dir = path.join(home, `flat-${sequence++}`);
  const file = writeJson(path.join(dir, 'settings.json'), { env: { KEEP: 'x' } });
  const older = `${file}.ak-test-backup.${randomUUID()}`;
  fs.copyFileSync(file, older);
  const plan = planOwnedEnv({ file, boundary: dir, enabled: true }, want({ A: '1' }), opts);
  const newest = `${file}.ak-test-backup.${randomUUID()}`;
  fs.copyFileSync(file, newest);
  const listing = fs.readdirSync(dir).sort();
  assert.deepEqual(redundantBackups(plan, { newest, backupTag: 'test' }), [older], 'redundant elsewhere');
  assert.deepEqual(redundantBackups(plan, { newest, backupTag: 'test', homedir: dir }), [], 'refused in the home folder');
  assert.deepEqual(redundantBackups(plan, { newest, backupTag: 'test', uid: -1 }), [], 'refused: another user owns the copy');
  assert.deepEqual(fs.readdirSync(dir).sort(), listing, 'deciding removes nothing');
});

test('redundantBackups refuses a newest copy outside the file\'s folder or not named as a copy', () => {
  const dir = path.join(home, `flat-${sequence++}`);
  const file = writeJson(path.join(dir, 'settings.json'), { env: { KEEP: 'x' } });
  const older = `${file}.ak-test-backup.${randomUUID()}`;
  fs.copyFileSync(file, older);
  const plan = planOwnedEnv({ file, boundary: dir, enabled: true }, want({ A: '1' }), opts);
  const inside = `${file}.ak-test-backup.${randomUUID()}`;
  fs.copyFileSync(file, inside);
  const elsewhere = path.join(home, `elsewhere-${sequence++}`);
  fs.mkdirSync(elsewhere);
  const outside = path.join(elsewhere, path.basename(inside));
  fs.copyFileSync(file, outside);
  const misnamed = `${file}.ak-test-backup.latest`;
  fs.copyFileSync(file, misnamed);
  assert.deepEqual(redundantBackups(plan, { newest: inside, backupTag: 'test' }), [older], 'control');
  assert.deepEqual(redundantBackups(plan, { newest: outside, backupTag: 'test' }), [], 'newest outside the folder');
  assert.deepEqual(redundantBackups(plan, { newest: misnamed, backupTag: 'test' }), [], 'newest not named as a copy');
});

test('prunableFolder refuses a filesystem root and the home folder, also through a symbolic link', () => {
  const inside = path.join(home, `pf-${sequence++}`, '.claude');
  fs.mkdirSync(inside, { recursive: true });
  assert.equal(prunableFolder(inside, home), true, 'control: a folder under home');
  assert.equal(prunableFolder(path.parse(inside).root, home), false, 'a filesystem root');
  assert.equal(prunableFolder(home, home), false, 'the home folder');
  assert.equal(prunableFolder(path.join(inside, '..', '..'), home), false, 'the home folder spelled with ..');
  assert.equal(prunableFolder(path.join(home, 'no-such-folder'), home), false, 'a folder that does not resolve');
  assert.equal(prunableFolder(inside, ''), false, 'no home folder known');
  const link = path.join(home, `home-link-${sequence++}`);
  let linked = true;
  // A junction needs no privilege on Windows; elsewhere a directory symlink.
  try { fs.symlinkSync(home, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
    if (process.platform !== 'win32') throw error;
    linked = false;
  }
  if (linked) {
    assert.equal(prunableFolder(link, home), false, 'a symbolic link to the home folder');
    assert.equal(prunableFolder(home, link), false, 'the home folder named through a symbolic link');
    assert.equal(prunableFolder(inside, link), true, 'control: a folder under a linked home');
  }
});

// The user's original bytes are the only record of how they wrote the file; the JSON editor
// re-serializes, so a copy it would not write back byte for byte is never redundant.
const ORIGINALS = {
  'a 4-space indent': JSON.stringify({ env: { KEEP: 'x' } }, null, 4) + '\n',
  'a number spelled 1.0': '{\n  "ratio": 1.0,\n  "env": {\n    "KEEP": "x"\n  }\n}\n',
  'an integer beyond 2^53': '{\n  "big": 12345678901234567890,\n  "env": {\n    "KEEP": "x"\n  }\n}\n',
  'a duplicated key': '{\n  "env": {\n    "OLD": "mine"\n  },\n  "env": {\n    "KEEP": "x"\n  }\n}\n',
  'no trailing newline': JSON.stringify({ env: { KEEP: 'x' } }, null, 2),
  'an escape': '{\n  "env": {\n    "KEEP": "\\u0078"\n  }\n}\n',
};

test('a copy whose bytes the editor would not write (the user\'s original) is kept', () => {
  for (const [label, original] of Object.entries(ORIGINALS)) {
    const root = project();
    const local = paths.projectSettingsLocal(root);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, original);
    const first = newCopy(local, 'test', () => run(root, { A: 'v1' }));
    const middle = newCopy(local, 'test', () => run(root, { A: 'v2' }));
    assert.deepEqual(copiesOf(local, 'test'), [first, middle].sort(), `${label}: both copies remain`);
    assert.equal(fs.readFileSync(path.join(path.dirname(local), first), 'utf8'), original, `${label}: the original bytes`);
    const newest = newCopy(local, 'test', () => run(root, { A: 'v1' }));
    assert.deepEqual(copiesOf(local, 'test'), [first, newest].sort(),
      `${label}: the original stays; ak's own middle copy is pruned`);
  }
});

test('an ak-written Codex config.toml copy round-trips through the AQE TOML editor and is pruned', () => {
  const root = project();
  const codex = path.join(root, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(codex, '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\n\n[mcp_servers.agentic-qe.env]\nKEEP = "yes"\n');
  const cfg = (endpoint) => ({ aqe: true, aqeEmbedding: { mode: 'endpoint', endpoint }, integrations: { hosts: { claude: false, codex: true } } });
  const reconcile = (endpoint) => reconcileAqeEmbeddingProjections(cfg(endpoint), root,
    { codexHome: path.join(root, 'codex-home'), claudeUserFile: path.join(root, 'claude-user.json') });
  newCopy(codex, 'aqe', () => assert.equal(reconcile('http://localhost:1111').ok, true));
  const middle = newCopy(codex, 'aqe', () => assert.equal(reconcile('http://localhost:2222').ok, true));
  assert.deepEqual(copiesOf(codex, 'aqe'), [middle], 'the original round-trips too, so it goes');
  const text = fs.readFileSync(path.join(path.dirname(codex), middle), 'utf8');
  const editor = aqeTomlEnvironment(text);
  assert.equal(aqeTomlEnvironment(text).render({ AQE_EMBEDDER_ENDPOINT: editor.current }), text,
    'ak\'s own TOML copy renders back byte for byte');
  const newest = newCopy(codex, 'aqe', () => assert.equal(reconcile('http://localhost:1111').ok, true));
  assert.deepEqual(copiesOf(codex, 'aqe'), [newest], 'ak\'s own TOML copy is pruned');
});
