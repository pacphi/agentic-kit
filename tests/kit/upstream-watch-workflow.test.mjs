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

test('the watch runs daily at 14:00 UTC and on demand', () => {
  assert.match(text, /schedule:\n\s+- cron: '0 14 \* \* \*'/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /^permissions:\n {2}contents: read\n/m, 'the workflow default is read-only');
});

test('a pull request only previews, with a read-only token', () => {
  const preview = job('preview');
  assert.match(preview, /if: github\.event_name == 'pull_request'/);
  assert.match(preview, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(preview, /issues: write|gh issue|gh label/);
  assert.match(preview, /upstream-watch\.mjs comment --json/);
});

test('the scheduled job posts the checked body once and signals dispatch by label', () => {
  const watch = job('watch');
  assert.match(watch, /if: github\.event_name != 'pull_request'/);
  assert.match(watch, /permissions:\n\s+contents: read\n\s+issues: write\n/);
  assert.match(watch, /concurrency:\n\s+group: upstream-watch\n\s+cancel-in-progress: false/);
  assert.match(watch, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  const post = watch.indexOf('gh issue comment');
  for (const guard of ['test -s body.md', "[ \"$(head -n 1 body.md)\" = '```text' ]", "grep -q '^checked-at ' body.md"]) {
    const at = watch.indexOf(guard);
    assert.ok(at > 0 && at < post, `${guard} runs before posting`);
  }
  assert.equal(watch.split('gh issue comment').length - 1, 1, 'one comment per run');
  assert.match(watch.slice(post), /repos\/\$repo\/issues\/comments\/\$id/, 'the posted length is read back');
  assert.ok(watch.indexOf('--add-label') > post, 'the dispatch label follows the comment it points at');
  assert.ok(watch.indexOf('--remove-label') < watch.indexOf('--add-label'), 'a label already present is removed first so the add is a new event');
});

test('the dispatch label is the one the docs give the routine', () => {
  const label = /DISPATCH_LABEL: ([\w-]+)/.exec(text)[1];
  const doc = fs.readFileSync('docs/UPSTREAM-WATCH.md', 'utf8');
  assert.ok(doc.includes(`\`${label}\``), `docs/UPSTREAM-WATCH.md names the ${label} label`);
});
