// The scheduled upstream watch workflow (decision 14): pins what it may write,
// when it runs, and that it posts only the script's checked comment body.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const FILE = '.github/workflows/upstream-watch.yml';
// A Windows checkout gives the YAML CRLF line endings; the checks are about its text.
const text = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
const job = (name) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start > 0, `job ${name} exists`);
  const next = text.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
};

test('the watch runs daily off the hour and on demand, read-only by default', () => {
  assert.match(text, /schedule:\n\s+- cron: '17 14 \* \* \*'/);
  assert.match(text, /workflow_dispatch:\n\s+inputs:\n\s+record:/);
  assert.match(text, /\n\s+since:\n\s+description:/);
  assert.match(text, /^permissions:\n {2}contents: read\n/m, 'the workflow default is read-only');
  assert.doesNotMatch(text, /issues: write|gh issue|gh label|DISPATCH_LABEL|upstream-watch\.mjs comment/);
});

test('a pull request only previews with a dry run and a read-only token', () => {
  const preview = job('preview');
  assert.match(preview, /if: github\.event_name == 'pull_request'/);
  assert.match(preview, /permissions:\n\s+contents: read\n\s+actions: read\n\s+pull-requests: read\n/);
  assert.match(preview, /upstream-watch\.mjs record --dry-run --json/);
  assert.doesNotMatch(preview, /git push|commits\/.*\/comments|UPSTREAM_DISPATCH_TOKEN/);
});

test('the scheduled job records, pushes, notifies and then judges, in that order', () => {
  const watch = job('watch');
  assert.match(watch, /if: github\.event_name != 'pull_request'/);
  assert.match(watch, /permissions:\n\s+contents: write\n\s+actions: read\n\s+pull-requests: read\n/);
  assert.match(watch, /concurrency:\n\s+group: upstream-watch\n\s+cancel-in-progress: false/);
  const order = ['name: Record', 'name: Push the ledger commit', 'name: Notify', 'name: Verdict'].map((step) => watch.indexOf(step));
  assert.ok(order.every((at) => at > 0), order.join(','));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'record, push, notify, verdict');
  assert.match(watch, /git push origin "\$commit:refs\/heads\/\$LEDGER_BRANCH"/);
  assert.match(watch, /gh api "repos\/\$GITHUB_REPOSITORY\/commits\/\$commit\/comments" -F body=@notice\.md/);
  assert.match(watch, /GIT_AUTHOR_NAME: github-actions\[bot\]/);
  assert.match(text, /LEDGER_BRANCH: upstream-watch-ledger/);
});

test('the trigger token reaches only the Record step, and the since input never meets the shell unquoted', () => {
  const watch = job('watch');
  assert.equal(text.split('secrets.UPSTREAM_DISPATCH_TOKEN').length - 1, 1, 'one reference');
  const record = watch.slice(watch.indexOf('name: Record'), watch.indexOf('name: Push the ledger commit'));
  assert.match(record, /UPSTREAM_DISPATCH_TOKEN: \$\{\{ secrets\.UPSTREAM_DISPATCH_TOKEN \}\}/);
  assert.match(record, /UPSTREAM_DISPATCH_ROUTINE: trig_01LmNVKJ4K86joHPvvPtc7yx/);
  assert.match(record, /SINCE: \$\{\{ inputs\.since \}\}/);
  assert.doesNotMatch(watch, /run:[^\n]*\$\{\{ inputs\./, 'inputs pass through env, not into run scripts');
});
