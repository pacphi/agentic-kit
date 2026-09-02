import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run } from '../../src/commands/heal.mjs';

function captureConsole() {
  const output = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => output.push(values.join(' '));
  console.error = (...values) => errors.push(values.join(' '));
  return {
    output, errors,
    restore() { console.log = originalLog; console.error = originalError; },
  };
}

test('ak heal hooks requires exact preview authorization and supports previewed undo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-cli-'));
  const codexHome = path.join(root, 'codex');
  const target = path.join(codexHome, 'hooks.json');
  const transactionsRoot = path.join(root, 'transactions');
  const priorCodexHome = process.env.CODEX_HOME;
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({
    hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node end.cjs', timeout: 5 }] }] },
  }, null, 2)}\n`, { mode: 0o640 });
  process.env.CODEX_HOME = codexHome;
  const invoke = async (flags) => {
    const capture = captureConsole();
    try {
      const code = await run({
        flags: { host: ['codex'], project: [], json: true, 'transactions-root': transactionsRoot, ...flags },
        positionals: ['hooks'], detectVersionFn: () => '0.151.0',
        loadConfigFn: () => { throw new Error('Codex-only healing must not load adapter config'); },
      });
      return { code, output: capture.output, errors: capture.errors };
    } finally { capture.restore(); }
  };
  try {
    const preview = await invoke({});
    assert.equal(preview.code, 0);
    const plan = JSON.parse(preview.output.join('\n'));
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.SessionEnd[0].hooks[0].timeout, 5);
    assert.equal(fs.existsSync(transactionsRoot), false);

    const missingYes = await invoke({
      apply: true, action: [plan.actions[0].id], 'plan-digest': plan.planDigest,
    });
    assert.equal(missingYes.code, 2);
    assert.match(missingYes.errors.join('\n'), /--apply requires --yes/);

    const applied = await invoke({
      apply: true, yes: true, action: [plan.actions[0].id], 'plan-digest': plan.planDigest,
    });
    assert.equal(applied.code, 0);
    const applyResult = JSON.parse(applied.output.join('\n'));
    assert.equal(applyResult.status, 'committed');
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.SessionEnd[0].hooks[0].timeout, 3);

    const undoPreview = await invoke({ undo: applyResult.receiptId });
    assert.equal(undoPreview.code, 0);
    assert.equal(JSON.parse(undoPreview.output.join('\n')).actions[0].backupVerified, true);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.SessionEnd[0].hooks[0].timeout, 3);

    const undone = await invoke({ undo: applyResult.receiptId, apply: true, yes: true });
    assert.equal(undone.code, 0);
    assert.equal(JSON.parse(undone.output.join('\n')).status, 'rolled-back');
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.SessionEnd[0].hooks[0].timeout, 5);
  } finally {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
