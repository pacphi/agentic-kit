import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseClaude, parseCodex } from '../../src/lib/usage-parsers.mjs';
import { buildIndex, SCHEMA_VERSION, _resetForTest } from '../../src/lib/usage-index.mjs';
import { Rollout, usage, codexSandbox, stubDeps } from './helpers/codex-rollout.mjs';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const options = (sandbox) => ({ days: 14, now: NOW, roots: sandbox.roots,
  cachePath: sandbox.cachePath, deps: stubDeps() });

test('Claude declarations persist the first known SDK classification without changing legacy origin', () => {
  const line = (value) => `${JSON.stringify(value)}\n`;
  const raw = line({ type: 'user', timestamp: '2026-07-24T09:00:00Z', sessionId: 'sdk',
    entrypoint: 'sdk-py', message: { role: 'user', content: 'synthetic request' } })
    + line({ type: 'assistant', timestamp: '2026-07-24T09:01:00Z', sessionId: 'sdk',
      entrypoint: 'claude-desktop', message: { id: 'a', role: 'assistant', model: 'claude-opus-5',
        usage: { input_tokens: 5, output_tokens: 2 }, content: [{ type: 'text', text: 'synthetic response' }] } });
  const { session } = parseClaude(raw, { id: 'sdk' });
  assert.deepEqual(session.sessionOrigin, {
    origin: 'unknown', evidence: 'desktop-origin-not-declared', surface: 'claude-agent-sdk',
    initiator: 'automation', label: 'Claude Agent SDK', rawEvidence: { entrypoint: 'sdk-py' },
    attributes: [], thirdPartyProvider: null,
  });
});

test('Codex MCP declaration and imported copy use factory fields with existing accounting', () => {
  const native = new Rollout({ id: 'mcp' }).meta({ originator: 'codex_cli_rs', source: 'mcp' })
    .meta({ originator: 'Codex Desktop', source: 'vscode' }).turn().user().agent()
    .tokenCount(usage({ input: 100, output: 20 }));
  const parsed = parseCodex(native.toString(), { id: 'mcp' }).session;
  assert.deepEqual(parsed.sessionOrigin, {
    origin: 'unknown', evidence: 'desktop-origin-not-declared', surface: 'codex-mcp',
    initiator: 'agent', label: 'Codex MCP server',
    rawEvidence: { originator: 'codex_cli_rs', source: 'mcp', threadSource: 'user' },
    attributes: [], thirdPartyProvider: null,
  });
  assert.equal(parsed.prompts, 1);
  assert.equal(parsed.responses, 1);

  const imported = new Rollout({ id: 'copy' }).meta({ originator: 'Codex Desktop' })
    .taskStarted('external-import-turn-1').user('copied request').agent('copied response');
  const copy = parseCodex(imported.toString(), { id: 'copy' }).session;
  assert.equal(copy.imported, true);
  assert.equal(copy.sessionOrigin.origin, 'unknown');
  assert.equal(copy.sessionOrigin.evidence, 'imported-copy');
  assert.equal(copy.sessionOrigin.surface, 'unknown');
  assert.equal(copy.sessionOrigin.initiator, 'imported-copy');
  assert.deepEqual(copy.sessionOrigin.rawEvidence, {});
  assert.equal(copy.prompts, 0);
  assert.equal(copy.responses, 0);
  assert.deepEqual(copy.usage, []);
});

test('a late import marker still removes copied Desktop classification', () => {
  const copied = new Rollout({ id: 'late-copy' }).meta({ originator: 'Codex Desktop' });
  for (let i = 0; i < 45; i++) copied.raw('event_msg', { type: 'task_complete' });
  copied.taskStarted('external-import-turn-1');
  const session = parseCodex(copied.toString(), { id: 'late-copy' }).session;
  assert.equal(session.imported, true);
  assert.deepEqual(session.sessionOrigin, {
    origin: 'unknown', evidence: 'imported-copy', surface: 'unknown', initiator: 'imported-copy',
    label: 'Unknown', rawEvidence: {}, attributes: [], thirdPartyProvider: null,
  });
});

test('malformed declaration metadata cannot copy prompt text into classification', () => {
  const privateText = 'synthetic-private-prompt-content';
  const raw = `${JSON.stringify({ type: 'session_meta', payload: {
    id: 'bad', originator: { text: privateText }, source: ['mcp'], thread_source: privateText,
  } })}\n`;
  const session = parseCodex(raw, { id: 'bad' }).session;
  assert.equal(JSON.stringify(session.sessionOrigin).includes(privateText), false);
  assert.deepEqual(session.sessionOrigin.rawEvidence, {});
});

test('schema 25 reparses unchanged files into schema 26 and warm cache preserves classification and accounting', async () => {
  _resetForTest();
  const native = new Rollout({ id: 'sdk' }).meta({ originator: 'codex_sdk_ts' })
    .turn().user().agent().tokenCount(usage({ input: 100, output: 20 }));
  const imported = new Rollout({ id: 'copy' }).meta({ originator: 'Codex Desktop' })
    .taskStarted('external-import-turn-1').user('copied request');
  const sandbox = codexSandbox({
    'rollout-2026-07-24T09-00-00-sdk.jsonl': native.toString(),
    'rollout-2026-07-24T09-00-00-copy.jsonl': imported.toString(),
  });
  const before = await buildIndex(options(sandbox));
  assert.deepEqual({ sessions: before.totals.sessions, prompts: before.totals.prompts,
    responses: before.totals.responses, tokens: before.totals.tokens, cost: before.totals.cost,
    importedExcluded: before.sourceHealth.codex.diagnostics.importedExcluded },
  { sessions: 1, prompts: 1, responses: 1, tokens: 120, cost: 1, importedExcluded: 1 });
  const old = JSON.parse(fs.readFileSync(sandbox.cachePath, 'utf8'));
  old.schemaVersion = 25;
  for (const entry of Object.values(old.entries)) {
    entry.session.sessionOrigin = { origin: entry.session.sessionOrigin.origin,
      evidence: entry.session.sessionOrigin.evidence };
  }
  fs.writeFileSync(sandbox.cachePath, JSON.stringify(old));

  _resetForTest();
  const cold = await buildIndex(options(sandbox));
  assert.equal(SCHEMA_VERSION, 26);
  assert.equal(cold.sourceHealth.codex.diagnostics.cachedFiles, 0);
  assert.equal(cold.sourceHealth.codex.diagnostics.importedExcluded, 1);
  assert.deepEqual(cold.totals, before.totals);
  assert.equal(cold.sessions[0].sessionOrigin.surface, 'codex-sdk');
  assert.equal(cold.sessions[0].sessionOrigin.initiator, 'automation');
  const cache = JSON.parse(fs.readFileSync(sandbox.cachePath, 'utf8'));
  assert.equal(cache.schemaVersion, 26);
  assert.ok(Object.values(cache.entries).some((entry) => entry.session.sessionOrigin.surface === 'codex-sdk'));

  _resetForTest();
  const warm = await buildIndex(options(sandbox));
  assert.equal(warm.sourceHealth.codex.diagnostics.cachedFiles, 2);
  assert.equal(warm.sourceHealth.codex.diagnostics.importedExcluded, 1);
  assert.deepEqual(warm.totals, cold.totals);
  assert.deepEqual(warm.sessions[0].sessionOrigin, cold.sessions[0].sessionOrigin);
});
