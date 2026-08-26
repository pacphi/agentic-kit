// Opt-in live regression for qe-court PARTICIPANT TRANSPORT, not a court
// verdict. This uses the same bounded direct-host supervisor as `ak run` and
// deliberately avoids the deprecated nested `codex mcp-server` path.
// Seats run hermetic (ADR-0034) and hand off over the schema-native transport;
// a protocol failure persists its redacted raw final-message tail so the next
// #108-class defect arrives with evidence, not just a category.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { executionAdapterFor } from '../../src/lib/execution/adapters.mjs';
import { executeRunPlan } from '../../src/lib/execution/runner.mjs';
import { findMemoryEntry } from '../../src/lib/project-memory.mjs';
import { projectMemoryEnv } from '../../src/lib/ruflo-memory.mjs';

const cwd = process.cwd();
const timeoutMs = Number(process.env.AK_QE_COURT_SEAT_TIMEOUT_MS ?? 120_000);
const trials = Number(process.env.AK_QE_COURT_TRIALS ?? 1);
const debugLog = join(tmpdir(), `ak-qe-court-debug-${process.pid}.jsonl`);

function checkedPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}
checkedPositiveInteger(timeoutMs, 'AK_QE_COURT_SEAT_TIMEOUT_MS');
checkedPositiveInteger(trials, 'AK_QE_COURT_TRIALS');

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', ...options });
}

function fingerprint() {
  const result = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function memory(commandArgs) {
  return run('ruflo', ['memory', ...commandArgs], {
    env: projectMemoryEnv(cwd, process.env),
  });
}

function profile(leader, trial, namespace, evidence) {
  const follower = leader === 'claude' ? 'codex' : 'claude';
  const seats = [
    ['convener', leader],
    ['blind-prosecutor', follower],
    ['independent-jury', follower],
    ['overturn-reviewer', leader],
  ];
  const workers = seats.map(([role, host], index) => {
    const id = `${leader}-${role}`;
    const key = `${trial}-${role}`;
    const value = `proof-${randomBytes(12).toString('hex')}`;
    evidence.set(id, { key, value });
    return {
      id,
      role,
      activity: 'review',
      host,
      configuredModel: null,
      maxTurns: 4,
      hermetic: true,
      dependsOn: index === 0 ? [] : [`${leader}-${seats[index - 1][0]}`],
      prompt: [
        `Read-only qe-court participant transport probe ${trial}; seat=${role}; leader=${leader}.`,
        'Do not edit files, install packages, run builds, delegate, or invoke another host.',
        'Use MCP tools only, not a shell command. Make exactly two Ruflo memory calls:',
        `store key "${key}" with value "${value}" in namespace "${namespace}", then retrieve that exact key.`,
        'Put the exact value returned by the retrieve call in the handoff outcome. A missing or different value is a failure.',
      ].join(' '),
    };
  });
  workers.push({
    id: `${leader}-evidence-recorder`,
    role: 'evidence-recorder',
    activity: 'review',
    host: leader,
    configuredModel: null,
    maxTurns: 2,
    hermetic: true,
    dependsOn: [`${leader}-overturn-reviewer`],
    prompt: 'Read the dependency handoff only. Make no tool calls and no file changes. Reply: transport evidence received.',
  });
  return { template: 'qe-court-participant-transport', task: `trial ${trial}`, workers };
}

function capturingAdapters(captured, evidence) {
  return new Map(['claude', 'codex'].map((host) => {
    const base = executionAdapterFor(host);
    assert.ok(base, `missing ${host} execution adapter`);
    return [host, {
      ...base,
      summarize(state, observation) {
        try {
          const handoff = base.summarize(state, observation);
          if (handoff) captured.set(state.worker.id, handoff);
          return handoff;
        } catch (error) {
          // #108 evidence gap: persist the redacted raw tail of the final
          // message that failed the protocol, so a recurrence is diagnosable.
          let raw;
          try { raw = state.summaryCapture?.read() ?? null; } catch (readError) {
            raw = `<final message unreadable: ${readError?.message}>`;
          }
          let tail = String(raw ?? '').slice(-2048);
          for (const { value } of evidence.values()) tail = tail.split(value).join('<proof>');
          appendFileSync(debugLog, `${JSON.stringify({
            at: new Date().toISOString(),
            workerId: state.worker.id,
            host,
            error: String(error?.message ?? error),
            rawTail: tail,
          })}\n`);
          error.message = `${error.message} [raw tail: ${debugLog}]`;
          throw error;
        }
      },
    }];
  }));
}

test('Claude-led and Codex-led qe-court participant transports terminate cleanly', {
  timeout: timeoutMs * trials * 12,
}, async () => {
  const before = fingerprint();
  const oldDbPath = process.env.CLAUDE_FLOW_DB_PATH;
  process.env.CLAUDE_FLOW_DB_PATH = projectMemoryEnv(cwd).CLAUDE_FLOW_DB_PATH;
  try {
    for (let trial = 1; trial <= trials; trial++) {
      for (const leader of ['claude', 'codex']) {
        const namespace = `ak-qe-court-live-${process.pid}-${Date.now()}-${leader}-${trial}`;
        const evidence = new Map();
        const captured = new Map();
        try {
          const plan = profile(leader, trial, namespace, evidence);
          const results = await executeRunPlan(plan, {
            adapters: capturingAdapters(captured, evidence),
            cwd,
            timeoutMs,
            maxConcurrent: 1,
          });
          assert.equal(results.length, plan.workers.length);
          for (const result of results) {
            assert.equal(result.status, 'succeeded', `${result.workerId}: ${JSON.stringify(result)}`);
            assert.notEqual(result.exitCategory, 'orphaned', `${result.workerId} left uncertain process state`);
            assert.ok(result.durationMs <= timeoutMs + 5_000,
              `${result.workerId} exceeded its deadline plus teardown allowance`);
          }
          for (const [workerId, expected] of evidence) {
            const handoff = captured.get(workerId);
            assert.ok(handoff, `${workerId} did not produce a validated handoff`);
            assert.match(handoff.outcome, new RegExp(expected.value),
              `${workerId} did not retrieve its private Ruflo proof value`);
            const landed = findMemoryEntry(cwd, namespace, expected.key);
            assert.ok(landed, `${workerId} reported a proof that did not land in project memory`);
            const db = new DatabaseSync(landed.file, { readOnly: true });
            try {
              const columns = new Set(db.prepare('PRAGMA table_info(memory_entries)').all().map((column) => column.name));
              const payloadColumn = columns.has('content') ? 'content' : columns.has('value') ? 'value' : null;
              assert.ok(payloadColumn, `${workerId} landed in an unsupported memory_entries schema`);
              const row = db.prepare(
                `SELECT ${payloadColumn} AS payload FROM memory_entries WHERE namespace = ? AND key = ? LIMIT 1`,
              ).get(namespace, expected.key);
              assert.equal(row?.payload, expected.value, `${workerId} project-memory value differs from its proof`);
            } finally { db.close(); }
          }
        } finally {
          memory(['purge', '--namespace', namespace, '--force']);
        }
      }
    }
  } finally {
    if (oldDbPath === undefined) delete process.env.CLAUDE_FLOW_DB_PATH;
    else process.env.CLAUDE_FLOW_DB_PATH = oldDbPath;
  }
  assert.equal(fingerprint(), before, 'live participant transports mutated the repository');
});
