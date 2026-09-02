import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enabledPluginRefs, inspectCodexPlugins } from '../../src/lib/codex-plugins.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-codex-plugins-'));
const configFile = path.join(ROOT, 'config.toml');
const cacheDir = path.join(ROOT, 'cache');

function pluginRoot(marketplace, plugin, version) {
  return path.join(cacheDir, marketplace, plugin, version);
}

function seedPlugin({
  marketplace = 'ruflo',
  plugin = 'ruflo-core',
  version,
  manifest = {},
  manifestDir = '.codex-plugin',
  hook,
  skills = [],
}) {
  const root = pluginRoot(marketplace, plugin, version);
  fs.mkdirSync(path.join(root, manifestDir), { recursive: true });
  fs.writeFileSync(path.join(root, manifestDir, 'plugin.json'),
    JSON.stringify({ name: plugin, version, ...manifest }));
  if (hook !== undefined) {
    const hookFile = path.join(root, manifest.hooks ?? 'hooks/hooks.json');
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.writeFileSync(hookFile, JSON.stringify(hook));
  }
  for (const skill of skills) {
    const skillDir = path.join(root, 'skills', skill.directory);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.source);
  }
  return root;
}

function inspect() {
  return inspectCodexPlugins({ configFile, cacheDir });
}

test('enabledPluginRefs reads only explicit enabled plugin tables', () => {
  const refs = enabledPluginRefs(`
[plugins."one@market"]
enabled = true
[plugins."two@market"]
enabled = false
[plugins.'three@market']
enabled = true
[plugins . "four@market"] # spaced header
  enabled = true # trailing comment
[hooks.state."one@market:hooks/hooks.json:stop:0:0"]
trusted_hash = "sha256:x"
`);
  assert.deepEqual(refs, ['one@market', 'three@market', 'four@market']);
});

test('Claude companion placement is detected from exact enabled config identity', () => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.writeFileSync(configFile,
    '[plugins."codex@openai-codex"]\nenabled = true\n');
  let result = inspect();
  assert.equal(result.pluginFindings.length, 1);
  assert.equal(result.pluginFindings[0].code, 'claude-companion-enabled-in-codex');
  assert.equal(result.pluginFindings[0].ref, 'codex@openai-codex');
  assert.match(result.placementIssues[0], /Claude Code/);
  assert.deepEqual(result.plugins[0].placementIssues, result.placementIssues);
  assert.match(result.hookIssues[0], /enabled but no cached version/);
  assert.equal(result.issues.length, 2);
  assert.match(result.configDigest, /^[a-f0-9]{64}$/);

  fs.writeFileSync(configFile, [
    '[plugins."codex@local"]', 'enabled = true',
    '[plugins."another@openai-codex"]', 'enabled = true', '',
  ].join('\n'));
  result = inspect();
  assert.deepEqual(result.pluginFindings, [], 'the placement rule is exact, not heuristic');

  fs.writeFileSync(configFile,
    '[plugins."codex@openai-codex"]\nenabled = false\n');
  result = inspect();
  assert.deepEqual(result.pluginFindings, []);
  assert.deepEqual(result.enabled, []);
});

test('Claude companion placement detection fails closed on multiline TOML strings', () => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.writeFileSync(configFile, `notes = """
[plugins."codex@openai-codex"]
enabled = true
"""
`);
  let result = inspect();
  assert.deepEqual(result.pluginFindings, []);
  assert.deepEqual(result.placementIssues, []);

  fs.writeFileSync(configFile, `notes = """
[plugins."codex@openai-codex"]
enabled = true
"""

  [plugins . "codex@openai-codex"] # live table
  enabled = true # live assignment
`);
  result = inspect();
  assert.equal(result.pluginFindings.length, 1, 'an unrelated multiline value must not hide a live table');
});

test('Codex plugin inspection follows a bounded symlink read-only and marks it non-owned', (t) => {
  const outside = path.join(ROOT, 'outside-config.toml');
  const linked = path.join(ROOT, 'linked-config.toml');
  fs.writeFileSync(outside,
    '[plugins."codex@openai-codex"]\nenabled = true\n');
  try {
    fs.symlinkSync(outside, linked);
  } catch (error) {
    if (error.code === 'EPERM') { t.skip('file symlinks unavailable'); return; }
    throw error;
  }
  const result = inspectCodexPlugins({ configFile: linked, cacheDir });
  assert.equal(result.configStatus, 'valid');
  assert.equal(result.configViaSymlink, true);
  assert.equal(result.pluginFindings.length, 1);
  assert.deepEqual(result.enabled, ['codex@openai-codex']);
});

test('the newest cached generation is the compatibility target', () => {
  fs.writeFileSync(configFile, '[plugins."ruflo-core@ruflo"]\nenabled = true\n');
  seedPlugin({
    version: '0.2.5',
    hook: { _note: 'old incompatible metadata', hooks: { Stop: [] } },
  });
  seedPlugin({
    version: '0.2.6',
    manifestDir: '.claude-plugin',
    hook: { description: 'Codex-compatible', hooks: { Stop: [] } },
  });
  const result = inspect();
  assert.equal(result.plugins[0].version, '0.2.6');
  assert.deepEqual(result.issues, []);
});

test('unsupported hook metadata is reported with no schema guess', () => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.writeFileSync(configFile, '[plugins."ruflo-core@ruflo"]\nenabled = true\n');
  seedPlugin({
    version: '0.2.5',
    hook: { _note: 'Claude-only metadata', hooks: { Stop: [] } },
  });
  assert.match(inspect().issues[0], /unsupported top-level field\(s\): _note/);
});

test('a manifest hook override wins over an incompatible conventional file', () => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.writeFileSync(configFile, '[plugins."brain@local"]\nenabled = true\n');
  const root = seedPlugin({
    marketplace: 'local',
    plugin: 'brain',
    version: '4.0.1',
    manifest: { hooks: './hooks/codex-hooks.json' },
    hook: { description: 'Codex hooks', hooks: { Stop: [] } },
  });
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ _note: 'not the manifest-selected file', hooks: {} }));
  const result = inspect();
  assert.deepEqual(result.issues, []);
  assert.match(result.plugins[0].hookFiles[0], /codex-hooks\.json$/);
});

test('an explicit empty Codex manifest hook object disables conventional hooks', () => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.writeFileSync(configFile, '[plugins."skills-only@local"]\nenabled = true\n');
  const root = seedPlugin({
    marketplace: 'local', plugin: 'skills-only', version: '1.0.0', manifest: { hooks: {} },
  });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: [] } }));
  const result = inspect();
  assert.deepEqual(result.hookIssues, []);
  assert.deepEqual(result.plugins[0].hookFiles, []);
});

test('missing cache and unsafe manifest paths produce actionable facts', () => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.writeFileSync(configFile, '[plugins."missing@market"]\nenabled = true\n');
  assert.match(inspect().issues[0], /enabled but no cached version/);

  fs.writeFileSync(configFile, '[plugins."unsafe@market"]\nenabled = true\n');
  seedPlugin({
    marketplace: 'market',
    plugin: 'unsafe',
    version: '1.0.0',
    manifest: { hooks: '../outside.json' },
  });
  assert.match(inspect().issues[0], /must start with "\.\/"/);
});

test('plugin cache discovery rejects traversal refs and symlinked marketplace escapes', (t) => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.writeFileSync(configFile, '[plugins."p@../../outside-market"]\nenabled = true\n');
  const traversalRoot = path.resolve(cacheDir, '..', '..', 'outside-market', 'p', '1.0.0');
  fs.mkdirSync(path.join(traversalRoot, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(traversalRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
  assert.match(inspect().hookIssues[0], /invalid plugin reference/);

  fs.rmSync(cacheDir, { recursive: true, force: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-plugin-outside-'));
  try {
    seedPlugin({ marketplace: 'linked', plugin: 'p', version: '1.0.0' });
    const seeded = path.join(cacheDir, 'linked');
    fs.cpSync(seeded, outside, { recursive: true });
    fs.rmSync(seeded, { recursive: true, force: true });
    try {
      fs.symlinkSync(outside, seeded, 'dir');
    } catch (error) {
      if (error.code === 'EPERM') { t.skip('directory symlinks unavailable'); return; }
      throw error;
    }
    fs.writeFileSync(configFile, '[plugins."p@linked"]\nenabled = true\n');
    const result = inspect();
    assert.match(result.hookIssues[0], /escapes.*cache/i);
    assert.deepEqual(result.plugins[0].hookFiles, []);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('skills without portable YAML frontmatter are reported', () => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.writeFileSync(configFile, '[plugins."spring-m11n@market"]\nenabled = true\n');
  seedPlugin({
    marketplace: 'market', plugin: 'spring-m11n', version: '1.0.0',
    skills: [
      { directory: 'valid-skill', source: '---\nname: valid-skill\ndescription: Works in both hosts\n---\n\n# Valid\n' },
      { directory: 'missing-frontmatter', source: '# Claude-only skill metadata\n' },
    ],
  });
  const result = inspect();
  assert.equal(result.plugins[0].skillFiles.length, 2);
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.hookIssues, []);
  assert.equal(result.skillIssues.length, 1);
  assert.match(result.issues[0], /missing-frontmatter[\\/]SKILL\.md: missing YAML frontmatter/);
});

test('known Codex runtime-output incompatibilities are version-bounded advisories', () => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.writeFileSync(configFile,
    '[plugins."security-guidance@claude-plugins-official"]\nenabled = true\n');
  seedPlugin({
    marketplace: 'claude-plugins-official', plugin: 'security-guidance', version: '2.0.7',
  });
  assert.match(inspect().issues[0], /top-level "metrics" field that Codex rejects/);

  fs.rmSync(cacheDir, { recursive: true, force: true });
  seedPlugin({
    marketplace: 'claude-plugins-official', plugin: 'security-guidance', version: '2.0.8',
  });
  assert.deepEqual(inspect().issues, [], 'a later release is not presumed broken');
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
