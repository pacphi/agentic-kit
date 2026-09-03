import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyOpencode, undoOpencode, opencodeMcpStatus, opencodeConverged, mcpEntriesFor,
  catalogSource, skillPathsFor, convertAgents, syncAgents, agentsStatus,
  deployPlugin, pluginStatus, deploySkill, skillStatus, removeArtifacts,
  PLUGIN_NAME, createOpencodeLifecycleAdapter, opencodeStack,
} from '../../src/lib/opencode.mjs';
import { runLifecycle } from '../../src/lib/adapters/lifecycle.mjs';
import { detectHosts } from '../../src/lib/providers.mjs';
import { guidanceTargets, BUILTIN_BLOCKS } from '../../src/lib/blocks.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const cfgOn = () => ({
  integrations: {
    version: 2,
    hosts: { claude: true, codex: false, opencode: true },
    bindings: [],
    ownership: { opencode: { mcp: null, managed: null, catalogDir: null } },
  },
  routing: { version: 1, primaryHost: 'claude', routes: {} },
  providers: {},
});

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
  assert.ok(path.isAbsolute(withBrain['claude-flow'].environment.AGENT_BROWSER_CONFIG));
  const browserOff = await mcpEntriesFor({ brainShim: shim, agentBrowserEnabled: false });
  assert.equal(browserOff['claude-flow'].environment.AGENT_BROWSER_CONFIG, undefined);
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

test('a later opencode.jsonc override blocks convergence and executable projection', async () => {
  const d = tmp('ak-oc-later-jsonc-');
  const configFile = path.join(d, 'opencode.json');
  const pluginsDir = path.join(d, 'plugins');
  const agentsDir = path.join(d, 'agents');
  const skillsDir = path.join(d, 'skills');
  fs.writeFileSync(configFile, JSON.stringify({ user: { keep: true } }));
  fs.writeFileSync(path.join(d, 'opencode.jsonc'), '{\n// loaded last\n"mcp": {}\n}\n');
  const before = fs.readFileSync(configFile, 'utf8');

  const status = opencodeMcpStatus(cfgOn(), { configFile });
  assert.equal(status.laterOverride, path.join(d, 'opencode.jsonc'));
  const convergence = await opencodeConverged(cfgOn(), { configFile });
  assert.equal(convergence.converged, false);
  assert.match(convergence.reasons[0], /later OpenCode config override is unverified/);

  const result = await opencodeStack(cfgOn(), {
    pkgRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    configFile,
    pluginsDir,
    agentsDir,
    skillsDir,
  });
  assert.equal(result.oc.fatal, true);
  assert.match(result.oc.detail, /loads after opencode\.json/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before, 'owned JSON is untouched');
  assert.equal(fs.existsSync(pluginsDir), false, 'no executable plugin is deployed');
  assert.equal(fs.existsSync(agentsDir), false, 'no specialist is deployed');
  assert.equal(fs.existsSync(skillsDir), false, 'no skill is deployed');
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
  cfg.integrations.ownership.opencode.catalogDir = srcRoot;
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
  const expectedPermissionKeys = [
    'claude-flow_*', 'claude_flow_*',
    'agentic-qe_*', 'agentic_qe_*',
    'ruvnet-brain_*', 'ruvnet_brain_*',
  ];
  for (const k of expectedPermissionKeys) assert.equal(doc.permission[k], 'allow');
  assert.equal(cfg.integrations.ownership.opencode.mcp, 'ak');
  // value-precise ownership: claude-flow had no prior → prior null, written recorded
  const rec = cfg.integrations.ownership.opencode.managed.mcp['claude-flow'];
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
  for (const k of expectedPermissionKeys) assert.equal(after.permission[k], undefined);
  assert.equal(cfg.integrations.ownership.opencode.mcp, null);
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
  const r = await applyOpencode({
    integrations: { hosts: { opencode: false } },
  }, { configFile: file });
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
  fs.writeFileSync(path.join(dest, 'mine.md'), 'user file — never touched\n');
  fs.writeFileSync(path.join(dest, 'extra-coder.md'), 'MY OWN agent, not ak\'s\n'); // user-owned same-name

  const source = catalogSource({ override: root });
  const r1 = syncAgents({ source, destDir: dest });
  assert.equal(r1.ok, true);
  assert.ok(r1.detail.includes('user-owned preserved'), 'user-owned same-name reported');
  assert.ok(fs.readFileSync(path.join(dest, 'coder.md'), 'utf8').includes('generated-by: agentic-kit'));
  assert.equal(fs.readFileSync(path.join(dest, 'mine.md'), 'utf8'), 'user file — never touched\n');
  assert.equal(fs.readFileSync(path.join(dest, 'extra-coder.md'), 'utf8'), 'MY OWN agent, not ak\'s\n', 'user-owned same-name NOT clobbered');

  const st1 = agentsStatus({ source, destDir: dest });
  assert.equal(st1.stale, false);
  assert.equal(st1.count, 1, 'only generated agents counted (coder; extra-coder.md is user-owned, notes.md is documentation)');

  const stampBefore = fs.readFileSync(path.join(dest, '.ak-agents-stamp.json'), 'utf8');
  const r2 = syncAgents({
    source, destDir: dest, receipts: r1.receipts, stampReceipt: r1.stampReceipt,
  });
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
  assert.equal(pluginStatus({ pkgRoot, pluginsDir, receipt: r1.receipt }).current, true);
  assert.equal(deployPlugin({ pkgRoot, pluginsDir, receipt: r1.receipt }).changed, false, 'idempotent');

  fs.writeFileSync(tpl, '// ak plugin — see src/templates/opencode-ruflo-hooks.js\n// v2\n');
  assert.equal(pluginStatus({ pkgRoot, pluginsDir, receipt: r1.receipt }).current, false);
  const r2 = deployPlugin({ pkgRoot, pluginsDir, receipt: r1.receipt });
  assert.equal(r2.changed, true);

  fs.appendFileSync(path.join(pluginsDir, PLUGIN_NAME), '// user edit retaining marker\n');
  assert.equal(deployPlugin({ pkgRoot, pluginsDir, receipt: r2.receipt }).changed, false,
    'edited managed plugin is preserved despite retaining the marker');

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
  assert.equal(skillStatus({ source, skillsDir, receipt: r.receipt }).current, true);
  assert.equal(deploySkill({ source, skillsDir, receipt: r.receipt }).changed, false, 'idempotent');

  // user resource beside the managed file must survive teardown
  fs.writeFileSync(path.join(skillsDir, 'ruflo', 'my-notes.md'), 'user notes\n');

  const pkgRoot = path.join(d, 'pkg');
  fs.mkdirSync(path.join(pkgRoot, 'src', 'templates'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'src', 'templates', 'opencode-ruflo-hooks.js'),
    '// deployed by ak — see src/templates/opencode-ruflo-hooks.js\n');
  const plugin = deployPlugin({ pkgRoot, pluginsDir });
  const agents = syncAgents({ source, destDir: agentsDir });
  fs.writeFileSync(path.join(agentsDir, 'keep.md'), 'user agent\n');

  const gone = removeArtifacts({
    pluginsDir, agentsDir, skillsDir,
    receipts: {
      plugin: plugin.receipt, agents: agents.receipts,
      agentStamp: agents.stampReceipt, skill: r.receipt,
    },
  });
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

test('edited agent and skill are preserved on receipt-aware redeploy and reported modified', () => {
  const d = tmp('ak-oc-edited-');
  const source = catalogSource({ override: makeCatalog(path.join(d, 'catalog')) });
  const agentsDir = path.join(d, 'agents');
  const skillsDir = path.join(d, 'skills');
  const agents = syncAgents({ source, destDir: agentsDir });
  const skill = deploySkill({ source, skillsDir });
  const agentPath = path.join(agentsDir, 'coder.md');
  const skillPath = path.join(skillsDir, 'ruflo', 'SKILL.md');
  fs.appendFileSync(agentPath, '\nUser edit.\n');
  fs.appendFileSync(skillPath, '\nUser edit.\n');
  const editedAgent = fs.readFileSync(agentPath, 'utf8');
  const editedSkill = fs.readFileSync(skillPath, 'utf8');

  assert.equal(agentsStatus({ source, destDir: agentsDir, receipts: agents.receipts }).modified, true);
  const agentRetry = syncAgents({
    source, destDir: agentsDir, receipts: agents.receipts, stampReceipt: agents.stampReceipt,
  });
  const skillRetry = deploySkill({ source, skillsDir, receipt: skill.receipt });
  assert.equal(fs.readFileSync(agentPath, 'utf8'), editedAgent);
  assert.equal(fs.readFileSync(skillPath, 'utf8'), editedSkill);
  assert.equal(agentRetry.receipts['coder.md'], agents.receipts['coder.md'],
    'edited agent keeps its mismatched receipt so a later pass cannot launder it as unreceipted');
  assert.equal(skillRetry.changed, false);
  rm(d);
});

test('exact marker-bearing desired bytes without prior receipts are adopted once for safe teardown', () => {
  const d = tmp('ak-oc-unreceipted-');
  const source = catalogSource({ override: makeCatalog(path.join(d, 'catalog')) });
  const skillsDir = path.join(d, 'skills');
  const agentsDir = path.join(d, 'agents');
  const pluginsDir = path.join(d, 'plugins');
  const pkgRoot = path.join(d, 'pkg');
  fs.mkdirSync(path.join(pkgRoot, 'src', 'templates'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'src', 'templates', 'opencode-ruflo-hooks.js'),
    '// src/templates/opencode-ruflo-hooks.js\n');
  const first = deploySkill({ source, skillsDir });
  const firstPlugin = deployPlugin({ pkgRoot, pluginsDir });
  const firstAgents = syncAgents({ source, destDir: agentsDir });
  const skillPath = path.join(skillsDir, 'ruflo', 'SKILL.md');
  const pluginPath = path.join(pluginsDir, PLUGIN_NAME);
  const stampPath = path.join(agentsDir, '.ak-agents-stamp.json');
  const exact = {
    skill: fs.readFileSync(skillPath, 'utf8'),
    plugin: fs.readFileSync(pluginPath, 'utf8'),
    agents: Object.fromEntries(Object.keys(firstAgents.receipts).map((file) => [
      file, fs.readFileSync(path.join(agentsDir, file), 'utf8'),
    ])),
    stamp: fs.readFileSync(stampPath, 'utf8'),
  };
  fs.rmSync(path.join(skillsDir, 'ruflo'), { recursive: true });
  fs.rmSync(pluginsDir, { recursive: true });
  fs.rmSync(agentsDir, { recursive: true });
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(skillPath, exact.skill);
  fs.writeFileSync(pluginPath, exact.plugin);
  for (const [file, text] of Object.entries(exact.agents)) {
    fs.writeFileSync(path.join(agentsDir, file), text);
  }
  fs.writeFileSync(stampPath, exact.stamp);
  assert.equal(skillStatus({ source, skillsDir, receipt: null }).adoptable, true);
  assert.equal(pluginStatus({ pkgRoot, pluginsDir, receipt: null }).adoptable, true);
  assert.equal(agentsStatus({
    source, destDir: agentsDir, receipts: {}, stampReceipt: null,
  }).adoptable, true);
  const unownedSkill = deploySkill({ source, skillsDir, receipt: null });
  const unownedPlugin = deployPlugin({ pkgRoot, pluginsDir, receipt: null });
  const unownedAgents = syncAgents({
    source, destDir: agentsDir, receipts: {}, stampReceipt: null,
  });
  assert.equal(unownedSkill.changed, false);
  assert.equal(unownedPlugin.changed, false);
  assert.equal(unownedAgents.changed, false, unownedAgents.detail);
  assert.equal(unownedSkill.adopted, true);
  assert.equal(unownedPlugin.adopted, true);
  assert.equal(unownedAgents.adopted, Object.keys(exact.agents).length);
  assert.ok(unownedSkill.receipt);
  assert.ok(unownedPlugin.receipt);
  assert.ok(unownedAgents.receipts['coder.md']);
  assert.ok(unownedAgents.stampReceipt);
  removeArtifacts({
    skillsDir, pluginsDir, agentsDir,
    receipts: {
      skill: unownedSkill.receipt, plugin: unownedPlugin.receipt,
      agents: unownedAgents.receipts, agentStamp: unownedAgents.stampReceipt,
    },
  });
  assert.equal(fs.existsSync(skillPath), false);
  assert.equal(fs.existsSync(pluginPath), false);
  for (const file of Object.keys(exact.agents)) {
    assert.equal(fs.existsSync(path.join(agentsDir, file)), false);
  }
  assert.equal(fs.existsSync(stampPath), false);
  assert.ok(first.receipt, 'fixture first deploy produced a real receipt');
  assert.ok(firstPlugin.receipt);
  assert.ok(firstAgents.stampReceipt);
  rm(d);
});

test('receipt-based teardown preserves marker-bearing artifacts edited by the user', () => {
  const d = tmp('ak-oc-receipts-');
  const source = catalogSource({ override: makeCatalog(path.join(d, 'catalog')) });
  const skillsDir = path.join(d, 'skills');
  const agentsDir = path.join(d, 'agents');
  const pluginsDir = path.join(d, 'plugins');
  const pkgRoot = path.join(d, 'pkg');
  fs.mkdirSync(path.join(pkgRoot, 'src', 'templates'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'src', 'templates', 'opencode-ruflo-hooks.js'),
    '// src/templates/opencode-ruflo-hooks.js\n');
  const plugin = deployPlugin({ pkgRoot, pluginsDir });
  const agents = syncAgents({ source, destDir: agentsDir });
  const skill = deploySkill({ source, skillsDir });
  fs.appendFileSync(path.join(pluginsDir, PLUGIN_NAME), '// user edit\n');
  fs.appendFileSync(path.join(agentsDir, 'coder.md'), '\nUser edit.\n');
  fs.appendFileSync(path.join(skillsDir, 'ruflo', 'SKILL.md'), '\nUser edit.\n');

  removeArtifacts({
    pluginsDir, agentsDir, skillsDir,
    receipts: {
      plugin: plugin.receipt, agents: agents.receipts,
      agentStamp: agents.stampReceipt, skill: skill.receipt,
    },
  });

  assert.ok(fs.existsSync(path.join(pluginsDir, PLUGIN_NAME)));
  assert.ok(fs.existsSync(path.join(agentsDir, 'coder.md')));
  assert.ok(fs.existsSync(path.join(skillsDir, 'ruflo', 'SKILL.md')));
  rm(d);
});

test('a mismatched agent receipt survives two passes and cannot become an adoption gap', () => {
  const d = tmp('ak-oc-agent-launder-');
  const root = makeCatalog(path.join(d, 'catalog'));
  const source = catalogSource({ override: root });
  const agentsDir = path.join(d, 'agents');
  const first = syncAgents({ source, destDir: agentsDir });
  const agentPath = path.join(agentsDir, 'coder.md');
  fs.appendFileSync(agentPath, '\nUser edit.\n');

  const sourceAgent = path.join(root, '.claude', 'agents', 'core', 'coder.md');
  fs.appendFileSync(sourceAgent, '\nCatalog v2.\n');
  const upgraded = catalogSource({ override: root });
  const second = syncAgents({
    source: upgraded, destDir: agentsDir,
    receipts: first.receipts, stampReceipt: first.stampReceipt,
  });
  assert.equal(second.receipts['coder.md'], first.receipts['coder.md'],
    'the mismatched receipt remains as negative ownership evidence');

  const desiredV2 = convertAgents(root).agents.find((a) => a.name === 'coder').content;
  fs.writeFileSync(agentPath, desiredV2);
  const third = syncAgents({
    source: upgraded, destDir: agentsDir,
    receipts: second.receipts, stampReceipt: second.stampReceipt,
  });
  assert.equal(third.adopted, 0, 'a non-null mismatched receipt blocks absence-based adoption');
  assert.equal(third.receipts['coder.md'], first.receipts['coder.md']);
  assert.match(third.detail, /user-owned preserved/);
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
  assert.equal(cfg.integrations.ownership.opencode.managed.mcp['claude-flow'].written, null, 'never owned (not ak-authored)');
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

test('permission desired-set shrink restores a recorded user prior', async () => {
  const d = tmp('ak-oc-permission-restore-');
  const file = path.join(d, 'opencode.json');
  const key = 'agentic-qe_*';
  fs.writeFileSync(file, JSON.stringify({ permission: { [key]: 'allow' } }));
  const cfg = cfgOn();
  try {
    await applyOpencode(cfg, { configFile: file, brainShim: path.join(d, 'absent-shim') });
    cfg.aqe = false;
    await applyOpencode(cfg, { configFile: file, brainShim: path.join(d, 'absent-shim') });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).permission[key], 'allow');
  } finally {
    rm(d);
  }
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

test('opencode guidance blocks respect host enablement when Brain is enabled', async () => {
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
  const context = (opencodeEnabled) => ({
    context: { flags: { opencodeEnabled, ruvnetBrainEnabled: true } },
  });
  // disabled → the enablement-gated blocks do NOT upsert (the host-agnostic
  // preamble legitimately still can — it asserts no wiring)
  const off = await syncBlocks(file, treg, resolve, context(false));
  for (const slug of ['ruflo-opencode-reference', 'ruvnet-brain-opencode-reference']) {
    assert.ok(!off.some((r) => r.slug === slug && r.action === 'upserted'), `${slug} must not upsert while disabled`);
  }
  // enabled → upserted
  const on = await syncBlocks(file, treg, resolve, context(true));
  assert.ok(on.some((r) => r.slug === 'ruflo-opencode-reference' && r.action === 'upserted'));
  assert.ok(on.some((r) => r.slug === 'ruvnet-brain-opencode-reference' && r.action === 'upserted'));
  // disabled again → stripped
  const off2 = await syncBlocks(file, treg, resolve, context(false));
  assert.ok(off2.some((r) => r.slug === 'ruflo-opencode-reference' && r.action === 'stripped'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('BEGIN ruflo-opencode-reference'));
  rm(d);
});

test('isDefault is false when the opencode host is enabled', async () => {
  const { isDefault } = await import('../../src/lib/providers.mjs');
  assert.equal(isDefault(cfgOn()), false);
  assert.equal(isDefault({
    integrations: { hosts: { claude: true, codex: false, opencode: false } },
    providers: {},
  }), true);
});

test('the deployed plugin template uses schema-valid PartIDs (prt prefix) for injected parts', () => {
  const tpl = fs.readFileSync(new URL('../../src/templates/opencode-ruflo-hooks.js', import.meta.url), 'utf8');
  const m = tpl.match(/id:\s*`([^`]+)`/);
  assert.ok(m, 'template constructs a part id');
  assert.ok(m[1].startsWith('prt'), `part id must start with "prt" (opencode PartID schema), got: ${m[1]}`);
});

test('mcpCommandFor: bin on PATH → nested mcp-server.js → ruflo mcp start (fresh-machine chain)', async () => {
  const { mcpCommandFor } = await import('../../src/lib/opencode.mjs');
  const d = tmp('ak-oc-mcpcmd-');
  const nested = path.join(d, 'mcp-server.js');
  fs.writeFileSync(nested, '// server\n');
  assert.deepEqual(mcpCommandFor({ binPresent: true, nestedPath: nested }), ['claude-flow-mcp'], 'bin wins when present');
  assert.deepEqual(mcpCommandFor({ binPresent: false, nestedPath: nested }), ['node', nested], 'nested absolute path when no bin (fresh ruflo-only machine)');
  assert.deepEqual(mcpCommandFor({ binPresent: false, nestedPath: path.join(d, 'absent.js') }), ['ruflo', 'mcp', 'start'], 'last resort matches the claude/codex registration');
  rm(d);
});

// codex-review r3: applyOpencode re-records the ownership markers on EVERY
// run, including a converged one. If kit.json's markers went stale/missing
// while the file stayed converged (hand-edit, legacy install), opencodeStack
// must report markersChanged so the caller persists them — otherwise the next
// teardown cannot prove ownership and strands ak-written keys.
// codex-review r4: this file is NOT home-sandboxed — the stack runs against
// EXPLICIT tmp destinations (the seams), never the production defaults.
test('opencodeStack reports markersChanged when a converged file has stale/missing markers', async () => {
  const { opencodeStack } = await import('../../src/lib/opencode.mjs');
  const { fileURLToPath } = await import('node:url');
  const d = tmp('ak-oc-markers-');
  const srcRoot = makeCatalog(path.join(d, 'catalog'));
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  // Every destination is inside the tmp dir — nothing escapes to the real home.
  const seams = {
    configFile: path.join(d, 'opencode.json'),
    pluginsDir: path.join(d, 'plugins'),
    agentsDir: path.join(d, 'agents'),
    skillsDir: path.join(d, 'skills'),
  };
  const cfg = cfgOn();
  cfg.integrations.ownership.opencode.catalogDir = srcRoot;
  await opencodeStack(cfg, { pkgRoot, ...seams }); // initial wire (markers recorded)
  assert.ok(fs.existsSync(seams.configFile), 'wiring landed in the tmp config, not the real one');
  // Simulate staleness: the markers vanish from kit.json while the file stays.
  cfg.integrations.ownership.opencode.mcp = null;
  cfg.integrations.ownership.opencode.managed = null;
  const second = await opencodeStack(cfg, { pkgRoot, ...seams });
  assert.equal(second.oc.changed, false, 'the file itself is already converged');
  assert.equal(second.markersChanged, true, 'but the refreshed markers must be persisted by the caller');
  assert.equal(second.plugin.adopted, true);
  assert.ok(second.agents.adopted > 0);
  assert.equal(second.skill.adopted, true);
  assert.equal(cfg.integrations.ownership.opencode.mcp, 'ak');
  assert.ok(cfg.integrations.ownership.opencode.managed?.mcp?.['claude-flow']?.written);
  assert.ok(cfg.integrations.ownership.opencode.managed?.artifacts?.plugin);
  assert.ok(cfg.integrations.ownership.opencode.managed?.artifacts?.agents?.['ak-specialist.md']);
  assert.ok(cfg.integrations.ownership.opencode.managed?.artifacts?.agentStamp);
  assert.ok(cfg.integrations.ownership.opencode.managed?.artifacts?.skill);
  // A third run with truthful markers is then fully quiet.
  const third = await opencodeStack(cfg, { pkgRoot, ...seams });
  assert.equal(third.markersChanged, false, 'no kit.json churn once the markers are truthful');
  rm(d);
});

test('opencodeStack normalizes poisoned null artifact maps before adopting exact legacy files', async () => {
  const { opencodeStack } = await import('../../src/lib/opencode.mjs');
  const { fileURLToPath } = await import('node:url');
  const d = tmp('ak-oc-null-receipts-');
  const seams = {
    configFile: path.join(d, 'opencode.json'),
    pluginsDir: path.join(d, 'plugins'),
    agentsDir: path.join(d, 'agents'),
    skillsDir: path.join(d, 'skills'),
  };
  const cfg = cfgOn();
  cfg.integrations.ownership.opencode.catalogDir = makeCatalog(path.join(d, 'catalog'));
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  await opencodeStack(cfg, { pkgRoot, ...seams });
  cfg.integrations.ownership.opencode.managed.artifacts = {
    plugin: null, agents: null, agentStamp: null, skill: null,
  };
  const adopted = await opencodeStack(cfg, { pkgRoot, ...seams });
  assert.equal(adopted.plugin.adopted, true);
  assert.ok(adopted.agents.adopted > 0);
  assert.equal(adopted.skill.adopted, true);
  assert.ok(cfg.integrations.ownership.opencode.managed.artifacts.agents['ak-specialist.md']);
  rm(d);
});

test('non-null poisoned receipts are preserved and never treated as an adoption gap', async () => {
  const { opencodeStack } = await import('../../src/lib/opencode.mjs');
  const { fileURLToPath } = await import('node:url');
  const d = tmp('ak-oc-poisoned-receipts-');
  const seams = {
    configFile: path.join(d, 'opencode.json'),
    pluginsDir: path.join(d, 'plugins'),
    agentsDir: path.join(d, 'agents'),
    skillsDir: path.join(d, 'skills'),
  };
  const cfg = cfgOn();
  cfg.integrations.ownership.opencode.catalogDir = makeCatalog(path.join(d, 'catalog'));
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  await opencodeStack(cfg, { pkgRoot, ...seams });
  const agentNames = Object.keys(cfg.integrations.ownership.opencode.managed.artifacts.agents);
  cfg.integrations.ownership.opencode.managed.artifacts = {
    plugin: '',
    agents: Object.fromEntries(agentNames.map((name) => [name, ''])),
    agentStamp: '',
    skill: '',
  };
  const refused = await opencodeStack(cfg, { pkgRoot, ...seams });
  assert.notEqual(refused.plugin.adopted, true);
  assert.equal(refused.agents.adopted, 0);
  assert.notEqual(refused.skill.adopted, true);
  assert.equal(cfg.integrations.ownership.opencode.managed.artifacts.plugin, '');
  assert.deepEqual(cfg.integrations.ownership.opencode.managed.artifacts.agents,
    Object.fromEntries(agentNames.map((name) => [name, ''])));
  assert.equal(cfg.integrations.ownership.opencode.managed.artifacts.agentStamp, '');
  assert.equal(cfg.integrations.ownership.opencode.managed.artifacts.skill, '');
  rm(d);
});

test('malformed non-null receipt containers fail closed without adopting or rewriting the ledger', async () => {
  const { opencodeStack } = await import('../../src/lib/opencode.mjs');
  const { fileURLToPath } = await import('node:url');
  const d = tmp('ak-oc-malformed-receipts-');
  const seams = {
    configFile: path.join(d, 'opencode.json'),
    pluginsDir: path.join(d, 'plugins'),
    agentsDir: path.join(d, 'agents'),
    skillsDir: path.join(d, 'skills'),
  };
  const cfg = cfgOn();
  cfg.integrations.ownership.opencode.catalogDir = makeCatalog(path.join(d, 'catalog'));
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  await opencodeStack(cfg, { pkgRoot, ...seams });
  const artifactFiles = [
    path.join(seams.pluginsDir, PLUGIN_NAME),
    ...Object.keys(cfg.integrations.ownership.opencode.managed.artifacts.agents)
      .map((file) => path.join(seams.agentsDir, file)),
    path.join(seams.agentsDir, '.ak-agents-stamp.json'),
    path.join(seams.skillsDir, 'ruflo', 'SKILL.md'),
  ];
  const exactBytes = artifactFiles.map((file) => fs.readFileSync(file, 'utf8'));

  for (const malformed of ['corrupt', [], { agents: 'corrupt' }]) {
    cfg.integrations.ownership.opencode.managed.artifacts = structuredClone(malformed);
    const result = await opencodeStack(cfg, { pkgRoot, ...seams });
    assert.notEqual(result.plugin.adopted, true);
    assert.equal(result.agents.adopted, 0);
    assert.notEqual(result.skill.adopted, true);
    assert.deepEqual(cfg.integrations.ownership.opencode.managed.artifacts, malformed,
      'a non-null malformed container is preserved byte-for-byte as repair evidence');
    assert.deepEqual(artifactFiles.map((file) => fs.readFileSync(file, 'utf8')), exactBytes,
      'fail-closed reconciliation never rewrites artifact files');
  }
  rm(d);
});

test('a malformed receipt ledger cannot create absent artifacts across repeated reconciliation', async () => {
  const { opencodeStack } = await import('../../src/lib/opencode.mjs');
  const { fileURLToPath } = await import('node:url');
  const d = tmp('ak-oc-malformed-empty-');
  const seams = {
    configFile: path.join(d, 'opencode.json'),
    pluginsDir: path.join(d, 'plugins'),
    agentsDir: path.join(d, 'agents'),
    skillsDir: path.join(d, 'skills'),
  };
  const cfg = cfgOn();
  cfg.integrations.ownership.opencode.catalogDir = makeCatalog(path.join(d, 'catalog'));
  cfg.integrations.ownership.opencode.managed = { artifacts: 'corrupt' };
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  for (let pass = 1; pass <= 2; pass++) {
    const result = await opencodeStack(cfg, { pkgRoot, ...seams });
    assert.equal(result.plugin.adoptionBlocked, true);
    assert.equal(result.agents.adoptionBlocked, true);
    assert.equal(result.skill.adoptionBlocked, true);
    assert.equal(result.plugin.changed, false);
    assert.equal(result.agents.changed, false);
    assert.equal(result.skill.changed, false);
    assert.equal(result.markersChanged, pass === 1,
      'only the independently managed opencode.json receipt may converge');
    assert.equal(cfg.integrations.ownership.opencode.managed.artifacts, 'corrupt');
    for (const dir of [seams.pluginsDir, seams.agentsDir, seams.skillsDir]) {
      assert.equal(fs.existsSync(dir), false, `${path.basename(dir)} must remain absent`);
    }
  }
  rm(d);
});

test('opencodeStack deploys no executable artifacts when JSONC config is refused', async () => {
  const { opencodeStack } = await import('../../src/lib/opencode.mjs');
  const { fileURLToPath } = await import('node:url');
  const d = tmp('ak-oc-jsonc-stack-');
  const configFile = path.join(d, 'opencode.json');
  fs.writeFileSync(configFile, '{\n// legal JSONC\n"mcp": {}\n}\n');
  const cfg = cfgOn();
  cfg.integrations.ownership.opencode.catalogDir = makeCatalog(path.join(d, 'catalog'));
  const result = await opencodeStack(cfg, {
    pkgRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    configFile,
    pluginsDir: path.join(d, 'plugins'),
    agentsDir: path.join(d, 'agents'),
    skillsDir: path.join(d, 'skills'),
  });
  assert.equal(result.oc.ok, false);
  for (const dir of ['plugins', 'agents', 'skills']) {
    assert.equal(fs.existsSync(path.join(d, dir)), false, `${dir} must not be partially deployed`);
  }
  rm(d);
});

test('opencodeStack preserves a valid config collision while converging independent artifacts', async () => {
  const { opencodeStack } = await import('../../src/lib/opencode.mjs');
  const { fileURLToPath } = await import('node:url');
  const d = tmp('ak-oc-collision-stack-');
  const configFile = path.join(d, 'opencode.json');
  const userMcp = { type: 'local', command: ['my', 'server'] };
  fs.writeFileSync(configFile, JSON.stringify({ mcp: { 'claude-flow': userMcp } }));
  const cfg = cfgOn();
  cfg.integrations.ownership.opencode.catalogDir = makeCatalog(path.join(d, 'catalog'));
  const result = await opencodeStack(cfg, {
    pkgRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    configFile,
    pluginsDir: path.join(d, 'plugins'),
    agentsDir: path.join(d, 'agents'),
    skillsDir: path.join(d, 'skills'),
  });
  assert.equal(result.oc.fatal, false);
  assert.equal(result.oc.ok, false, 'collision remains an explicit warning');
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).mcp['claude-flow'], userMcp);
  assert.ok(fs.existsSync(path.join(d, 'plugins', PLUGIN_NAME)));
  assert.ok(fs.existsSync(path.join(d, 'agents', 'ak-specialist.md')));
  assert.ok(fs.existsSync(path.join(d, 'skills', 'ruflo', 'SKILL.md')));
  rm(d);
});

test('OpenCode lifecycle detect/plan/dry-run are read-only; apply and undo are idempotent', async () => {
  const { fileURLToPath } = await import('node:url');
  const d = tmp('ak-oc-lifecycle-');
  const srcRoot = makeCatalog(path.join(d, 'catalog'));
  const options = {
    pkgRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    configFile: path.join(d, 'opencode.json'),
    pluginsDir: path.join(d, 'plugins'),
    agentsDir: path.join(d, 'agents'),
    skillsDir: path.join(d, 'skills'),
  };
  const cfg = cfgOn();
  cfg.integrations.ownership.opencode.catalogDir = srcRoot;
  const adapter = createOpencodeLifecycleAdapter(options);
  const before = JSON.stringify(cfg);
  await runLifecycle({ adapter, action: 'detect', cfg });
  await runLifecycle({ adapter, action: 'plan', cfg });
  await runLifecycle({ adapter, action: 'apply', cfg, dryRun: true });
  assert.equal(JSON.stringify(cfg), before, 'read-only lifecycle phases do not mutate config receipts');
  assert.equal(fs.existsSync(options.configFile), false, 'dry-run creates no OpenCode surface');

  const first = await runLifecycle({ adapter, action: 'apply', cfg });
  cfg.integrations.ownership.opencode.managed.artifacts = {
    plugin: null, agents: {}, agentStamp: null, skill: null,
  };
  const adoptionPlan = await runLifecycle({ adapter, action: 'plan', cfg });
  assert.equal(adoptionPlan.changed, true, 'read-only detection exposes receipt adoption as planned work');
  assert.equal(adoptionPlan.facts.plugin.adoptable, true);
  assert.equal(adoptionPlan.facts.agents.adoptable, true);
  assert.equal(adoptionPlan.facts.skill.adoptable, true);
  const migrated = await runLifecycle({ adapter, action: 'apply', cfg });
  cfg.integrations.ownership.opencode.managed.artifacts.agentStamp = null;
  const stampPlan = await runLifecycle({ adapter, action: 'plan', cfg });
  assert.equal(stampPlan.facts.agents.adoptable, true,
    'an exact stamp with independently receipted agents is itself adoptable');
  const stampMigrated = await runLifecycle({ adapter, action: 'apply', cfg });
  const second = await runLifecycle({ adapter, action: 'apply', cfg });
  assert.equal(first.changed, true);
  assert.equal(migrated.changed, true, 'receipt-only adoption persists markers without rewriting artifacts');
  assert.equal(stampMigrated.changed, true);
  assert.equal(second.changed, false);
  const undone = await runLifecycle({ adapter, action: 'undo', cfg });
  const repeated = await runLifecycle({ adapter, action: 'undo', cfg });
  assert.equal(undone.changed, true);
  assert.equal(repeated.changed, false);
  rm(d);
});
