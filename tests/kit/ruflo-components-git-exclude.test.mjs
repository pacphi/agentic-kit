// ADR-0058: ak's own .harness/mcp-policy.json stays out of git. A committed copy
// has no receipt on a teammate's machine, so reconcilePolicy would report it
// user-managed there and quietly stop managing it. Other tools (Agentic QE)
// commit their own .harness/mcp-policy.json on purpose, so ak never ignores
// .harness/ as a whole and never touches .gitignore: it adds one line to the
// repository's info/exclude, which git reads from the common dir (a linked
// worktree's own <main>/.git/worktrees/<name>/info/exclude is never read).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcilePolicy, excludeFromGit, POLICY_EXCLUDE_LINE } from '../../src/lib/ruflo-components/policy.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=ak', '-c', 'user.email=ak@example.invalid', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1',
    // The user's global config is kept out where /dev/null exists; `-c user.*` covers the rest.
    ...(process.platform === 'win32' ? {} : { GIT_CONFIG_GLOBAL: os.devNull }),
  } });
const ignored = (cwd, rel) => {
  try { git(cwd, 'check-ignore', '-q', rel); return true; } catch { return false; }
};
const count = (text, line) => text.split('\n').filter((l) => l === line).length;
const readOrNull = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-git-exclude-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  return { dir, main, exclude: path.join(main, '.git', 'info', 'exclude') };
}
const intent = { maxCallsPerMinute: 120 };

test('a written policy is excluded once, and git ignores it; .gitignore is never touched', (t) => {
  const { main, exclude } = repo(t);
  const receipts = {};
  const first = reconcilePolicy(main, intent, receipts);
  assert.equal(first.status, 'written');
  assert.equal(first.gitExclude, 'added');
  const second = reconcilePolicy(main, intent, receipts);
  assert.equal(second.status, 'converged');
  assert.equal(second.gitExclude, 'present');
  const text = fs.readFileSync(exclude, 'utf8');
  assert.equal(count(text, POLICY_EXCLUDE_LINE), 1);
  assert.equal(count(text, '# agentic-kit'), 1);
  assert.ok(ignored(main, '.harness/mcp-policy.json'));
  assert.equal(fs.existsSync(path.join(main, '.gitignore')), false);
});

test('a policy ak already owned before this change gets the line on the next converged reconcile', (t) => {
  const { main, exclude } = repo(t);
  const receipts = {};
  reconcilePolicy(main, intent, receipts);
  fs.writeFileSync(exclude, '');
  assert.equal(reconcilePolicy(main, intent, receipts).gitExclude, 'added');
  assert.equal(count(fs.readFileSync(exclude, 'utf8'), POLICY_EXCLUDE_LINE), 1);
});

test('a missing info/ folder is created', (t) => {
  const { main, exclude } = repo(t);
  fs.rmSync(path.dirname(exclude), { recursive: true, force: true });
  assert.equal(excludeFromGit(main), 'added');
  assert.equal(count(fs.readFileSync(exclude, 'utf8'), POLICY_EXCLUDE_LINE), 1);
});

test('in a linked worktree the line lands in the main repository and applies there', (t) => {
  const { dir, main, exclude } = repo(t);
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(dir, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'side', wt);
  const result = reconcilePolicy(wt, intent, {});
  assert.equal(result.status, 'written');
  assert.equal(result.gitExclude, 'added');
  assert.equal(count(fs.readFileSync(exclude, 'utf8'), POLICY_EXCLUDE_LINE), 1);
  assert.equal(fs.existsSync(path.join(main, '.git', 'worktrees', 'wt', 'info', 'exclude')), false);
  assert.ok(ignored(wt, '.harness/mcp-policy.json'), 'git check-ignore from the worktree');
});

test('a foreign policy adds nothing', (t) => {
  const { main, exclude } = repo(t);
  fs.mkdirSync(path.join(main, '.harness'));
  fs.writeFileSync(path.join(main, '.harness', 'mcp-policy.json'), '{"auditLog":true}\n');
  const before = readOrNull(exclude);
  const result = reconcilePolicy(main, intent, {});
  assert.equal(result.status, 'user-managed');
  assert.equal(result.gitExclude, undefined);
  assert.equal(readOrNull(exclude), before);
  assert.equal(ignored(main, '.harness/mcp-policy.json'), false);
});

test('outside a repository: no-git', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-git-exclude-none-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(excludeFromGit(dir), 'no-git');
  assert.equal(reconcilePolicy(dir, intent, {}).gitExclude, 'no-git');
});

test('removing the policy removes only ak\'s line and its comment', (t) => {
  const { main, exclude } = repo(t);
  const receipts = {};
  reconcilePolicy(main, intent, receipts);
  fs.appendFileSync(exclude, 'my-own-scratch/\n');
  const removed = reconcilePolicy(main, false, receipts);
  assert.equal(removed.status, 'removed');
  assert.equal(removed.gitExclude, 'removed');
  const text = fs.readFileSync(exclude, 'utf8');
  assert.equal(count(text, POLICY_EXCLUDE_LINE), 0);
  assert.doesNotMatch(text, /# agentic-kit/);
  assert.match(text, /my-own-scratch\//, 'the user\'s own lines stay');
  assert.match(text, /# git ls-files --others --exclude-from/, 'git\'s template comments stay');
});

test('a dry run writes no exclude line', (t) => {
  const { main, exclude } = repo(t);
  const before = readOrNull(exclude);
  reconcilePolicy(main, intent, {}, { dryRun: true });
  assert.equal(readOrNull(exclude), before);
});
