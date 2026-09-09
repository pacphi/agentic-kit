import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { costOf } from '../../src/lib/pricing.mjs';

const script = fileURLToPath(new URL('../../scripts/codex-usage-diagnostic.mjs', import.meta.url));
function run(t, records, json = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'PRIVATE-DIAGNOSTIC-ROOT-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '2026', '09', '09');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-private-session.jsonl'), records.map(JSON.stringify).join('\n'));
  const result = spawnSync(process.execPath, [script, '--root', root, ...(json ? ['--json'] : [])], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('PRIVATE-DIAGNOSTIC-ROOT'));
  return json ? JSON.parse(result.stdout) : result.stdout;
}
const meta = (thread_source) => ({ type: 'session_meta', payload: { thread_source } });
const body = (model = 'gpt-5.6-sol', reply = { type: 'agent_message' }) => [
  { type: 'turn_context', payload: { model } },
  { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000000, cached_input_tokens: 100000, output_tokens: 1000 } } } },
  { type: 'event_msg', payload: reply },
];

test('diagnostic keeps first metadata ownership despite replayed parent', (t) => {
  const report = run(t, [meta('subagent'), meta('user'), ...body()]);
  assert.equal(report.threadSourceCounts.subagent, 1);
  assert.equal(report.tokens.afterFix_excludingSubagentReplays.total, 0);
});
test('diagnostic handles current item_completed assistant responses', (t) => {
  const report = run(t, [meta('user'), ...body('gpt-5.6-sol', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'private' }] } })]);
  assert.equal(report.parsedAsSessions, 1);
});
test('missing thread source stays unknown even after later replayed metadata', (t) => {
  const report = run(t, [meta(undefined), meta('subagent'), ...body()]);
  assert.equal(report.threadSourceCounts.unknown, 1);
  assert.equal(report.threadSourceCounts.subagent, 0);
});
test('human and JSON output contain no supplied paths or arbitrary source text', (t) => {
  for (const json of [true, false]) {
    const report = run(t, [meta('PRIVATE-DIAGNOSTIC-ROOT-source'), ...body()], json);
    assert.ok(!JSON.stringify(report).includes('PRIVATE-DIAGNOSTIC-ROOT'));
  }
});
for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5-pro', 'gpt-5.4-pro', 'gpt-5.6', 'unknown']) {
  test(`diagnostic shares current model pricing: ${model}`, (t) => {
    const report = run(t, [meta('user'), ...body(model)]);
    assert.equal(report.tokens.afterFix_excludingSubagentReplays.cost, costOf({ model, input: 900000, output: 1000, cacheRead: 100000 }));
  });
}
test('rollout without metadata reports unknown source and retains usage', (t) => {
  const report = run(t, body());
  assert.equal(report.threadSourceCounts.unknown, 1);
  assert.equal(report.threadSourceCounts.user, 0);
  assert.equal(report.tokens.afterFix_excludingSubagentReplays.total, 1001000);
});
test('first user metadata wins and user-only item is not a response', (t) => {
  assert.equal(run(t, [meta('user'), meta('subagent'), ...body()]).threadSourceCounts.user, 1);
  const report = run(t, body('gpt-5.6-sol', { type: 'item_completed', item: { type: 'UserMessage' } }));
  assert.equal(report.parsedAsSessions, 0);
});
