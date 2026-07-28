import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyOpencode, undoOpencode, opencodeMcpStatus, opencodeConverged, mcpEntriesFor,
  catalogSource, skillPathsFor, convertAgents, syncAgents, agentsStatus,
  deployPlugin, pluginStatus, deploySkill, skillStatus, removeArtifacts,
  PERMISSION_KEYS, PLUGIN_NAME,
} from '../../src/lib/opencode.mjs';
import { detectHosts } from '../../src/lib/providers.mjs';
import { guidanceTargets, BUILTIN_BLOCKS } from '../../src/lib/blocks.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const cfgOn = () => ({ providers: { hosts: { opencode: true }, opencodeMcp: null, opencodeManaged: null } });

/** Fixture ruflo catalog source: .claude/agents (+ frontmatter variants),
 *  .claude/skills, plugins, SKILL.md, package.json. */
function makeCatalog(root, { version = '9.9.9', plugins = true, platformSkill = true } = {}) {
  fs.mkdirSync(path.join(root, '.claude', 'agents', 'core'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'agents', 'extra'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'some-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version }));
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'core', 'coder.md'),
    '---\nname: coder\ndescription: Implementation specialist\ntools: Bash, Read\n---\n\nUse mcp__claude-flow__swarm_init here.\n');
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'extra', 'coder.md'),
    '---\nname: coder\ndescription: |\n  Block-scalar duplicate name\n  across two lines\n---\n\nDuplicate.\n');
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'notes.md'),
    '---\nname: Notes\ntype: documentation\ndescription: not an agent\n---\n\nDocs.\n');
  if (plugins) fs.mkdirSync(path.join(root, 'plugins', 'ruflo-x', 'skills', 'y'), { recursive: true });
  if (platformSkill) fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: ruflo\ndescription: platform\n---\n\n# Ruflo\n');
  return root;
}

// ── catalogSource / skillPathsFor ────────────────────────────────────────────

test('catalogSource prefers the explicit override and reports capabilities', () => {
  const root = makeCatalog(tmp('ak-oc-src-'));
  const s = catalogSource({ override: root });
  assert.equal(s.kind, 'override');
  assert.equal(s.id, 'override@9.9.9');
  assert.equal(s.hasPlugins, true);
  assert.equal(s.hasPlatformSkill, true);
  rm(root);
});

test('catalogSource honors $RUFLO_REPO after override', () => {
  const root = makeCatalog(tmp('ak-oc-env-'));
  process.env.RUFLO_REPO = root;
  try {
    const s = catalogSource();
    assert.equal(s.kind, 'env');
    assert.equal(s.root, root);
  } finally {
    delete process.env.RUFLO_REPO;
  }
  rm(root);
});

test('skillPathsFor emits existing dirs only', () => {
  const root = makeCatalog(tmp('ak-oc-sp-'), { plugins: false });
  const s = catalogSource({ override: root });
  const paths = skillPathsFor(s);
  assert.deepEqual(paths, [path.join(root, '.claude', 'skills')]);
  rm(root);
});

// ── mcpEntriesFor / opencodeMcpStatus ────────────────────────────────────────

test('mcpEntriesFor includes ruvnet-brain only when the shim exists', async () => {
  const d = tmp('ak-oc-shim-');
  const shim = path.join(d, 'server.mjs');
  const without = await mcpEntriesFor({ brainShim: shim });
  assert.equal(Object.keys(without).includes('ruvnet-brain'), false);
  fs.writeFileSync(shim, '// shim\n');
  const withBrain = await mcpEntriesFor({ brainShim: shim });
  assert.equal(withBrain['ruvnet-brain'].type, 'local');
  assert.deepEqual(withBrain['ruvnet-brain'].command, ['node', shim]);
  assert.equal(withBrain['ruvnet-brain'].timeout, 30000);
  assert.equal(withBrain['claude-flow'].enabled, true);
  assert.equal(withBrain['claude-flow'].environment.CLAUDE_FLOW_MODE, 'v3');
  assert.ok(Array.isArray(withBrain['claude-flow'].command));
  rm(d);
});

test('opencodeMcpStatus flags JSONC files as parseError instead of clobbering', () => {
  const d = tmp('ak-oc-jsonc-');
  const file = path.join(d, 'opencode.json');
  fs.writeFileSync(file, '{\n  // a comment\n  "mcp": {}\n}\n');
  const st = opencodeMcpStatus(cfgOn(), { configFile: file });
  assert.equal(st.exists, true);
  assert.equal(st.parseError, true);
  rm(d);
});

// ── applyOpencode / undoOpencode round-trip ──────────────────────────────────

test('applyOpencode merges wiring, preserves user keys, records value-precise ownership; undo restores priors', async () => {
  const d = tmp('ak-oc-apply-');
  const file = path.join(d, 'opencode.json');
  const shim = path.join(d, 'brain.mjs');
  fs.writeFileSync(shim, '// shim\n');
  const srcRoot = makeCatalog(path.join(d, 'catalog'));
  fs.writeFileSync(file, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: 'opencode/kimi-k3',
    mcp: { 'my-server': { type: 'local', command: ['x'] } },
    skills: { paths: ['/user/path'] },
    permission: { edit: 'ask' },
  }, null, 2));

  const cfg = cfgOn();
  cfg.providers.opencodeCatalogDir = srcRoot;
  const r = await applyOpencode(cfg, { configFile: file, brainShim: shim });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(doc.mcp['claude-flow'], 'claude-flow server written');
  assert.ok(doc.mcp['ruvnet-brain'], 'brain server written (shim present)');
  assert.ok(doc.mcp['my-server'], 'user MCP server preserved');
  assert.equal(doc.model, 'opencode/kimi-k3', 'unrelated keys preserved');
  assert.ok(doc.skills.paths.includes('/user/path'), 'user skills path preserved');
  assert.ok(doc.skills.paths.includes(path.join(srcRoot, 'plugins')), 'catalog plugins path added');
  assert.equal(doc.permission.edit, 'ask', 'user permission preserved');
  for (const k of PERMISSION_KEYS) assert.equal(doc.permission[k], 'allow');
  assert.equal(cfg.providers.opencodeMcp, 'ak');
  // value-precise ownership: claude-flow had no prior → prior null, written recorded
  const rec = cfg.providers.opencodeManaged.mcp['claude-flow'];
  assert.equal(rec.prior, null);
  assert.deepEqual(rec.written, doc.mcp['claude-flow']);

  // idempotent
  const again = await applyOpencode(cfg, { configFile: file, brainShim: shim });
  assert.equal(again.changed, false);
  assert.ok(fs.existsSync(`${file}.bak`));

  const u = undoOpencode(cfg, { configFile: file });
  assert.equal(u.changed, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.mcp['claude-flow'], undefined);
  assert.equal(after.mcp['ruvnet-brain'], undefined);
  assert.ok(after.mcp['my-server'], 'user server survives teardown');
  assert.deepEqual(after.skills.paths, ['/user/path']);
  assert.equal(after.permission.edit, 'ask');
  for (const k of PERMISSION_KEYS) assert.equal(after.permission[k], undefined);
  assert.equal(cfg.providers.opencodeMcp, null);
  rm(d);
});

test('applyOpencode refuses an unparseable config file (never clobbers JSONC)', async () => {
  const d = tmp('ak-oc-refuse-');
  const file = path.join(d, 'opencode.json');
  const body = '{\n  // comment\n  "mcp": {}\n}\n';
  fs.writeFileSync(file, body);
  const r = await applyOpencode(cfgOn(), { configFile: file });
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), body, 'file untouched');
  rm(d);
});

test('applyOpencode is a no-op when the host is not enabled', async () => {
  const d = tmp('ak-oc-off-');
  const file = path.join(d, 'opencode.json');
  const r = await applyOpencode({ providers: { hosts: { opencode: false } } }, { configFile: file });
  assert.equal(r.changed, false);
  assert.equal(fs.existsSync(file), false);
  rm(d);
});

test('undoOpencode never strips a config ak did not write', () => {
  const d = tmp('ak-oc-unowned-');
  const file = path.join(d, 'opencode.json');
  fs.writeFileSync(file, JSON.stringify({ mcp: { 'claude-flow': { type: 'local', command: ['x'] } } }));
  const cfg = cfgOn(); // opencodeMcp: null → not ak-owned
  const u = undoOpencode(cfg, { configFile: file });
  assert.equal(u.changed, false);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).mcp['claude-flow'], 'user-registered claude-flow preserved');
  rm(d);
});

// ── ownership collisions + value-precise teardown (codex review) ─────────────

test('a user-owned same-name MCP entry that DIFFERS is a collision: preserved, not adopted, not torn down', async () => {
  const d = tmp('ak-oc-collide-');
  const file = path.join(d, 'opencode.json');
  const userEntry = { type: 'local', command: ['my', 'own', 'server'], timeout: 5 };
  fs.writeFileSync(file, JSON.stringify({ mcp: { 'claude-flow': userEntry } }));
  const cfg = cfgOn();
  const r = await applyOpencode(cfg, { configFile: file, brainShim: path.join(d, 'absent-shim') });
  assert.equal(r.ok, false, 'collision reported');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(doc.mcp['claude-flow'], userEntry, 'user entry untouched');
  const u = undoOpencode(cfg, { configFile: file });
  // teardown still strips what ak legitimately wrote (permission keys) — but
  // the collided user entry must survive untouched.
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after.mcp['claude-flow'], userEntry, 'teardown never deletes a non-ak-written value');
  assert.ok(u.detail.includes('mcp.claude-flow'), 'the kept collision is reported');
  rm(d);
});

test('a user permission pattern set to ask is a collision: preserved', async () => {
  const d = tmp('ak-oc-perm-');
  const file = path.join(d, 'opencode.json');
  fs.writeFileSync(file, JSON.stringify({ permission: { 'claude-flow_*': 'ask' } }));
  const r = await applyOpencode(cfgOn(), { configFile: file, brainShim: path.join(d, 'absent-shim') });
  assert.equal(r.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).permission['claude-flow_*'], 'ask');
  rm(d);
});

test('scalar permission shorthand is lifted to {"*": v} before merging and restored on undo', async () => {
  const d = tmp('ak-oc-scalar-');
  const file = path.join(d, 'opencode.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'x', permission: 'allow' }));
  const cfg = cfgOn();
  await applyOpencode(cfg, { configFile: file, brainShim: path.join(d, 'absent-shim') });
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof doc.permission, 'object', 'no character-spread corruption');
  assert.equal(doc.permission['*'], 'allow');
  assert.equal(doc.permission['claude-flow_*'], 'allow');
  assert.equal(doc.permission['0'], undefined, 'no numeric character keys');
  undoOpencode(cfg, { configFile: file });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.permission, 'allow', 'scalar shorthand restored');
  rm(d);
});

test('desired-set shrink: removing the brain shim prunes the ak-written brain entry (still == written)', async () => {
  const d = tmp('ak-oc-shrink-');
  const file = path.join(d, 'opencode.json');
  const shim = path.join(d, 'brain.mjs');
  fs.writeFileSync(shim, '// shim\n');
  const cfg = cfgOn();
  await applyOpencode(cfg, { configFile: file, brainShim: shim });
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).mcp['ruvnet-brain']);
  fs.rmSync(shim); // brain removed
  await applyOpencode(cfg, { configFile: file, brainShim: shim });
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.mcp['ruvnet-brain'], undefined, 'stale ak entry pruned');
  assert.ok(doc.mcp['claude-flow'], 'ruflo entry kept');
  rm(d);
});

test('desired-set shrink never prunes a user-EDITED stale entry', async () => {
  const d = tmp('ak-oc-shrink-edit-');
  const file = path.join(d, 'opencode.json');
  const shim = path.join(d, 'brain.mjs');
  fs.writeFileSync(shim, '// shim\n');
  const cfg = cfgOn();
  await applyOpencode(cfg, { configFile: file, brainShim: shim });
  // user edits the brain entry afterwards
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.mcp['ruvnet-brain'].timeout = 99999;
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.rmSync(shim);
  await applyOpencode(cfg, { configFile: file, brainShim: shim });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.mcp['ruvnet-brain'].timeout, 99999, 'user edit preserved over prune');
  rm(d);
});

test('opencodeConverged detects value drift, not just key presence', async () => {
  const d = tmp('ak-oc-conv-');
  const file = path.join(d, 'opencode.json');
  const shim = path.join(d, 'brain.mjs');
  fs.writeFileSync(shim, '// shim\n');
  const cfg = cfgOn();
  await applyOpencode(cfg, { configFile: file, brainShim: shim });
  const good = await opencodeConverged(cfg, { configFile: file, brainShim: shim });
  assert.equal(good.converged, true, JSON.stringify(good.reasons));
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.mcp['claude-flow'].timeout = 1; // user/template drift
  fs.writeFileSync(file, JSON.stringify(doc));
  const bad = await opencodeConverged(cfg, { configFile: file, brainShim: shim });
  assert.equal(bad.converged, false);
  assert.ok(bad.reasons.some((r) => r.includes('claude-flow')));
  rm(d);
});

test('detectHosts reads the opencode wired state from the config file (seam)', async () => {
  const d = tmp('ak-oc-detect-');
  const file = path.join(d, 'opencode.json');
  const shim = path.join(d, 'brain.mjs');
  fs.writeFileSync(shim, '// shim\n');
  const cfg = cfgOn();
  await applyOpencode(cfg, { configFile: file, brainShim: shim });
  const hosts = await detectHosts(process.cwd(), { opencodeConfigFile: file });
  assert.equal(hosts.opencode.wired, true, 'config-file host reports wired from its own config');
  rm(d);
});

// ── agent conversion ─────────────────────────────────────────────────────────

test('convertAgents converts, rewrites ALL MCP ref spellings, skips documentation, prefixes collisions', () => {
  const root = makeCatalog(tmp('ak-oc-conv2-'));
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'core', 'alias.md'),
    '---\nname: alias\ndescription: alias refs\n---\n\nmcp__claude_flow__memory_search and mcp__ruflo__memory_list here.\n');
  const { agents, scanned, skipped, renamed } = convertAgents(root);
  assert.equal(scanned, 4);
  assert.equal(skipped, 1, 'documentation-type file skipped');
  assert.equal(renamed, 1);
  const names = agents.map((a) => a.name).sort();
  assert.deepEqual(names, ['alias', 'coder', 'extra-coder']);
  const blockScalar = agents.find((a) => a.name === 'extra-coder');
  assert.equal(blockScalar.description, 'Block-scalar duplicate name across two lines');
  const alias = agents.find((a) => a.name === 'alias');
  assert.ok(alias.body.includes('claude-flow_memory_search'), 'claude_flow alias rewritten');
  assert.ok(alias.body.includes('claude-flow_memory_list'), 'ruflo alias rewritten');
  assert.ok(!/mcp__(claude[-_]flow|ruflo)__/.test(alias.body), 'no claude-style refs remain');
  const core = agents.find((a) => a.name === 'coder');
  assert.ok(core.content.includes('mode: subagent'));
  assert.ok(core.content.includes('claude-flow_swarm_init'));
  assert.ok(!core.content.includes('tools: Bash'), 'claude tools list dropped');
  rm(root);
});

test('convertAgents emits YAML-safe descriptions (": " content is JSON-quoted)', () => {
  const root = makeCatalog(tmp('ak-oc-yaml-'));
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'core', 'colon.md'),
    '---\nname: colon\ndescription: Examples: <example>Context: user wants x</example>\n---\n\nBody.\n');
  const { agents } = convertAgents(root);
  const a = agents.find((x) => x.name === 'colon');
  const fm = a.content.split('---')[1];
  const descLine = fm.split('\n').find((l) => l.startsWith('description:'));
  assert.ok(descLine.startsWith('description: "'), 'description is double-quoted');
  const parsed = JSON.parse(descLine.slice('description: '.length));
  assert.equal(parsed, 'Examples: <example>Context: user wants x</example>');
  rm(root);
});

test('parseFrontmatter block scalars keep blank-line-separated paragraphs', () => {
  const root = makeCatalog(tmp('ak-oc-block-'));
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'core', 'multi.md'),
    '---\nname: multi\ndescription: |\n  First paragraph here.\n\n  Second paragraph after a blank line.\ntools: Bash\n---\n\nBody.\n');
  const { agents } = convertAgents(root);
  const a = agents.find((x) => x.name === 'multi');
  assert.equal(a.description, 'First paragraph here. Second paragraph after a blank line.');
  rm(root);
});

test('syncAgents writes + stamps, never overwrites user-owned files, is idempotent (stamp included); agentsStatus flags structural drift', () => {
  const d = tmp('ak-oc-sync-');
  const root = makeCatalog(path.join(d, 'catalog'));
  const dest = path.join(d, 'agents');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'coder.md'), '<!-- generated-by: sync-ruflo-agents.mjs -->\nold\n');
  fs.writeFileSync(path.join(dest, 'stale-thing.md'), '<!-- generated-by: sync-ruflo-agents.mjs -->\nold\n');
  fs.writeFileSync(path.join(dest, 'mine.md'), 'user file — never touched\n');
  fs.writeFileSync(path.join(dest, 'extra-coder.md'), 'MY OWN agent, not ak\'s\n'); // user-owned same-name

  const source = catalogSource({ override: root });
  const r1 = syncAgents({ source, destDir: dest });
  assert.equal(r1.ok, true);
  assert.ok(r1.detail.includes('user-owned preserved'), 'user-owned same-name reported');
  assert.equal(fs.existsSync(path.join(dest, 'stale-thing.md')), false, 'stale legacy file removed');
  assert.ok(fs.readFileSync(path.join(dest, 'coder.md'), 'utf8').includes('generated-by: agentic-kit'), 'legacy file adopted');
  assert.equal(fs.readFileSync(path.join(dest, 'mine.md'), 'utf8'), 'user file — never touched\n');
  assert.equal(fs.readFileSync(path.join(dest, 'extra-coder.md'), 'utf8'), 'MY OWN agent, not ak\'s\n', 'user-owned same-name NOT clobbered');

  const st1 = agentsStatus({ source, destDir: dest });
  assert.equal(st1.stale, false);
  assert.equal(st1.count, 1, 'only generated agents counted (coder; extra-coder.md is user-owned, notes.md is documentation)');

  const stampBefore = fs.readFileSync(path.join(dest, '.ak-agents-stamp.json'), 'utf8');
  const r2 = syncAgents({ source, destDir: dest });
  assert.equal(r2.changed, false, 'idempotent second run');
  assert.equal(fs.readFileSync(path.join(dest, '.ak-agents-stamp.json'), 'utf8'), stampBefore, 'stamp not churned on a no-op run');

  // source upgrade → stamp diverges → stale
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.10' }));
  assert.equal(agentsStatus({ source: catalogSource({ override: root }), destDir: dest }).stale, true);
  // structural drift: delete a generated file → stale even with matching source
  fs.rmSync(path.join(dest, 'coder.md'));
  assert.equal(agentsStatus({ source, destDir: dest }).stale, true, 'missing generated file detected');
  rm(d);
});

// ── plugin / skill deploy + removeArtifacts ──────────────────────────────────

test('deployPlugin + pluginStatus: deploy, current, rewrite on template change, never overwrite user-owned', () => {
  const d = tmp('ak-oc-plug-');
  const pkgRoot = path.join(d, 'pkg');
  fs.mkdirSync(path.join(pkgRoot, 'src', 'templates'), { recursive: true });
  const tpl = path.join(pkgRoot, 'src', 'templates', 'opencode-ruflo-hooks.js');
  fs.writeFileSync(tpl, '// ak plugin — see src/templates/opencode-ruflo-hooks.js\n// v1\n');
  const pluginsDir = path.join(d, 'plugins');

  const r1 = deployPlugin({ pkgRoot, pluginsDir });
  assert.equal(r1.changed, true);
  assert.equal(pluginStatus({ pkgRoot, pluginsDir }).current, true);
  assert.equal(deployPlugin({ pkgRoot, pluginsDir }).changed, false, 'idempotent');

  fs.writeFileSync(tpl, '// ak plugin — see src/templates/opencode-ruflo-hooks.js\n// v2\n');
  assert.equal(pluginStatus({ pkgRoot, pluginsDir }).current, false);
  assert.equal(deployPlugin({ pkgRoot, pluginsDir }).changed, true);

  // user-owned file at the slot (no marker) → foreign, preserved
  fs.writeFileSync(path.join(pluginsDir, PLUGIN_NAME), '// my own plugin\n');
  assert.equal(pluginStatus({ pkgRoot, pluginsDir }).foreign, true);
  const r3 = deployPlugin({ pkgRoot, pluginsDir });
  assert.equal(r3.changed, false);
  assert.equal(fs.readFileSync(path.join(pluginsDir, PLUGIN_NAME), 'utf8'), '// my own plugin\n');
  rm(d);
});

test('deploySkill + skillStatus + removeArtifacts (marker-gated, precise teardown)', () => {
  const d = tmp('ak-oc-skill-');
  const root = makeCatalog(path.join(d, 'catalog'));
  const source = catalogSource({ override: root });
  const skillsDir = path.join(d, 'skills');
  const agentsDir = path.join(d, 'agents');
  const pluginsDir = path.join(d, 'plugins');

  const r = deploySkill({ source, skillsDir });
  assert.equal(r.changed, true);
  assert.equal(skillStatus({ source, skillsDir }).current, true);
  assert.equal(deploySkill({ source, skillsDir }).changed, false, 'idempotent');

  // user resource beside the managed file must survive teardown
  fs.writeFileSync(path.join(skillsDir, 'ruflo', 'my-notes.md'), 'user notes\n');

  const pkgRoot = path.join(d, 'pkg');
  fs.mkdirSync(path.join(pkgRoot, 'src', 'templates'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'src', 'templates', 'opencode-ruflo-hooks.js'),
    '// deployed by ak — see src/templates/opencode-ruflo-hooks.js\n');
  deployPlugin({ pkgRoot, pluginsDir });
  syncAgents({ source, destDir: agentsDir });
  fs.writeFileSync(path.join(agentsDir, 'keep.md'), 'user agent\n');

  const gone = removeArtifacts({ pluginsDir, agentsDir, skillsDir });
  assert.equal(gone.changed, true);
  assert.equal(fs.existsSync(path.join(pluginsDir, PLUGIN_NAME)), false);
  assert.equal(fs.existsSync(path.join(skillsDir, 'ruflo', 'SKILL.md')), false);
  assert.equal(fs.existsSync(path.join(agentsDir, 'coder.md')), false);
  assert.equal(fs.readFileSync(path.join(agentsDir, 'keep.md'), 'utf8'), 'user agent\n', 'user agent preserved');
  assert.equal(fs.readFileSync(path.join(skillsDir, 'ruflo', 'my-notes.md'), 'utf8'), 'user notes\n', 'user resource beside managed skill survives');
  assert.equal(fs.existsSync(path.join(skillsDir, 'ruflo')), true, 'non-empty skill dir not pruned');
  rm(d);
});

test('deploySkill never overwrites a user-owned SKILL.md (foreign flagged)', () => {
  const d = tmp('ak-oc-skill-foreign-');
  const root = makeCatalog(path.join(d, 'catalog'));
  const source = catalogSource({ override: root });
  const skillsDir = path.join(d, 'skills');
  fs.mkdirSync(path.join(skillsDir, 'ruflo'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'ruflo', 'SKILL.md'), '---\nname: ruflo\ndescription: my own\n---\n');
  assert.equal(skillStatus({ source, skillsDir }).foreign, true);
  const r = deploySkill({ source, skillsDir });
  assert.equal(r.changed, false);
  assert.ok(fs.readFileSync(path.join(skillsDir, 'ruflo', 'SKILL.md'), 'utf8').includes('my own'));
  rm(d);
});

// ── guidance target + registry scoping ───────────────────────────────────────

test('guidanceTargets includes agents-opencode only when the config home exists (never mkdir)', () => {
  const missing = path.join(os.tmpdir(), `ak-oc-never-${Date.now()}`);
  const without = guidanceTargets({ cwd: '/tmp/z', opencodeRoot: missing });
  assert.equal(without.some((t) => t.name === 'agents-opencode'), false);
  assert.equal(fs.existsSync(missing), false, 'discovery must never mkdir');

  const present = tmp('ak-oc-home-');
  const withOc = guidanceTargets({ cwd: '/tmp/z', opencodeRoot: present });
  const t = withOc.find((x) => x.name === 'agents-opencode');
  assert.ok(t, 'target present when dir exists');
  assert.equal(t.file, path.join(present, 'AGENTS.md'));
  rm(present);
});

test('opencode blocks are scoped to agents-opencode; preamble is shared claude + agents-opencode', () => {
  const oc = BUILTIN_BLOCKS.find((b) => b.slug === 'ruflo-opencode-reference');
  const brain = BUILTIN_BLOCKS.find((b) => b.slug === 'ruvnet-brain-opencode-reference');
  const preamble = BUILTIN_BLOCKS.find((b) => b.slug === 'ruflo-preamble');
  assert.deepEqual(oc.guidanceFiles, ['agents-opencode']);
  assert.deepEqual(brain.guidanceFiles, ['agents-opencode']);
  assert.deepEqual(preamble.guidanceFiles, ['claude', 'agents-opencode']);
  // the claude-only twins must NOT bleed into the opencode file
  const claudeRef = BUILTIN_BLOCKS.find((b) => b.slug === 'ruflo-reference');
  const claudeBrain = BUILTIN_BLOCKS.find((b) => b.slug === 'ruvnet-brain-reference');
  assert.ok(!(claudeRef.guidanceFiles ?? ['claude']).includes('agents-opencode'));
  assert.ok(!(claudeBrain.guidanceFiles ?? ['claude']).includes('agents-opencode'));
});

// ── codex-review round 2 ─────────────────────────────────────────────────────

test('collision → user aligns to desired value: stays unmanaged, undo never restores the stale prior', async () => {
  const d = tmp('ak-oc-align-');
  const file = path.join(d, 'opencode.json');
  const shim = path.join(d, 'absent-shim');
  const userEntry = { type: 'local', command: ['my', 'own'], timeout: 5 };
  fs.writeFileSync(file, JSON.stringify({ mcp: { 'claude-flow': userEntry } }));
  const cfg = cfgOn();
  // 1. collide (user value differs)
  await applyOpencode(cfg, { configFile: file, brainShim: shim });
  // 2. user rewrites their entry to ak's exact desired value
  const want = (await mcpEntriesFor({ brainShim: shim }))['claude-flow'];
  fs.writeFileSync(file, JSON.stringify({ mcp: { 'claude-flow': want } }));
  // 3. re-apply: must NOT adopt with the stale pre-collision prior
  await applyOpencode(cfg, { configFile: file, brainShim: shim });
  assert.equal(cfg.providers.opencodeManaged.mcp['claude-flow'].written, null, 'never owned (not ak-authored)');
  // 4. undo: the user's aligned value must survive — no stale-prior restore
  undoOpencode(cfg, { configFile: file });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcp['claude-flow'], want);
  rm(d);
});

test('desired-set shrink RESTORES a prior (user entry that equaled the old desired value is not deleted)', async () => {
  const d = tmp('ak-oc-restore-');
  const file = path.join(d, 'opencode.json');
  const shim = path.join(d, 'brain.mjs');
  fs.writeFileSync(shim, '// shim\n');
  const cfg = cfgOn();
  // user pre-registers an entry that happens to equal ak's desired brain entry
  const want = (await mcpEntriesFor({ brainShim: shim }))['ruvnet-brain'];
  fs.writeFileSync(file, JSON.stringify({ mcp: { 'ruvnet-brain': want } }));
  await applyOpencode(cfg, { configFile: file, brainShim: shim });
  fs.rmSync(shim); // brain leaves the desired set
  await applyOpencode(cfg, { configFile: file, brainShim: shim });
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(doc.mcp['ruvnet-brain'], want, 'prior value restored, not deleted');
  rm(d);
});

test('a pre-existing {"*":"ask"} permission OBJECT survives undo as an object (no phantom scalar restore)', async () => {
  const d = tmp('ak-oc-starobj-');
  const file = path.join(d, 'opencode.json');
  fs.writeFileSync(file, JSON.stringify({ permission: { '*': 'ask' } }));
  const cfg = cfgOn();
  await applyOpencode(cfg, { configFile: file, brainShim: path.join(d, 'absent-shim') });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).permission['claude-flow_*'], 'allow');
  undoOpencode(cfg, { configFile: file });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after.permission, { '*': 'ask' }, 'object form preserved, not collapsed to "ask"');
  rm(d);
});

test('opencode guidance blocks are enablement-gated (flag): absent when disabled, stripped on disable', async () => {
  const { registry, syncBlocks, blocksForTarget, retiredForTarget } = await import('../../src/lib/blocks.mjs');
  const d = tmp('ak-oc-flag-');
  const file = path.join(d, 'AGENTS.md');
  const tplDir = path.join(d, 'tpl');
  fs.mkdirSync(tplDir);
  fs.writeFileSync(path.join(tplDir, 'tpl.md'), '<!-- BEGIN SLUG -->\nBLOCK\n<!-- END SLUG -->\n');
  const rows = registry();
  const resolve = (row) => {
    const body = fs.readFileSync(path.join(tplDir, 'tpl.md'), 'utf8').replaceAll('SLUG', row.slug);
    const p = path.join(tplDir, `${row.slug}.md`);
    fs.writeFileSync(p, body);
    return p;
  };
  const treg = [...blocksForTarget(rows, 'agents-opencode'), ...retiredForTarget(rows, 'agents-opencode')];
  // disabled → the enablement-gated blocks do NOT upsert (the host-agnostic
  // preamble legitimately still can — it asserts no wiring)
  const off = await syncBlocks(file, treg, resolve, { context: { flags: { opencodeEnabled: false } } });
  for (const slug of ['ruflo-opencode-reference', 'ruvnet-brain-opencode-reference']) {
    assert.ok(!off.some((r) => r.slug === slug && r.action === 'upserted'), `${slug} must not upsert while disabled`);
  }
  // enabled → upserted
  const on = await syncBlocks(file, treg, resolve, { context: { flags: { opencodeEnabled: true } } });
  assert.ok(on.some((r) => r.slug === 'ruflo-opencode-reference' && r.action === 'upserted'));
  assert.ok(on.some((r) => r.slug === 'ruvnet-brain-opencode-reference' && r.action === 'upserted'));
  // disabled again → stripped
  const off2 = await syncBlocks(file, treg, resolve, { context: { flags: { opencodeEnabled: false } } });
  assert.ok(off2.some((r) => r.slug === 'ruflo-opencode-reference' && r.action === 'stripped'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('BEGIN ruflo-opencode-reference'));
  rm(d);
});

test('isDefault is false when the opencode host is enabled', async () => {
  const { isDefault } = await import('../../src/lib/providers.mjs');
  assert.equal(isDefault(cfgOn()), false);
  assert.equal(isDefault({ providers: { hosts: { claude: true, codex: false, opencode: false } } }), true);
});

test('the deployed plugin template uses schema-valid PartIDs (prt prefix) for injected parts', () => {
  const tpl = fs.readFileSync(new URL('../../src/templates/opencode-ruflo-hooks.js', import.meta.url), 'utf8');
  const m = tpl.match(/id:\s*`([^`]+)`/);
  assert.ok(m, 'template constructs a part id');
  assert.ok(m[1].startsWith('prt'), `part id must start with "prt" (opencode PartID schema), got: ${m[1]}`);
});
