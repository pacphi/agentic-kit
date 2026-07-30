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
[hooks.state."one@market:hooks/hooks.json:stop:0:0"]
trusted_hash = "sha256:x"
`);
  assert.deepEqual(refs, ['one@market', 'three@market']);
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

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
