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

test('the verdict fails the job on a read error or a dispatch error', () => {
  const watch = job('watch');
  const verdict = watch.slice(watch.indexOf('name: Verdict'));
  assert.match(verdict, /\[ "\$\(jq '\(\.fetchErrors \| length\) \+ \(\.dispatchErrors \| length\)' watch\.json\)" -eq 0 \]/);
  assert.doesNotMatch(verdict, /^\s+if:/m, 'the verdict runs on dry runs too');
});

test('both summaries say how many routine sessions a run would start, and which', () => {
  const preview = job('preview');
  const watch = job('watch');
  const record = watch.slice(watch.indexOf('name: Record'), watch.indexOf('name: Push the ledger commit'));
  for (const [name, step] of [['preview', preview], ['record', record]]) {
    assert.match(step, /would fire \\\(\.wouldFire \| length\)/, name);
    assert.match(step, /jq -r '\(\.wouldFire \/\/ \[\]\)\[\] \| "- would fire \\\(\.id\) \\\(\.version\) \\\(\.branch\)"' watch\.json/, name);
  }
  assert.match(record, /deferred \\\(\.deferred \| length\)/, 'the summary counts fixes deferred to the next run');
  assert.match(record, /jq -r '\(\.deferred \/\/ \[\]\)\[\] \| "- deferred \\\(\.id\) \\\(\.version\) \\\(\.branch\)"' watch\.json/);
  assert.match(record, /# 3 = blind: [^\n]*\n\s*# or a ledger commit that could not be built\./);
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

test('the docs describe the ledger branch, commit-comment notices and the API trigger', () => {
  const doc = fs.readFileSync('docs/upstream-watch.md', 'utf8').replace(/\r\n/g, '\n');
  const daily = doc.slice(doc.indexOf('## The daily workflow'), doc.indexOf('## The dispatch routine'));
  const routine = doc.slice(doc.indexOf('## The dispatch routine'));
  assert.match(daily, /`17 14 \* \* \*`/);
  assert.match(daily, /Record.*Push.*Notify.*Verdict/s);
  assert.match(doc, /## Notifications\n/);
  assert.match(routine, /\*\*Trigger:\*\* API only\./);
  assert.match(routine, /code\.claude\.com\/docs\/en\/routines#add-an-api-trigger/);
  assert.match(routine, /prompt, not permissions|instructions in its prompt, not permissions/);
  for (const stale of [/upstream-dispatch/, /15:07/, /7 15 \* \* \*/, /upstream-watch\.mjs comment/, /--ledger <file>/]) assert.doesNotMatch(doc, stale);
});

test('current-state docs carry no trace of the comment ledger', () => {
  for (const file of ['docs/maintainer.md', 'docs/ddd/ubiquitous-language.md', '.claude/skills/akm-upstream-status/SKILL.md', '.agents/skills/akm-upstream-status/SKILL.md']) {
    const text = fs.readFileSync(file, 'utf8');
    for (const stale of [/#243/, /upstream-dispatch/, /ledger\.authors/, /upstream-watch\.mjs comment/, /--ledger /, /locked "Upstream watch"/]) {
      assert.doesNotMatch(text, stale, `${file}: ${stale}`);
    }
  }
});
