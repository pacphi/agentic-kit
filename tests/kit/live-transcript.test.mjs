import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adaptClaudeTranscriptRecord,
  adaptCodexTranscriptRecord,
  TranscriptStreams,
} from '../../src/lib/live/index.mjs';
import { waitUntil } from './helpers/wait-until.mjs';

const line = (value) => `${JSON.stringify(value)}\n`;
const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-transcript-'));
  const claude = path.join(dir, 'claude', 'project');
  const codex = path.join(dir, 'codex', '2026', '07', '27');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  return {
    dir, claude, codex,
    roots: { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex') },
  };
};

test('Claude transcript adapter distinguishes people, harness output, tools and reasoning', () => {
  const user = adaptClaudeTranscriptRecord({
    type: 'user', sessionId: 's1', timestamp: '2026-07-27T12:00:00Z',
    message: { content: [{ type: 'text', text: 'Please inspect auth' }] },
  }, { sessionId: 's1' });
  assert.deepEqual(user.map((event) => [event.kind, event.actor.role, event.text]), [
    ['message', 'user', 'Please inspect auth'],
  ]);

  const assistant = adaptClaudeTranscriptRecord({
    type: 'assistant', sessionId: 's1', timestamp: '2026-07-27T12:00:01Z',
    message: { model: 'claude-x', content: [
      { type: 'thinking', thinking: 'Check boundaries' },
      { type: 'text', text: 'I found the route.' },
      { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/secret' } },
    ] },
  }, { sessionId: 's1' });
  assert.deepEqual(assistant.map((event) => event.kind), ['reasoning', 'message', 'tool-call']);
  assert.equal(assistant[2].details.includes('/secret'), true);

  const result = adaptClaudeTranscriptRecord({
    type: 'user', sessionId: 's1',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call-1',
      content: 'PRIVATE TOOL OUTPUT' }] },
  }, { sessionId: 's1' });
  assert.equal(result[0].actor.role, 'tool');
  assert.equal(result[0].kind, 'tool-result');
  assert.equal(result[0].details, 'PRIVATE TOOL OUTPUT');
});

test('Codex transcript adapter excludes encrypted reasoning and preserves local tool evidence', () => {
  const reasoning = adaptCodexTranscriptRecord({
    type: 'response_item', timestamp: '2026-07-27T12:00:00Z',
    payload: {
      id: 'r1', type: 'reasoning', encrypted_content: 'PRIVATE CIPHERTEXT',
      summary: [{ type: 'summary_text', text: 'Inspect the parser' }],
    },
  }, { sessionId: 's1' });
  assert.equal(reasoning[0].kind, 'reasoning');
  assert.equal(reasoning[0].text, 'Inspect the parser');
  assert.equal(JSON.stringify(reasoning).includes('PRIVATE CIPHERTEXT'), false);

  const call = adaptCodexTranscriptRecord({
    type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: 'c1', name: 'shell',
      input: 'TOKEN=PRIVATE command',
    },
  }, { sessionId: 's1' });
  assert.equal(call[0].kind, 'tool-call');
  assert.equal(call[0].details, 'TOKEN=PRIVATE command');

  const output = adaptCodexTranscriptRecord({
    type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: 'c1', output: 'command output',
    },
  }, { sessionId: 's1' });
  assert.equal(output[0].details, 'command output');

  const patch = adaptCodexTranscriptRecord({
    type: 'event_msg', payload: {
      type: 'patch_apply_end', status: 'completed',
      changes: [{ path: 'src/app.mjs', additions: 4, deletions: 1 }],
    },
  }, { sessionId: 's1' });
  assert.equal(patch[0].kind, 'status');
  assert.equal(patch[0].details.includes('src/app.mjs'), true);

  const delegated = adaptCodexTranscriptRecord({
    type: 'event_msg', payload: {
      id: 'sub-activity-1', type: 'sub_agent_activity',
      agent_id: 'agent-42', agent_name: 'Tester', activity: 'running tests',
    },
  }, { sessionId: 's1', actorId: 'primary' });
  assert.deepEqual(delegated[0].target,
    { id: 'agent-42', role: 'subagent', label: 'Tester' });
  assert.equal(delegated[0].relation, 'delegates');
});

test('Codex transcript adapter recognizes the newer item_completed generation, not just legacy user/agent_message', () => {
  const input = adaptCodexTranscriptRecord({
    type: 'event_msg', timestamp: '2026-07-27T12:00:00Z',
    payload: { id: 'ic-1', type: 'item_completed', item: { type: 'UserMessage', text: 'hello codex' } },
  }, { sessionId: 's1' });
  assert.equal(input.length, 1);
  assert.equal(input[0].kind, 'message');
  assert.equal(input[0].actor.role, 'user');
  assert.equal(input[0].text, 'hello codex');

  const output = adaptCodexTranscriptRecord({
    type: 'event_msg', timestamp: '2026-07-27T12:00:01Z',
    payload: {
      id: 'ic-2', type: 'item_completed',
      item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'reply text' }] },
    },
  }, { sessionId: 's1' });
  assert.equal(output.length, 1);
  assert.equal(output[0].kind, 'message');
  assert.equal(output[0].actor.role, 'assistant');
  assert.equal(output[0].text, 'reply text');

  const unknown = adaptCodexTranscriptRecord({
    type: 'event_msg', timestamp: '2026-07-27T12:00:02Z',
    payload: { id: 'ic-3', type: 'item_completed', item: { type: 'Reasoning', text: 'internal' } },
  }, { sessionId: 's1' });
  assert.deepEqual(unknown, []);
});

test('Codex transcript stream suppresses the duplicated event/response message pair', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.codex, 'rollout-2026-07-27T12-00-00-s1.jsonl'), [
    line({ type: 'event_msg', timestamp: '2026-07-27T12:00:01.000Z',
      payload: { type: 'agent_message', id: 'event-1', message: 'same answer' } }),
    line({ type: 'response_item', timestamp: '2026-07-27T12:00:01.100Z',
      payload: { type: 'message', id: 'response-1', role: 'assistant',
        content: [{ type: 'output_text', text: 'same answer' }] } }),
  ].join(''));
  const streams = new TranscriptStreams({ roots: sb.roots, mask: String });
  assert.deepEqual(
    streams.open('codex', 's1').snapshot().events.map((event) => event.text),
    ['same answer'],
  );
  streams.close();
});

test('selected transcript stream masks strings, bounds history and tails appends', async (t) => {
  const sb = sandbox();
  const file = path.join(sb.claude, 's1.jsonl');
  fs.writeFileSync(file, [
    line({ type: 'user', sessionId: 's1', timestamp: '2026-07-27T12:00:00Z',
      message: { content: 'old first' } }),
    line({ type: 'assistant', sessionId: 's1', timestamp: '2026-07-27T12:00:01Z',
      message: { content: [{ type: 'text', text: 'Bearer abcdefghijklmnop' }] } }),
  ].join(''));
  const streams = new TranscriptStreams({
    roots: sb.roots, intervalMs: 10, maxHistoryEntries: 1,
    mask: (text) => String(text).replace(/Bearer \S+/g, 'Bearer …redacted'),
  });
  t.after(() => streams.close());
  const stream = streams.open('claude', 's1');
  assert.equal(stream.snapshot().events.length, 1);
  assert.equal(stream.snapshot().events[0].text, 'Bearer …redacted');
  const received = [];
  stream.subscribe((event) => received.push(event));
  fs.appendFileSync(file, line({
    type: 'assistant', sessionId: 's1', timestamp: '2026-07-27T12:00:02Z',
    message: { content: [{ type: 'text', text: 'live update' }] },
  }));
  await waitUntil(() => received.at(-1)?.text === 'live update', 'the live-tailed append was never observed');
  assert.equal(received.at(-1)?.text, 'live update');
  assert.equal(stream.replay(stream.snapshot().cursor).events.length, 0);
});

test('selected stream exposes rich tool evidence only after final masking and visible truncation', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.claude, 's1.jsonl'), line({
    type: 'assistant', sessionId: 's1',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash',
      input: { command: `TOKEN=PRIVATE ${'x'.repeat(400)}` } }] },
  }));
  const streams = new TranscriptStreams({
    roots: sb.roots, maxTextChars: 256,
    mask: (text) => String(text).replace('TOKEN=PRIVATE', 'TOKEN=…redacted'),
  });
  const event = streams.open('claude', 's1').snapshot().events[0];
  assert.equal(event.details.includes('TOKEN=PRIVATE'), false);
  assert.equal(event.details.includes('TOKEN=…redacted'), true);
  assert.equal(event.detailsTruncated, true);
  assert.equal(event.details.endsWith('…[truncated]'), true);
  streams.close();
});

test('selected transcript lookup rejects invalid ids, missing files and symlink escapes', () => {
  const sb = sandbox();
  const outside = path.join(sb.dir, 'outside.jsonl');
  fs.writeFileSync(outside, line({ type: 'user', sessionId: 'escape', message: { content: 'x' } }));
  fs.symlinkSync(outside, path.join(sb.claude, 'escape.jsonl'));
  const streams = new TranscriptStreams({ roots: sb.roots, mask: String });
  assert.throws(() => streams.open('other', 'x'), /invalid transcript host/);
  assert.throws(() => streams.open('claude', '../x'), /invalid session id/);
  assert.throws(() => streams.open('claude', 'missing'), /not found/);
  assert.throws(() => streams.open('claude', 'escape'), /outside transcript root/);
  streams.close();
});

test('selected stream resets stale and cross-stream cursors', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.claude, 's1.jsonl'),
    line({ type: 'user', sessionId: 's1', message: { content: 'one' } }));
  fs.writeFileSync(path.join(sb.claude, 's2.jsonl'),
    line({ type: 'user', sessionId: 's2', message: { content: 'two' } }));
  const streams = new TranscriptStreams({ roots: sb.roots, mask: String, replayCapacity: 1 });
  const one = streams.open('claude', 's1');
  const two = streams.open('claude', 's2');
  assert.equal(two.replay(one.snapshot().cursor).reset, true);
  streams.close();
});

test('selected stream stops reading when its path becomes an escaping symlink', async (t) => {
  const sb = sandbox();
  const file = path.join(sb.claude, 's1.jsonl');
  const outside = path.join(sb.dir, 'outside.jsonl');
  fs.writeFileSync(file, line({ type: 'user', sessionId: 's1', message: { content: 'safe' } }));
  fs.writeFileSync(outside, line({
    type: 'assistant', sessionId: 's1',
    message: { content: [{ type: 'text', text: 'PRIVATE OUTSIDE' }] },
  }));
  const streams = new TranscriptStreams({ roots: sb.roots, mask: String, intervalMs: 10 });
  t.after(() => streams.close());
  const stream = streams.open('claude', 's1');
  const seen = [];
  stream.subscribe((event) => seen.push(event));
  fs.unlinkSync(file);
  fs.symlinkSync(outside, file);
  // Proving an ABSENCE has no positive event to poll for — waitUntil doesn't
  // apply. Generous margin (10x the 10ms tailer interval) instead of the
  // original 3.5x, so this doesn't read as a false pass on a fast run that
  // just didn't give the (hypothetically buggy) tailer enough ticks to leak.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(JSON.stringify(seen).includes('PRIVATE OUTSIDE'), false);
});

test('selected stream content is destroyed shortly after its last client releases it', async (t) => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.claude, 's1.jsonl'),
    line({ type: 'user', sessionId: 's1', message: { content: 'one' } }));
  // Deliberately a fixed sleep, not waitUntil: polling by calling open()
  // would itself clear the idle timer under test (see release()'s
  // `if (prior.timer) clearTimeout(...)`), so any condition-check that calls
  // open() defeats the very teardown being verified. idleMs=50 with a 150ms
  // wait (3x margin) replaces the old idleMs=10/wait=25ms pairing, which left
  // almost no headroom against scheduler jitter on a loaded runner.
  const streams = new TranscriptStreams({ roots: sb.roots, mask: String, idleMs: 50 });
  t.after(() => streams.close());
  const first = streams.open('claude', 's1');
  streams.release('claude', 's1');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = streams.open('claude', 's1');
  assert.notEqual(second, first);
});

test('selected stream carries an existing partial JSONL record into the live tail', async (t) => {
  const sb = sandbox();
  const file = path.join(sb.claude, 's1.jsonl');
  const record = JSON.stringify({
    type: 'assistant', sessionId: 's1',
    message: { content: [{ type: 'text', text: 'completed later' }] },
  });
  fs.writeFileSync(file, record.slice(0, -2));
  const streams = new TranscriptStreams({ roots: sb.roots, mask: String, intervalMs: 10 });
  t.after(() => streams.close());
  const stream = streams.open('claude', 's1');
  const seen = [];
  stream.subscribe((event) => seen.push(event));
  fs.appendFileSync(file, `${record.slice(-2)}\n`);
  await waitUntil(() => seen[0]?.text === 'completed later', 'the completed partial JSONL record was never tailed in');
  assert.equal(seen[0]?.text, 'completed later');
});

test('selected stream builds a deterministic bounded playback timeline with live handoff', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.claude, 's1.jsonl'), [
    line({ type: 'assistant', sessionId: 's1', timestamp: '2026-07-27T12:00:10Z',
      message: { content: [{ type: 'text', text: 'second' }] } }),
    line({ type: 'user', sessionId: 's1', timestamp: '2026-07-27T12:00:00Z',
      message: { content: 'first' } }),
    line({ type: 'assistant', sessionId: 's1', timestamp: '2026-07-27T12:00:20Z',
      message: { content: [{ type: 'text', text: 'third' }] } }),
  ].join(''));
  const streams = new TranscriptStreams({
    roots: sb.roots, mask: String, maxHistoryEntries: 2, replayCapacity: 2,
  });
  const stream = streams.open('claude', 's1');
  const full = stream.playback();
  assert.equal(full.sessionKey, 'claude:s1');
  assert.equal(full.range.startedAt, '2026-07-27T12:00:00.000Z');
  assert.equal(full.range.endedAt, '2026-07-27T12:00:20.000Z');
  assert.equal(full.range.durationMs, 20_000);
  assert.equal(full.range.eventCount, 2);
  assert.equal(full.range.truncated, true);
  assert.equal(full.startAt, '2026-07-27T12:00:00.000Z');
  assert.equal(full.endAt, '2026-07-27T12:00:20.000Z');
  assert.equal(full.durationMs, 20_000);
  assert.equal(full.truncated, true);
  assert.equal(full.gap, true);
  assert.deepEqual(full.transcript.items.map((event) => [event.text, event.elapsedMs]), [
    ['first', 0], ['third', 20_000],
  ]);
  assert.equal(Object.hasOwn(full.events[0], 'text'), false,
    'canvas events must not duplicate rich transcript bodies');
  assert.equal(full.live.cursor, stream.snapshot().cursor);
  assert.equal(full.live.eventsEndpoint, '/api/live/transcripts/claude/s1/events');

  const seek = stream.playback({ atMs: 5_000 });
  assert.equal(seek.seek.requestedMs, 5_000);
  assert.equal(seek.seek.atMs, 5_000);
  assert.equal(seek.seek.eventIndex, 0);
  assert.deepEqual(seek.transcript.items.map((event) => event.text), ['first']);
  assert.deepEqual(stream.playback({ atMs: 5_000 }), seek,
    'the same retained history and seek point must reconstruct identically');
  streams.close();
});
