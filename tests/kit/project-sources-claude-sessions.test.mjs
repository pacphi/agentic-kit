import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import { scanTranscriptCwds, discoverProjectSources } from '../../src/lib/footprint/project-sources.mjs';

function write(root, group, name, records) {
  const file = path.join(root, group, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

test('Claude project census counts declared sessions and excludes bridge and subagent files', () => {
  const root = tempDir('ak-claude-census');
  const claudeRoot = path.join(root, 'claude');
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  write(claudeRoot, 'a', '1.jsonl', [{ type: 'user', sessionId: 'one', cwd: a }]);
  write(claudeRoot, 'a', '2.jsonl', [{ type: 'assistant', sessionId: 'two', cwd: a }]);
  write(claudeRoot, 'a', '3.jsonl', [{ type: 'user', sessionId: 'one', cwd: b }]);
  write(claudeRoot, 'a', '4.jsonl', [{ type: 'user', cwd: a }]);
  write(claudeRoot, 'a', '5.jsonl', [{ type: 'user', sessionId: 12, cwd: a }]);
  write(claudeRoot, 'a', '6.jsonl', [{ type: 'bridge-session', sessionId: 'bridge', cwd: b }]);
  write(claudeRoot, 'a', '7.jsonl', [{ type: 'cost-state', sessionId: 'cost', cwd: b }]);
  write(claudeRoot, 'a/one/subagents', 'agent-a.jsonl', [
    { type: 'assistant', sessionId: 'child', cwd: b, isSidechain: true },
  ]);
  const scan = scanTranscriptCwds(claudeRoot, 'claude');
  assert.deepEqual({ files: scan.files, sessions: scan.sessions, duplicate: scan.duplicateSessionFiles,
    subagents: scan.subagentExcluded, nonConversation: scan.nonConversationExcluded,
    unknown: scan.unknownSessionFiles },
  { files: 8, sessions: 2, duplicate: 1, subagents: 1, nonConversation: 2, unknown: 2 });
  const result = discoverProjectSources({ claudeRoot, codexRoot: path.join(root, 'no-codex'),
    scanOpencode: () => ({ sightings: [], complete: true }) });
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].sessions, 2);
  assert.equal(result.projects[0].sessionOrigins[0].countBasis, 'declared-session-ids');
});

test('an incomplete head with cwd preserves project evidence but does not invent a session', () => {
  const root = tempDir('ak-claude-head');
  const claudeRoot = path.join(root, 'claude');
  write(claudeRoot, 'a', 'partial.jsonl', [
    { type: 'system', cwd: root, sessionId: 'later' },
    { type: 'user', cwd: root, sessionId: 'later' },
  ]);
  const scan = scanTranscriptCwds(claudeRoot, 'claude', { maxLines: 1 });
  assert.equal(scan.sessions, 0);
  assert.equal(scan.unknownSessionFiles, 1);
  assert.equal(scan.sightings[0].weight, 0);
  assert.equal(scan.withCwd, 1);
});

test('excluded-only folder cannot become a project through encoded directory recovery', () => {
  const root = tempDir('ak-claude-excluded');
  const claudeRoot = path.join(root, 'claude');
  write(claudeRoot, 'bridge-only', 'bridge.jsonl', [{ type: 'bridge-session', sessionId: 'bridge' }]);
  write(claudeRoot, 'bridge-only/parent/subagents', 'agent-a.jsonl',
    [{ type: 'assistant', sessionId: 'child', isSidechain: true }]);
  const scan = scanTranscriptCwds(claudeRoot, 'claude', { decodeDir: () => root });
  assert.equal(scan.recoveredFromDirName, 0);
  assert.equal(scan.unresolved, 0);
  assert.deepEqual(scan.sightings, []);
});
