// MNT-ACT-015/016, J3: git-aware project patches preview a bounded diff,
// tolerate unrelated dirty files, refuse affected-path/index/submodule/
// symlink drift, never stash/commit/branch/push/merge, apply atomically with
// syntax validation and declared checks, and restore the exact preimage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGitProjectPatchProvider } from '../../src/lib/maintenance/providers/git-project-patch.mjs';
import { runNativeCommand } from '../../src/lib/maintenance/native-command.mjs';

const FORBIDDEN_VERBS = new Set(['stash', 'commit', 'branch', 'checkout', 'push', 'merge']);

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

function digestOf(content) {
  return createHash('sha256').update(content).digest('hex');
}

function gitRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-patch-repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  return root;
}

function commitFile(root, relPath, content) {
  fs.writeFileSync(path.join(root, relPath), content);
  execFileSync('git', ['-C', root, 'add', relPath]);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', `add ${relPath}`]);
}

function preimageRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-patch-preimages-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function spyRun(calls) {
  return async (binary, args, options) => {
    calls.push({ binary, args });
    return runNativeCommand(binary, args, options);
  };
}

function patchFinding(resourceId, overrides = {}) {
  return {
    resource: { id: resourceId, kind: 'project-file', name: resourceId, host: 'agentic-kit', scope: 'project' },
    safetyClass: 'approval-required',
    nextAction: { operation: 'apply-project-patch' },
    ...overrides,
  };
}

function undoEntry(action, outcome) {
  return {
    actionId: action.id, resourceIdentity: action.resourceIdentity, operation: action.operation,
    sourceFingerprint: action.sourceFingerprint, outcome,
  };
}

test('detect, actionFor, preflight, and apply patch one exact file while an unrelated file stays dirty (J3)', { skip: !gitAvailable && 'git is not available in this environment' }, async (t) => {
  const root = gitRepo(t);
  commitFile(root, 'config.json', '{"a":1}\n');
  const calls = [];
  const provider = createGitProjectPatchProvider({
    run: spyRun(calls), fsImpl: fs, projectRoots: () => [root], preimageRoot: preimageRoot(t),
    patches: [{
      resourceId: 'cfg-1', projectRoot: root, targetRelativePath: 'config.json',
      expectedPreimageDigest: digestOf('{"a":1}\n'), replacementContent: '{"a":2}\n', validation: 'json',
    }],
  });

  const facts = await provider.detect();
  const fact = facts.patches.find((row) => row.resourceId === 'cfg-1');
  assert.equal(fact.status, 'matches-preimage');

  const finding = patchFinding('cfg-1');
  const action = provider.actionFor(finding, facts);
  assert.equal(action.operation, 'apply-project-patch');
  assert.equal(action.rollback, 'reversible');
  assert.ok(Array.isArray(action.impact.preview) && action.impact.preview.length > 0, 'a bounded diff preview is attached');
  assert.ok(action.impact.preview.some((line) => line.startsWith('-')));
  assert.ok(action.impact.preview.some((line) => line.startsWith('+')));
  assert.equal('resourceIdentity' in action && 'name' in action.resourceIdentity, true);
  assert.equal(action.resourceIdentity.name.includes('/'), false, 'resourceIdentity fields never carry a raw path separator');

  // Unrelated dirty file must not block the exact patch.
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'noise');
  const preflight = await provider.preflight(action);
  assert.equal(preflight.ok, true);

  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'applied');
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), '{"a":2}\n');
  assert.equal(fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8'), 'noise', 'the unrelated dirty file is untouched');

  const verified = await provider.verify(action, outcome);
  assert.equal(verified.ok, true);

  const usedVerb = calls.some((call) => call.binary === 'git' && FORBIDDEN_VERBS.has(call.args[2] ?? call.args[0]));
  assert.equal(usedVerb, false, 'git was never invoked with a mutating verb');
});

test('apply refuses when the target changed after preview (affected-path drift)', { skip: !gitAvailable && 'git is not available in this environment' }, async (t) => {
  const root = gitRepo(t);
  commitFile(root, 'settings.json', '{"x":1}\n');
  const provider = createGitProjectPatchProvider({
    fsImpl: fs, projectRoots: () => [root], preimageRoot: preimageRoot(t),
    patches: [{
      resourceId: 'settings-1', projectRoot: root, targetRelativePath: 'settings.json',
      expectedPreimageDigest: digestOf('{"x":1}\n'), replacementContent: '{"x":2}\n', validation: 'json',
    }],
  });
  const facts = await provider.detect();
  const action = provider.actionFor(patchFinding('settings-1'), facts);
  assert.ok(action);

  fs.writeFileSync(path.join(root, 'settings.json'), '{"x":999}\n');
  const preflight = await provider.preflight(action);
  assert.equal(preflight.ok, false);
  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'refused');
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '{"x":999}\n', 'the drifted content is preserved untouched');
});

test('index drift on the exact target path refuses before apply, even though the byte content still matches', { skip: !gitAvailable && 'git is not available in this environment' }, async (t) => {
  const root = gitRepo(t);
  commitFile(root, 'staged.json', '{"y":1}\n');
  // Touch and re-stage the file so the index shows a pending change for this
  // exact path even though the working-tree bytes are unchanged.
  fs.writeFileSync(path.join(root, 'staged.json'), '{"y":1}\n');
  execFileSync('git', ['-C', root, 'add', 'staged.json']);
  fs.appendFileSync(path.join(root, 'staged.json'), '');
  execFileSync('git', ['-C', root, 'rm', '--cached', '-q', 'staged.json']);
  const provider = createGitProjectPatchProvider({
    fsImpl: fs, projectRoots: () => [root], preimageRoot: preimageRoot(t),
    patches: [{
      resourceId: 'staged-1', projectRoot: root, targetRelativePath: 'staged.json',
      expectedPreimageDigest: digestOf('{"y":1}\n'), replacementContent: '{"y":2}\n', validation: 'json',
    }],
  });
  const facts = await provider.detect();
  const fact = facts.patches.find((row) => row.resourceId === 'staged-1');
  assert.equal(fact.status, 'drift');
  assert.equal(fact.reason, 'index-or-worktree-drift');
});

test('a submodule target is refused and no git command touches it beyond status/ls-files', { skip: !gitAvailable && 'git is not available in this environment' }, async (t) => {
  const root = gitRepo(t);
  fs.mkdirSync(path.join(root, 'vendor', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitmodules'), '[submodule "lib"]\n\tpath = vendor/lib\n\turl = https://example.invalid/lib.git\n');
  fs.writeFileSync(path.join(root, 'vendor', 'lib', 'inner.json'), '{"z":1}\n');
  execFileSync('git', ['-C', root, 'add', '.gitmodules']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'add gitmodules']);
  const provider = createGitProjectPatchProvider({
    fsImpl: fs, projectRoots: () => [root], preimageRoot: preimageRoot(t),
    patches: [{
      resourceId: 'sub-1', projectRoot: root, targetRelativePath: 'vendor/lib/inner.json',
      expectedPreimageDigest: digestOf('{"z":1}\n'), replacementContent: '{"z":2}\n', validation: 'json',
    }],
  });
  const facts = await provider.detect();
  const fact = facts.patches.find((row) => row.resourceId === 'sub-1');
  assert.equal(fact.status, 'unsafe');
  assert.equal(fact.reason, 'submodule-target-forbidden');
});

test('a symlinked path segment is refused', { skip: !gitAvailable && 'git is not available in this environment' }, async (t) => {
  const root = gitRepo(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-patch-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'real.json'), '{"w":1}\n');
  fs.symlinkSync(outside, path.join(root, 'linked'));
  const provider = createGitProjectPatchProvider({
    fsImpl: fs, projectRoots: () => [root], preimageRoot: preimageRoot(t),
    patches: [{
      resourceId: 'link-1', projectRoot: root, targetRelativePath: 'linked/real.json',
      expectedPreimageDigest: digestOf('{"w":1}\n'), replacementContent: '{"w":2}\n', validation: 'json',
    }],
  });
  const facts = await provider.detect();
  const fact = facts.patches.find((row) => row.resourceId === 'link-1');
  assert.equal(fact.status, 'unsafe');
  assert.equal(fact.reason, 'symlink-in-path');
});

test('a project root outside the configured roots is refused (unsupported), never inspected', { skip: !gitAvailable && 'git is not available in this environment' }, async (t) => {
  const root = gitRepo(t);
  const otherRoot = gitRepo(t);
  commitFile(otherRoot, 'x.json', '{}\n');
  const provider = createGitProjectPatchProvider({
    fsImpl: fs, projectRoots: () => [root], preimageRoot: preimageRoot(t),
    patches: [{
      resourceId: 'outside-1', projectRoot: otherRoot, targetRelativePath: 'x.json',
      expectedPreimageDigest: digestOf('{}\n'), replacementContent: '{"a":1}\n', validation: 'json',
    }],
  });
  const facts = await provider.detect();
  const fact = facts.patches.find((row) => row.resourceId === 'outside-1');
  assert.equal(fact.status, 'unsupported');
  assert.equal(fact.reason, 'target-outside-configured-project-roots');
});

test('invalid JSON replacement content refuses before any file write', { skip: !gitAvailable && 'git is not available in this environment' }, async (t) => {
  const root = gitRepo(t);
  commitFile(root, 'broken.json', '{"a":1}\n');
  const provider = createGitProjectPatchProvider({
    fsImpl: fs, projectRoots: () => [root], preimageRoot: preimageRoot(t),
    patches: [{
      resourceId: 'broken-1', projectRoot: root, targetRelativePath: 'broken.json',
      expectedPreimageDigest: digestOf('{"a":1}\n'), replacementContent: '{not json', validation: 'json',
    }],
  });
  const facts = await provider.detect();
  const action = provider.actionFor(patchFinding('broken-1'), facts);
  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'refused');
  assert.match(outcome.summary, /validation/i);
  assert.equal(fs.readFileSync(path.join(root, 'broken.json'), 'utf8'), '{"a":1}\n');
});

test('a declared check failure restores the exact original bytes and reports a non-mutating refusal', { skip: !gitAvailable && 'git is not available in this environment' }, async (t) => {
  const root = gitRepo(t);
  commitFile(root, 'checked.json', '{"a":1}\n');
  const provider = createGitProjectPatchProvider({
    fsImpl: fs, projectRoots: () => [root], preimageRoot: preimageRoot(t),
    patches: [{
      resourceId: 'checked-1', projectRoot: root, targetRelativePath: 'checked.json',
      expectedPreimageDigest: digestOf('{"a":1}\n'), replacementContent: '{"a":2}\n', validation: 'json',
      declaredChecks: [{ binary: 'node', args: ['-e', 'process.exit(1)'] }],
    }],
  });
  const facts = await provider.detect();
  const action = provider.actionFor(patchFinding('checked-1'), facts);
  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'refused');
  assert.match(outcome.summary, /declared check failed/i);
  assert.equal(fs.readFileSync(path.join(root, 'checked.json'), 'utf8'), '{"a":1}\n', 'the original content was restored');
});

test('a passing declared check applies successfully and runs scoped to the project root', { skip: !gitAvailable && 'git is not available in this environment' }, async (t) => {
  const root = gitRepo(t);
  commitFile(root, 'ok.json', '{"a":1}\n');
  const calls = [];
  const provider = createGitProjectPatchProvider({
    run: spyRun(calls), fsImpl: fs, projectRoots: () => [root], preimageRoot: preimageRoot(t),
    patches: [{
      resourceId: 'ok-1', projectRoot: root, targetRelativePath: 'ok.json',
      expectedPreimageDigest: digestOf('{"a":1}\n'), replacementContent: '{"a":2}\n', validation: 'json',
      declaredChecks: [{ binary: 'node', args: ['-e', 'process.exit(0)'] }],
    }],
  });
  const facts = await provider.detect();
  const action = provider.actionFor(patchFinding('ok-1'), facts);
  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'applied');
  const checkCall = calls.find((call) => call.binary === 'node');
  assert.ok(checkCall);
});

test('undo restores the exact preimage bytes and verifyUndo confirms it', { skip: !gitAvailable && 'git is not available in this environment' }, async (t) => {
  const root = gitRepo(t);
  commitFile(root, 'restorable.json', '{"a":1}\n');
  const provider = createGitProjectPatchProvider({
    fsImpl: fs, projectRoots: () => [root], preimageRoot: preimageRoot(t),
    patches: [{
      resourceId: 'restorable-1', projectRoot: root, targetRelativePath: 'restorable.json',
      expectedPreimageDigest: digestOf('{"a":1}\n'), replacementContent: '{"a":2}\n', validation: 'json',
    }],
  });
  const facts = await provider.detect();
  const action = provider.actionFor(patchFinding('restorable-1'), facts);
  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'applied');
  assert.equal(fs.readFileSync(path.join(root, 'restorable.json'), 'utf8'), '{"a":2}\n');

  const entry = undoEntry(action, outcome);
  const undone = await provider.undo(entry);
  assert.equal(undone.status, 'restored');
  assert.equal(fs.readFileSync(path.join(root, 'restorable.json'), 'utf8'), '{"a":1}\n');

  const verified = await provider.verifyUndo(entry);
  assert.equal(verified.ok, true);
});

test('inspectCurrent reports a stable fingerprint before and after apply for interruption-audit reuse', { skip: !gitAvailable && 'git is not available in this environment' }, async (t) => {
  const root = gitRepo(t);
  commitFile(root, 'tracked.json', '{"a":1}\n');
  const provider = createGitProjectPatchProvider({
    fsImpl: fs, projectRoots: () => [root], preimageRoot: preimageRoot(t),
    patches: [{
      resourceId: 'tracked-1', projectRoot: root, targetRelativePath: 'tracked.json',
      expectedPreimageDigest: digestOf('{"a":1}\n'), replacementContent: '{"a":2}\n', validation: 'json',
    }],
  });
  const facts = await provider.detect();
  const action = provider.actionFor(patchFinding('tracked-1'), facts);
  const before = await provider.inspectCurrent(action);
  assert.equal(before.complete, true);
  const outcome = await provider.apply(action);
  const after = await provider.inspectCurrent(action);
  assert.equal(after.complete, true);
  assert.notEqual(before.postFingerprint, after.postFingerprint);
  assert.equal(after.postFingerprint, outcome.postFingerprint);
});

test('an unsafe YAML replacement (tab indentation) refuses validation before any write', { skip: !gitAvailable && 'git is not available in this environment' }, async (t) => {
  const root = gitRepo(t);
  commitFile(root, 'config.yaml', 'a: 1\n');
  const provider = createGitProjectPatchProvider({
    fsImpl: fs, projectRoots: () => [root], preimageRoot: preimageRoot(t),
    patches: [{
      resourceId: 'yaml-1', projectRoot: root, targetRelativePath: 'config.yaml',
      expectedPreimageDigest: digestOf('a: 1\n'), replacementContent: 'a:\n\tb: 1\n', validation: 'yaml',
    }],
  });
  const facts = await provider.detect();
  const action = provider.actionFor(patchFinding('yaml-1'), facts);
  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'refused');
  assert.equal(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'), 'a: 1\n');
});

test('provider construction requires at least one absolute project root', () => {
  assert.throws(() => createGitProjectPatchProvider({ projectRoots: () => [] }), /absolute project root/);
});
