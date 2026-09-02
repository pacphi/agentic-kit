import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { auditCodexHooks } from '../../src/lib/hook-audit/index.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-audit-'));
  const codexHome = path.join(root, 'codex');
  const project = path.join(root, 'project');
  const cache = path.join(codexHome, 'plugins', 'cache');
  fs.mkdirSync(project, { recursive: true });
  return { root, codexHome, project, cache };
}

test('audit keeps SessionEnd compatibility separate from trust and never proposes an automatic cache edit', () => {
  const fx = fixture();
  try {
    writeJson(path.join(fx.project, '.codex', 'hooks.json'), {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node local.cjs', timeout: 10000 }] }] },
    });
    fs.mkdirSync(fx.codexHome, { recursive: true });
    fs.writeFileSync(path.join(fx.codexHome, 'config.toml'), '[plugins."companion@test"]\nenabled = true\n');
    const pluginRoot = path.join(fx.cache, 'test', 'companion', '1.0.0');
    writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
      name: 'companion', version: '1.0.0', hooks: './hooks/hooks.json',
    });
    writeJson(path.join(pluginRoot, 'hooks', 'hooks.json'), {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node plugin.cjs', timeout: 5 }] }] },
    });

    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [fx.project],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    });

    assert.equal(report.summary.hookOccurrences, 2);
    assert.equal(report.summary.compatibilityWarnings, 2);
    assert.equal(report.summary.automaticActions, 0);
    assert.deepEqual(new Set(report.records.map((record) => record.timeout.effective)), new Set([3]));
    assert.ok(report.records.every((record) => record.trust.observedState === 'unknown'));
    assert.ok(report.records.every((record) => record.diagnostics.some((d) => d.category === 'compatibility')));
    assert.ok(report.plan.every((action) => action.classification === 'never-automatic'));
    assert.ok(report.records.every((record) => typeof record.implementationTarget === 'string'));
    assert.ok(report.records.every((record) => Array.isArray(record.sideEffects)));
    assert.ok(report.records.every((record) => record.duplicateGroupId === record.behaviorFingerprint));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('audit keeps cwd-sensitive occurrences behaviorally distinct', () => {
  const fx = fixture();
  try {
    for (const name of ['a', 'b']) {
      const project = path.join(fx.root, name);
      writeJson(path.join(project, '.codex', 'hooks.json'), {
        hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'node guard.cjs' }] }] },
      });
    }

    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [path.join(fx.root, 'a'), path.join(fx.root, 'b')],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    });

    assert.equal(report.records.length, 2);
    assert.equal(report.summary.uniqueBehaviors, 2);
    assert.notEqual(report.records[0].behaviorFingerprint, report.records[1].behaviorFingerprint);
    assert.notEqual(report.records[0].source.file, report.records[1].source.file);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('audit JSON is deterministic across no-op runs', async () => {
  const fx = fixture();
  try {
    writeJson(path.join(fx.project, '.codex', 'hooks.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node stop.cjs' }] }] },
    });
    const options = {
      codexHome: fx.codexHome,
      projectRoots: [fx.project],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    };
    const first = auditCodexHooks(options);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = auditCodexHooks(options);
    assert.deepEqual(second, first);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('unknown Codex versions receive syntax-only validation and no timeout rewrite plan', () => {
  const fx = fixture();
  try {
    writeJson(path.join(fx.project, '.codex', 'hooks.json'), {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node end.cjs', timeout: 10000 }] }] },
    });
    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [fx.project],
      pluginCacheDir: fx.cache,
      codexVersion: 'unknown',
    });
    assert.equal(report.hostSchema.confidence, 'unknown');
    assert.equal(report.summary.compatibilityWarnings, 0);
    assert.equal(report.plan.length, 0);
    assert.equal(report.records[0].timeout.effective, null);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('plugin hook discovery refuses a symlinked parent that escapes the plugin root', (t) => {
  const fx = fixture();
  try {
    fs.mkdirSync(fx.codexHome, { recursive: true });
    fs.writeFileSync(path.join(fx.codexHome, 'config.toml'), '[plugins."escape@test"]\nenabled = true\n');
    const pluginRoot = path.join(fx.cache, 'test', 'escape', '1.0.0');
    writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
      name: 'escape', version: '1.0.0', hooks: './hooks/hooks.json',
    });
    const outside = path.join(fx.root, 'outside');
    writeJson(path.join(outside, 'hooks.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node outside.cjs' }] }] },
    });
    try {
      fs.symlinkSync(outside, path.join(pluginRoot, 'hooks'), 'dir');
    } catch (error) {
      if (error.code === 'EPERM') { t.skip('directory symlinks unavailable'); return; }
      throw error;
    }

    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    });
    assert.equal(report.records.length, 0);
    assert.equal(report.sources[0].status, 'refused');
    assert.match(report.sources[0].error, /escapes/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('an expected hook path that is itself a broken symlink is refused, not ignored', (t) => {
  const fx = fixture();
  try {
    const hookFile = path.join(fx.project, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    try {
      fs.symlinkSync(path.join(fx.root, 'missing-hooks.json'), hookFile);
    } catch (error) {
      if (error.code === 'EPERM') { t.skip('file symlinks unavailable'); return; }
      throw error;
    }
    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [fx.project],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    });
    assert.equal(report.summary.invalidSources, 1);
    assert.equal(report.sources[0].status, 'refused');
    assert.match(report.sources[0].error, /non-symlink/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a conventional plugin hook path that is a broken symlink is refused, not ignored', (t) => {
  const fx = fixture();
  try {
    fs.mkdirSync(fx.codexHome, { recursive: true });
    fs.writeFileSync(path.join(fx.codexHome, 'config.toml'), '[plugins."broken@test"]\nenabled = true\n');
    const pluginRoot = path.join(fx.cache, 'test', 'broken', '1.0.0');
    writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
      name: 'broken', version: '1.0.0',
    });
    const hookFile = path.join(pluginRoot, 'hooks', 'hooks.json');
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    try {
      fs.symlinkSync(path.join(fx.root, 'missing-plugin-hooks.json'), hookFile);
    } catch (error) {
      if (error.code === 'EPERM') { t.skip('file symlinks unavailable'); return; }
      throw error;
    }
    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    });
    assert.equal(report.summary.invalidSources, 1);
    assert.equal(report.summary.configurationIssues, 1);
    assert.equal(report.sources[0].status, 'refused');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('behavior fingerprints preserve material whitespace inside quoted arguments', () => {
  const fx = fixture();
  try {
    writeJson(path.join(fx.project, '.codex', 'hooks.json'), {
      hooks: { Stop: [
        { hooks: [{ type: 'command', command: 'node stop.cjs --label "a  b"' }] },
        { hooks: [{ type: 'command', command: 'node stop.cjs --label "a b"' }] },
      ] },
    });
    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [fx.project],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    });
    assert.equal(report.summary.uniqueBehaviors, 2);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('malformed nested hook schema invalidates the source instead of silently skipping it', () => {
  const fx = fixture();
  try {
    writeJson(path.join(fx.project, '.codex', 'hooks.json'), {
      hooks: { Stop: { hooks: [] } },
    });
    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [fx.project],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    });
    assert.equal(report.summary.invalidSources, 1);
    assert.equal(report.records.length, 0);
    assert.match(report.sources[0].error, /Stop.*array/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('malformed matcher and timeout values invalidate the source', () => {
  const fx = fixture();
  try {
    writeJson(path.join(fx.project, '.codex', 'hooks.json'), {
      hooks: { SessionEnd: [{ matcher: 42, hooks: [
        { type: 'command', command: 'node end.cjs', timeout: '10000' },
      ] }] },
    });
    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [fx.project],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    });
    assert.equal(report.summary.invalidSources, 1);
    assert.equal(report.records.length, 0);
    assert.match(report.sources[0].error, /matcher.*string/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('remediation action ids stay unique for duplicate occurrences in one source', () => {
  const fx = fixture();
  try {
    writeJson(path.join(fx.project, '.codex', 'hooks.json'), {
      hooks: { SessionEnd: [{ hooks: [
        { type: 'command', command: 'node end.cjs', timeout: 5 },
        { type: 'command', command: 'node end.cjs', timeout: 5 },
      ] }] },
    });
    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [fx.project],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    });
    assert.equal(new Set(report.plan.map((action) => action.id)).size, 2);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('enabled-plugin discovery failures are counted and make CLI JSON exit nonzero', () => {
  const fx = fixture();
  try {
    fs.mkdirSync(fx.codexHome, { recursive: true });
    fs.writeFileSync(path.join(fx.codexHome, 'config.toml'), '[plugins."missing@test"]\nenabled = true\n');
    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [fx.project],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    });
    assert.equal(report.summary.configurationIssues, 1);

    const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'agentic-kit.mjs'), 'audit', 'hooks', '--json'], {
      cwd: fx.project,
      env: { ...process.env, CODEX_HOME: fx.codexHome },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).summary.configurationIssues, 1);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('non-hook plugin skill findings do not make the hook audit fail', () => {
  const fx = fixture();
  try {
    fs.mkdirSync(fx.codexHome, { recursive: true });
    fs.writeFileSync(path.join(fx.codexHome, 'config.toml'), '[plugins."skills@test"]\nenabled = true\n');
    const pluginRoot = path.join(fx.cache, 'test', 'skills', '1.0.0');
    writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
      name: 'skills', version: '1.0.0', hooks: './hooks/hooks.json',
    });
    writeJson(path.join(pluginRoot, 'hooks', 'hooks.json'), { hooks: { Stop: [] } });
    fs.mkdirSync(path.join(pluginRoot, 'skills', 'BadName'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'skills', 'BadName', 'SKILL.md'), '# no frontmatter\n');

    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    });
    assert.equal(report.summary.configurationIssues, 0);
    assert.deepEqual(report.pluginIssues, []);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('audit reports malformed hook documents and remains read-only', () => {
  const fx = fixture();
  try {
    const hookFile = path.join(fx.project, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.writeFileSync(hookFile, '{not-json\n');
    const before = fs.statSync(hookFile);
    const bytes = fs.readFileSync(hookFile);

    const report = auditCodexHooks({
      codexHome: fx.codexHome,
      projectRoots: [fx.project],
      pluginCacheDir: fx.cache,
      codexVersion: '0.151.0',
    });

    assert.equal(report.records.length, 0);
    assert.equal(report.sources[0].status, 'invalid');
    assert.match(report.sources[0].error, /JSON/);
    assert.deepEqual(fs.readFileSync(hookFile), bytes);
    assert.equal(fs.statSync(hookFile).mtimeMs, before.mtimeMs);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('ak audit hooks exposes the read-only audit as a porcelain command', () => {
  const fx = fixture();
  try {
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'agentic-kit.mjs'), 'audit', 'hooks', '--json'], {
      cwd: fx.project,
      env: { ...process.env, CODEX_HOME: fx.codexHome },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'read-only');
    assert.equal(report.summary.automaticActions, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('ak audit hooks human output is not followed by the generic network drift nudge', () => {
  const fx = fixture();
  try {
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'agentic-kit.mjs'), 'audit', 'hooks'], {
      cwd: fx.project,
      env: { ...process.env, CODEX_HOME: fx.codexHome },
      encoding: 'utf8',
      timeout: 3_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /trust: unchanged/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
