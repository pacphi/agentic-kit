import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run } from '../../src/commands/heal.mjs';

const POSIX_MUTATION_ONLY = process.platform === 'win32'
  ? { skip: 'executable hook healing is intentionally unavailable on Windows' }
  : {};

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

test('ak heal hooks requires exact preview authorization and supports previewed undo', POSIX_MUTATION_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-cli-'));
  const codexHome = path.join(root, 'codex');
  const target = path.join(codexHome, 'hooks.json');
  const project = path.join(root, 'project');
  const transactionsRoot = path.join(root, 'transactions');
  const priorCodexHome = process.env.CODEX_HOME;
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({
    hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node end.cjs', timeout: 5 }] }] },
  }, null, 2)}\n`, { mode: 0o640 });
  process.env.CODEX_HOME = codexHome;
  const invoke = async (flags) => {
    const capture = captureConsole();
    try {
      const code = await run({
        flags: { host: ['codex'], project: [project], json: true, 'transactions-root': transactionsRoot, ...flags },
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

test('ak heal hooks explicitly disables the companion in Codex without touching Claude state', POSIX_MUTATION_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-plugin-cli-'));
  const codexHome = path.join(root, 'codex');
  const target = path.join(codexHome, 'config.toml');
  const claudeState = path.join(root, 'claude', 'plugins.json');
  const transactionsRoot = path.join(root, 'transactions');
  const priorCodexHome = process.env.CODEX_HOME;
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.dirname(claudeState), { recursive: true });
  fs.writeFileSync(target,
    '[plugins."codex@openai-codex"]\nenabled = true\n', { mode: 0o640 });
  const pluginRoot = path.join(codexHome, 'plugins', 'cache', 'openai-codex', 'codex', '1.0.6');
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'codex', version: '1.0.6', hooks: {} }));
  fs.writeFileSync(claudeState, '{"codex-companion":"enabled"}\n');
  process.env.CODEX_HOME = codexHome;
  const invoke = async (flags) => {
    const capture = captureConsole();
    try {
      const code = await run({
        flags: { host: ['codex'], project: [], json: true, 'transactions-root': transactionsRoot, ...flags },
        positionals: ['hooks'], detectVersionFn: () => '0.152.1',
        loadConfigFn: () => { throw new Error('Codex-only healing must not load adapter config'); },
      });
      return { code, output: capture.output, errors: capture.errors };
    } finally { capture.restore(); }
  };
  try {
    const preview = await invoke({});
    assert.equal(preview.code, 1, 'the detected placement issue keeps preview exit status diagnostic');
    const plan = JSON.parse(preview.output.join('\n'));
    const action = plan.actions.find((candidate) => (
      candidate.recipeId === 'codex/user-toml/claude-companion-disable/v1'
    ));
    assert.ok(action);
    assert.equal(action.executable, true);
    assert.equal(fs.readFileSync(claudeState, 'utf8'), '{"codex-companion":"enabled"}\n');

    const applied = await invoke({
      apply: true, yes: true, action: [action.id], 'plan-digest': plan.planDigest,
    });
    assert.equal(applied.code, 0);
    const result = JSON.parse(applied.output.join('\n'));
    assert.match(fs.readFileSync(target, 'utf8'), /enabled = false/);
    assert.equal(fs.readFileSync(claudeState, 'utf8'), '{"codex-companion":"enabled"}\n');

    const undone = await invoke({ undo: result.receiptId, apply: true, yes: true });
    assert.equal(undone.code, 0);
    assert.match(fs.readFileSync(target, 'utf8'), /enabled = true/);
    assert.equal(fs.readFileSync(claudeState, 'utf8'), '{"codex-companion":"enabled"}\n');
  } finally {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
