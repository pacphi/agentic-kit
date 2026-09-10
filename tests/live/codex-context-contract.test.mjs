// Opt in to three short model requests with AK_CODEX_CONTEXT_CONFORMANCE=1.
// Proves native allocation/clamping, not successful use of an 828K-token prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { contextHome } from '../../src/lib/codex-context-config.mjs';

const enabled = process.env.AK_CODEX_CONTEXT_CONFORMANCE === '1';
const clientVersion = process.env.AK_CODEX_CONTEXT_CLIENT_VERSION ?? '0.154.0';
for (const [model, expected] of [['gpt-6-astra', 828400], ['gpt-5.6-sol', 828400], ['gpt-5.5', 258400]]) {
  test(`Codex ${clientVersion} native per-model clamp: ${model}`, { skip: !enabled, timeout: 65000 }, t => {
    assert.equal(spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 }).stdout.trim(), `codex-cli ${clientVersion}`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-context-contract-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const result = spawnSync('codex', ['exec', '--skip-git-repo-check', '-C', cwd, '-s', 'read-only',
      '-m', model, ...(process.env.AK_CODEX_CONTEXT_USE_CONFIG === '1' ? [] : ['-c', 'model_context_window=1050000']), '-c', 'model_reasoning_effort="low"',
      '--json', 'Reply exactly AK_CAPACITY_OK. Do not call any tools.'], { encoding: 'utf8', timeout: 55000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, 'native smoke request must complete');
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    const id = events.find(e => e.type === 'thread.started')?.thread_id;
    assert.ok(id);
    assert.ok(events.some(e => e.item?.text === 'AK_CAPACITY_OK'));
    const sessions = path.join(contextHome(), 'sessions');
    const files = fs.readdirSync(sessions, { recursive: true }).filter(name => name.endsWith(`${id}.jsonl`));
    assert.equal(files.length, 1);
    const records = fs.readFileSync(path.join(sessions, files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const windows = records.filter(r => r.type === 'event_msg' && r.payload.type === 'token_count')
      .map(r => r.payload.info?.model_context_window).filter(Number.isFinite);
    assert.ok(windows.length);
    assert.ok(windows.every(window => window === expected));
  });
}
