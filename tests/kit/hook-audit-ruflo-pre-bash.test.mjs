// P1-10 (#428): a project's Ruflo hook helper that prints [BLOCKED] but exits 1.
// The fixtures are byte-for-byte copies of .claude/helpers/hook-handler.cjs from two
// published @claude-flow/cli packages: 3.41.1 (sha256 209d9faf..., the digest its signed
// helpers.manifest.json lists) and 3.51.1 (sha256 fbd827df...). Neither is hand-edited.
// Each test that audits a fixture also runs that fixture, so the verdict is
// checked against what the real helper does, not against the audit's own reading.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { run as runAuditCommand } from '../../src/commands/audit.mjs';
import { preBashBlockedExit } from '../../src/lib/hook-audit/ruflo-pre-bash.mjs';
import { auditClaudeHooks } from '../../src/lib/hook-audit/providers/claude.mjs';
import { presentHookFinding } from '../../src/lib/hook-presentation.mjs';
import { captureLog, spawnEnv } from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/ruflo-helpers/', import.meta.url));
const CODE = 'ruflo-pre-bash-exit-not-blocking';
// Spelled in two parts so no tool-call hook in this repository trips on the literal.
const DANGEROUS = `${'rm -rf'} /`;

function project(t, version) {
  const root = tempDir('ak-ruflo-helper', t);
  const dir = path.join(root, 'project', '.claude', 'helpers');
  fs.mkdirSync(dir, { recursive: true });
  const helper = path.join(dir, 'hook-handler.cjs');
  fs.copyFileSync(path.join(FIXTURES, `hook-handler-${version}.cjs`), helper);
  return { root, projectRoot: path.join(root, 'project'), helper };
}

/** Run the project's real helper the way Claude Code's PreToolUse hook does. */
function runPreBash(t, helper, command) {
  const cwd = tempDir('ak-ruflo-helper-cwd', t);
  const home = tempDir('ak-ruflo-helper-home', t);
  return spawnSync(process.execPath, [helper, 'pre-bash'], {
    cwd, env: spawnEnv(home), encoding: 'utf8', timeout: 20_000,
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
  });
}

function audit(projectRoot) {
  return auditClaudeHooks({
    claudeRoot: path.join(projectRoot, '..', 'claude'),
    projectRoots: [projectRoot],
    managedSettingsFile: null,
    claudeVersion: '2.1.266',
  });
}

test('the fixtures behave as the issue says: 3.41.1 exits 1 after [BLOCKED], 3.51.1 exits 2', (t) => {
  const old = runPreBash(t, project(t, '3.41.1').helper, DANGEROUS);
  assert.match(old.stderr, /\[BLOCKED\]/);
  assert.equal(old.status, 1);
  const fixed = runPreBash(t, project(t, '3.51.1').helper, DANGEROUS);
  assert.match(fixed.stderr, /\[BLOCKED\]/);
  assert.equal(fixed.status, 2);
});

test('a helper that exits 1 after [BLOCKED] is reported, names 3.51.1 and gives the fix', (t) => {
  const fx = project(t, '3.41.1');
  const report = audit(fx.projectRoot);
  const action = report.plan.find((item) => item.diagnostic === CODE);
  assert.ok(action, 'the diagnostic must fire');
  assert.equal(action.host, 'claude');
  assert.equal(action.target, fx.helper);
  assert.equal(action.classification, 'upstream-required');
  assert.match(action.reason, /exits 1/);
  assert.match(action.reason, /3\.51\.1/);
  assert.match(action.reason, /ruflo init upgrade/);
  assert.deepEqual(action.evidence, { exitCode: 1, firstBlockingRelease: '3.51.1', fix: 'ruflo init upgrade' });
  const source = report.sources.find((item) => item.file === fx.helper);
  assert.equal(source.kind, 'ruflo-hook-helper');
  assert.equal(source.status, 'valid');
  assert.equal(report.summary.upstreamRequiredActions, 1);
});

test('a helper that exits 2 after [BLOCKED] is not reported', (t) => {
  const fx = project(t, '3.51.1');
  const report = audit(fx.projectRoot);
  assert.equal(report.plan.filter((item) => item.diagnostic === CODE).length, 0);
  assert.equal(report.plan.length, 0);
});

test('a project with no helper, or a helper with no [BLOCKED] path, is not reported', (t) => {
  const bare = tempDir('ak-ruflo-helper-bare', t);
  assert.equal(audit(bare).plan.length, 0);
  const fx = project(t, '3.41.1');
  fs.writeFileSync(fx.helper, "process.stdout.write('[OK]\\n');\n");
  const report = audit(fx.projectRoot);
  assert.equal(report.plan.length, 0);
  assert.equal(report.sources.find((item) => item.file === fx.helper)?.status, 'valid');
});

test('only the pre-bash path counts: [BLOCKED] then exit 1 elsewhere in the file is ignored', (t) => {
  const fx = project(t, '3.51.1');
  // Real 3.51.1 helper, edited so pre-bash no longer prints [BLOCKED] and the next
  // handler does, with exit 1.
  const other = "  'other': () => {\n    console.error('[BLOCKED] x');\n    process.exit(1);\n  },\n\n  'post-edit': () => {";
  const edited = fs.readFileSync(fx.helper, 'utf8')
    .replace('[BLOCKED] Dangerous command', '[DENIED] Dangerous command')
    .replace("  'post-edit': () => {", other);
  assert.match(edited, /'other'/);
  fs.writeFileSync(fx.helper, edited);
  assert.equal(audit(fx.projectRoot).plan.length, 0);
});

test('the audit does not execute the helper', (t) => {
  const fx = project(t, '3.41.1');
  const marker = path.join(fx.root, 'ran');
  // The real helper, with one line first that would leave a marker if anything ran it.
  fs.writeFileSync(fx.helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n${fs.readFileSync(fx.helper, 'utf8')}`);
  assert.equal(audit(fx.projectRoot).plan.length, 1);
  assert.equal(fs.existsSync(marker), false);
});

test('ak audit hooks --host claude prints the finding with the release and the fix', async (t) => {
  const fx = project(t, '3.41.1');
  // The command audits the user's Claude config dir too; point it at an empty one.
  const priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tempDir('ak-ruflo-helper-claude', t);
  t.after(() => {
    if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
  });
  const { result, out } = await captureLog(() => runAuditCommand({
    flags: { host: ['claude'], project: [fx.projectRoot] },
    positionals: ['hooks'],
    detectVersionFn: () => '2.1.266',
    loadConfigFn() { throw new Error('a single named host must not load the kit config'); },
  }));
  assert.equal(result, 0);
  assert.match(out, /\[upstream-required\].*hook-handler\.cjs.*exits 1.*3\.51\.1.*ruflo init upgrade/);
});

test('the finding has dashboard copy that names the release', () => {
  const copy = presentHookFinding(CODE);
  assert.notEqual(copy.title, 'Unclassified configuration finding');
  assert.match(copy.explanation, /3\.51\.1/);
});

// The parser reads text and never runs it, so these shapes are checked directly.
const handler = (branch) => `const handlers = {\n  'pre-bash': () => {\n    if (danger) {\n      console.log('[BLOCKED] no');\n${branch}\n    }\n  },\n  'post-edit': () => {},\n};\n`;

test('any exit other than 2 after [BLOCKED] is reported, with its own code', () => {
  assert.equal(preBashBlockedExit(handler('      process.exit(0);')), 0);
  assert.equal(preBashBlockedExit(handler('      process.exit(3);')), 3);
  assert.equal(preBashBlockedExit(handler('      process.exit( 2 );')), 2);
});

test('a commented-out exit does not count, and a comment cannot hide the real one', () => {
  assert.equal(preBashBlockedExit(handler('      // was process.exit(1)\n      process.exit(2);')), 2);
  assert.equal(preBashBlockedExit(handler('      /* process.exit(2) */\n      process.exit(1);')), 1);
});

test('every [BLOCKED] path is checked, not only the first', () => {
  const two = `const handlers = {\n  'pre-bash': () => {\n    if (a) {\n      console.log('[BLOCKED] a');\n      process.exit(2);\n    }\n    if (b) {\n      console.log('[BLOCKED] b');\n      process.exit(1);\n    }\n  },\n};\n`;
  assert.equal(preBashBlockedExit(two), 1);
});

test('a config map named pre-bash before the handlers is not mistaken for the handler', () => {
  const text = `const timeouts = { 'pre-bash': 1000 };\n${handler('      process.exit(1);')}`;
  assert.equal(preBashBlockedExit(text), 1);
});

test('CRLF line endings parse like LF', () => {
  assert.equal(preBashBlockedExit(handler('      process.exit(1);').replace(/\n/g, '\r\n')), 1);
});
