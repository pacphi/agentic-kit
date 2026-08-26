// Opt-in live regression for qe-court PARTICIPANT TRANSPORT, not a court
// verdict. This uses the same bounded direct-host supervisor as `ak run` and
// deliberately avoids the deprecated nested `codex mcp-server` path.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionAdapterFor } from '../../src/lib/execution/adapters.mjs';
import { executeRunPlan } from '../../src/lib/execution/runner.mjs';
import { projectMemoryEnv } from '../../src/lib/ruflo-memory.mjs';

const cwd = process.cwd();
const timeoutMs = Number(process.env.AK_QE_COURT_SEAT_TIMEOUT_MS ?? 120_000);
const trials = Number(process.env.AK_QE_COURT_TRIALS ?? 1);

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
    const stored = memory(['store', '-k', key, '--value', value, '-n', namespace]);
    assert.equal(stored.status, 0, stored.stderr || stored.stdout);
    return {
      id,
      role,
      activity: 'review',
      host,
      configuredModel: null,
      maxTurns: 4,
      dependsOn: index === 0 ? [] : [`${leader}-${seats[index - 1][0]}`],
      prompt: [
        `Read-only qe-court participant transport probe ${trial}; seat=${role}; leader=${leader}.`,
        'Do not edit files, install packages, run builds, delegate, or invoke another host.',
        `Use exactly one Ruflo memory lookup available in this host to retrieve key "${key}" from namespace "${namespace}".`,
        'Put the exact retrieved value in the handoff outcome. A missing value is a failure.',
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
    dependsOn: [`${leader}-overturn-reviewer`],
    prompt: 'Read the dependency handoff only. Make no tool calls and no file changes. Reply: transport evidence received.',
  });
  return { template: 'qe-court-participant-transport', task: `trial ${trial}`, workers };
}

function capturingAdapters(captured) {
  return new Map(['claude', 'codex'].map((host) => {
    const base = executionAdapterFor(host);
    assert.ok(base, `missing ${host} execution adapter`);
    return [host, {
      ...base,
      summarize(state, observation) {
        const handoff = base.summarize(state, observation);
        if (handoff) captured.set(state.worker.id, handoff);
        return handoff;
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
            adapters: capturingAdapters(captured),
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
