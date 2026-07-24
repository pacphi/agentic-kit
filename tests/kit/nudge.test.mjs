import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localDrift } from '../../src/lib/nudge.mjs';
import { upsertBlock } from '../../src/lib/blocks.mjs';

// Fixtures inject everything machine-specific: a fake pkgRoot (so built-in
// templates resolve to nothing → 'missing-template', never drift), an explicit
// cfg (codex off → the MCP probes stay quiet), a tmp cwd (no project
// statusline → that probe stays quiet), and explicit guidance targets. What
// remains under test is exactly the blocks-drift phrasing the bin nudge prints.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-test-'));
const block = (slug, body) => `<!-- BEGIN ${slug} -->\n${body}\n<!-- END ${slug} -->\n`;

function fixture() {
  const dir = tmp();
  const tpl = path.join(dir, 'tpl.md');
  fs.writeFileSync(tpl, block('test-guidance', 'current guidance'));
  const cfg = {
    customBlocks: [{ slug: 'test-guidance', templatePath: tpl, detector: { type: 'always' } }],
    providers: { hosts: { claude: true } },
  };
  const claudeMd = path.join(dir, 'CLAUDE.md');
  const targets = [{ name: 'claude', label: 'CLAUDE.md', file: claudeMd }];
  return { dir, tpl, cfg, claudeMd, targets };
}

test('localDrift is quiet when the injected block matches the template', async () => {
  const { dir, tpl, cfg, claudeMd, targets } = fixture();
  fs.writeFileSync(claudeMd, upsertBlock('# mine\n', 'test-guidance', fs.readFileSync(tpl, 'utf8')));
  const lines = await localDrift({ pkgRoot: path.join(dir, 'no-such-pkg'), cwd: dir, cfg, targets });
  assert.deepEqual(lines, []);
});

test('localDrift reports a drifted CLAUDE.md block when template moved on', async () => {
  const { dir, tpl, cfg, claudeMd, targets } = fixture();
  fs.writeFileSync(claudeMd, upsertBlock('# mine\n', 'test-guidance', fs.readFileSync(tpl, 'utf8')));
  fs.writeFileSync(tpl, block('test-guidance', 'REVISED guidance (new PR)'));
  const lines = await localDrift({ pkgRoot: path.join(dir, 'no-such-pkg'), cwd: dir, cfg, targets });
  assert.deepEqual(lines, ['1 CLAUDE.md block(s)']);
});

test('localDrift reports a stale block whose detector went false (strip pending)', async () => {
  const { dir, cfg, claudeMd, targets } = fixture();
  cfg.customBlocks[0].detector = { type: 'file', target: path.join(dir, 'absent-gate') };
  fs.writeFileSync(claudeMd, upsertBlock('# mine\n', 'test-guidance', block('test-guidance', 'obsolete')));
  const lines = await localDrift({ pkgRoot: path.join(dir, 'no-such-pkg'), cwd: dir, cfg, targets });
  assert.deepEqual(lines, ['1 CLAUDE.md block(s)']);
});

test('localDrift counts per target and labels each guidance file', async () => {
  const { dir, tpl, cfg, claudeMd, targets } = fixture();
  cfg.customBlocks[0].guidanceFiles = ['claude', 'agents'];
  fs.writeFileSync(claudeMd, upsertBlock('# mine\n', 'test-guidance', fs.readFileSync(tpl, 'utf8')));
  const agentsMd = path.join(dir, 'AGENTS.md'); // absent → block wanted → would be created
  const lines = await localDrift({
    pkgRoot: path.join(dir, 'no-such-pkg'), cwd: dir, cfg,
    targets: [...targets, { name: 'agents', label: 'AGENTS.md', file: agentsMd }],
  });
  assert.deepEqual(lines, ['1 AGENTS.md block(s)']);
});

test('localDrift stays quiet for a missing target file with no applicable rows', async () => {
  const { dir, cfg } = fixture();
  cfg.customBlocks = []; // registry falls back to built-ins, all missing-template under fake pkgRoot
  const lines = await localDrift({
    pkgRoot: path.join(dir, 'no-such-pkg'), cwd: dir, cfg,
    targets: [{ name: 'claude', label: 'CLAUDE.md', file: path.join(dir, 'CLAUDE.md') }],
  });
  assert.deepEqual(lines, []);
});

test('localDrift never throws — garbage inputs yield an array, not a crash', async () => {
  const lines = await localDrift({ pkgRoot: '/no/such/root', cwd: '/no/such/cwd', cfg: {}, targets: [] });
  assert.ok(Array.isArray(lines));
  assert.deepEqual(lines, []);
});
