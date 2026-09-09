// ADR-0048 discovery configuration — MNT-DSC-001..008, MNT-DSC-020.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HOST_SOURCE_POLICY,
  AUTOMATIC_SOURCES, addCollectionRoot, addExactProject, addExclusion, exclusionAppliesTo,
  readDiscoveryConfiguration, removeExclusion, removeSource, resolveAutomaticSourceRoots,
  setAutomaticSource, validateRoot,
} from '../../src/lib/maintenance/discovery/configuration.mjs';
import { loadKitConfig, saveKitConfig } from '../../src/lib/config.mjs';
import { isOpaqueId } from '../../src/lib/maintenance/management/model.mjs';

const INSTALLATION_KEY = 'test-installation-key-0123456789abcdef';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-discovery-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryConfigDeps(file) {
  return {
    loadConfig: () => loadKitConfig(file),
    saveConfig: (cfg) => saveKitConfig(cfg, file),
    installationKey: INSTALLATION_KEY,
  };
}

test('MNT-DSC-001: curated automatic sources are enabled without any configuration', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'kit.json');
  const configuration = readDiscoveryConfiguration({ loadConfig: () => loadKitConfig(file) });
  assert.equal(configuration.automaticSources.length, AUTOMATIC_SOURCES.length);
  for (const source of configuration.automaticSources) {
    assert.equal(source.enabled, true, `${source.id} should default enabled`);
  }
  assert.deepEqual(configuration.exactProjects, []);
  assert.deepEqual(configuration.collectionRoots, []);
  assert.deepEqual(configuration.exclusions, []);
});

test('MNT-DSC-002/003: adding an exact project previews before committing, and commit persists it', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'kit.json');
  const projectRoot = path.join(dir, 'my-project');
  fs.mkdirSync(projectRoot);
  const deps = memoryConfigDeps(file);

  const { preview, commit } = addExactProject({ root: projectRoot }, deps);
  assert.deepEqual(preview.before.exactProjects, []);
  assert.equal(preview.after.exactProjects.length, 1);
  // Nothing is saved until commit() runs.
  assert.deepEqual(readDiscoveryConfiguration({ loadConfig: deps.loadConfig }).exactProjects, []);

  commit();
  const after = readDiscoveryConfiguration({ loadConfig: deps.loadConfig });
  assert.equal(after.exactProjects.length, 1);
  assert.equal(after.exactProjects[0].root, projectRoot);
  assert.ok(isOpaqueId(after.exactProjects[0].sourceId, 'src'));
});

test('MNT-DSC-002: a bounded collection root is a distinct source kind from an exact project', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'kit.json');
  const collectionRoot = path.join(dir, 'workspace');
  fs.mkdirSync(collectionRoot);
  const deps = memoryConfigDeps(file);

  const { commit } = addCollectionRoot({ root: collectionRoot, maxDepth: 4 }, deps);
  commit();
  const after = readDiscoveryConfiguration({ loadConfig: deps.loadConfig });
  assert.equal(after.collectionRoots.length, 1);
  assert.equal(after.collectionRoots[0].maxDepth, 4);
  assert.equal(after.collectionRoots[0].includeNetwork, false);
});

test('MNT-DSC-004: automatic sources toggle, and exact/recursive exclusions can be added and removed', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'kit.json');
  const deps = memoryConfigDeps(file);

  assert.throws(() => addExclusion({ path: 'relative/path', recursive: false }, deps), /absolute/);
  const excludedPath = path.join(dir, 'skip-me');
  const { commit: commitToggle } = setAutomaticSource({ sourceId: 'ollama', enabled: false }, deps);
  commitToggle();
  const { commit: commitExclusion } = addExclusion({ path: excludedPath, recursive: true }, deps);
  commitExclusion();

  const after = readDiscoveryConfiguration({ loadConfig: deps.loadConfig });
  assert.equal(after.automaticSources.find((s) => s.id === 'ollama').enabled, false);
  assert.equal(after.exclusions.length, 1);
  const [exclusion] = after.exclusions;
  assert.ok(isOpaqueId(exclusion.exclusionId, 'exc'));

  const { commit: commitRemove } = removeExclusion({ exclusionId: exclusion.exclusionId }, deps);
  commitRemove();
  assert.deepEqual(readDiscoveryConfiguration({ loadConfig: deps.loadConfig }).exclusions, []);
});

test('MNT-DSC-005: a recursive exclusion covers a newly discovered descendant automatically', () => {
  const root = path.resolve('/repos');
  const configuration = { exclusions: [{ path: path.join(root, 'big'), recursive: true }] };
  assert.equal(exclusionAppliesTo(configuration, path.join(root, 'big')), true);
  assert.equal(exclusionAppliesTo(configuration, path.join(path.join(root, 'big'), 'new-child', 'deeper')), true);
  assert.equal(exclusionAppliesTo(configuration, path.join(root, 'other')), false);
  const exact = { exclusions: [{ path: path.join(root, 'big', 'one'), recursive: false }] };
  assert.equal(exclusionAppliesTo(exact, path.join(root, 'big', 'one')), true);
  assert.equal(exclusionAppliesTo(exact, path.join(root, 'big', 'one', 'child')), false);
});

test('MNT-DSC-006: configuration.mjs exposes no import/export surface', async () => {
  const module = await import('../../src/lib/maintenance/discovery/configuration.mjs');
  const exported = Object.keys(module).map((key) => key.toLowerCase());
  assert.ok(!exported.some((key) => key.includes('import') || key.includes('export')));
});

test('MNT-DSC-007: a symlink root is refused; its resolved target must be added separately', (t) => {
  const dir = fixture(t);
  const real = path.join(dir, 'real');
  const link = path.join(dir, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, 'dir');
  const result = validateRoot(link, { fsImpl: fs });
  assert.equal(result.valid, false);
  assert.match(result.reason, /symlink/);
  assert.equal(validateRoot(real, { fsImpl: fs }).valid, true);
});

test('MNT-DSC-020: a traversal-escaping root is refused regardless of any opt-in', (t) => {
  const dir = fixture(t);
  // path.join() would silently collapse `..` before validateRoot ever saw it —
  // exactly the confusion the invariant guards against — so the raw string is
  // built by hand to keep the literal `..` segment intact.
  const escaping = `${dir}${path.sep}..${path.sep}escaped`;
  const result = validateRoot(escaping, { fsImpl: fs, includeNetwork: true });
  assert.equal(result.valid, false);
  assert.match(result.reason, /\.\./);
});

test('MNT-DSC-008: network, removable, cloud-placeholder, and WSL-boundary roots are excluded by default', (t) => {
  const dir = fixture(t);
  const cloudRoot = path.join(dir, 'Dropbox', 'notes');
  fs.mkdirSync(cloudRoot, { recursive: true });
  const excluded = validateRoot(cloudRoot, { fsImpl: fs });
  assert.equal(excluded.valid, false);
  assert.equal(excluded.boundary, 'cloud-placeholder');
  assert.equal(excluded.requiresOptIn, true);

  const optedIn = validateRoot(cloudRoot, { fsImpl: fs, includeNetwork: true });
  assert.equal(optedIn.valid, true);
  assert.equal(optedIn.boundary, 'cloud-placeholder');
});

test('MNT-DSC-008: opting a root in never weakens traversal-escape or symlink rejection', (t) => {
  const dir = fixture(t);
  const cloudRoot = path.join(dir, 'Dropbox', 'notes');
  fs.mkdirSync(cloudRoot, { recursive: true });
  const link = path.join(dir, 'Dropbox', 'link');
  fs.symlinkSync(cloudRoot, link, 'dir');
  const result = validateRoot(link, { fsImpl: fs, includeNetwork: true });
  assert.equal(result.valid, false);
  assert.match(result.reason, /symlink/);
});

test('removeSource clears an exact project and a disabled automatic source alike', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'kit.json');
  const projectRoot = path.join(dir, 'proj');
  fs.mkdirSync(projectRoot);
  const deps = memoryConfigDeps(file);
  const { commit } = addExactProject({ root: projectRoot }, deps);
  commit();
  const [{ sourceId }] = readDiscoveryConfiguration({ loadConfig: deps.loadConfig }).exactProjects;

  const { commit: commitRemoval } = removeSource({ sourceId }, deps);
  commitRemoval();
  assert.deepEqual(readDiscoveryConfiguration({ loadConfig: deps.loadConfig }).exactProjects, []);
});

test('resolveAutomaticSourceRoots resolves an existing filesystem host source with present:true', (t) => {
  const dir = fixture(t);
  const configuration = readDiscoveryConfiguration({ loadConfig: () => loadKitConfig(path.join(dir, 'kit.json')) });
  const claudeRoot = path.join(dir, 'fake-claude-home');
  fs.mkdirSync(claudeRoot);
  const only = { ...configuration, automaticSources: configuration.automaticSources.map((s) => ({ ...s, enabled: s.id === 'claude-user' })) };

  const resolved = resolveAutomaticSourceRoots({
    configuration: only, paths: { claudeDir: () => claudeRoot }, platform: 'darwin', fsImpl: fs, installationKey: INSTALLATION_KEY,
  });
  assert.equal(resolved.length, 1);
  assert.ok(isOpaqueId(resolved[0].sourceId, 'src'), 'an automatic source must mint a real opaque sourceId, never its bare curated id');
  assert.deepEqual(resolved[0], {
    sourceId: resolved[0].sourceId, kind: 'automatic', environmentId: 'local', label: 'Claude user configuration',
    filesystem: true, root: claudeRoot, present: true,
    skipDirs: [...HOST_SOURCE_POLICY['claude-user'].skipDirs], maxDepth: 6,
    instructionFiles: [{ name: 'CLAUDE.md', host: 'claude', present: false }],
  });
});

test('MNT-DSC-003/D9b: every filesystem host source carries a curated skip policy that names transcript, session, and cache trees', () => {
  for (const id of ['claude-user', 'codex-user', 'opencode-user', 'hermes-user']) {
    const policy = HOST_SOURCE_POLICY[id];
    assert.ok(Array.isArray(policy.skipDirs) && policy.skipDirs.length > 0, id);
    assert.ok(Number.isFinite(policy.maxDepth) && policy.maxDepth >= 3, id);
    assert.ok(policy.skipDirs.every((name) => !name.includes('/') && !name.includes('\\')), 'skip entries are names, never paths');
  }
  assert.ok(HOST_SOURCE_POLICY['claude-user'].skipDirs.includes('projects'), 'Claude transcript trees are skipped');
  assert.ok(HOST_SOURCE_POLICY['codex-user'].skipDirs.includes('sessions'), 'Codex session trees are skipped');
  assert.ok(!HOST_SOURCE_POLICY['claude-user'].skipDirs.includes('plugins'), 'plugin caches remain catalog evidence');
});

test('resolveAutomaticSourceRoots requires an installationKey', () => {
  assert.throws(
    () => resolveAutomaticSourceRoots({ configuration: { automaticSources: [] }, paths: {}, platform: 'darwin', fsImpl: fs }),
    /installationKey/,
  );
});

test('resolveAutomaticSourceRoots reports a present instruction file with its digest for claude-user and codex-user', (t) => {
  const dir = fixture(t);
  const configuration = readDiscoveryConfiguration({ loadConfig: () => loadKitConfig(path.join(dir, 'kit.json')) });
  const claudeRoot = path.join(dir, 'fake-claude-home');
  const codexRoot = path.join(dir, 'fake-codex-home');
  fs.mkdirSync(claudeRoot);
  fs.mkdirSync(codexRoot);
  fs.writeFileSync(path.join(claudeRoot, 'CLAUDE.md'), '# global\n');
  const only = {
    ...configuration,
    automaticSources: configuration.automaticSources.map((s) => ({ ...s, enabled: ['claude-user', 'codex-user'].includes(s.id) })),
  };

  const resolved = resolveAutomaticSourceRoots({
    configuration: only, paths: { claudeDir: () => claudeRoot, codexDir: () => codexRoot },
    platform: 'darwin', fsImpl: fs, installationKey: INSTALLATION_KEY,
  });
  const claudeUser = resolved.find((entry) => entry.label === 'Claude user configuration');
  const codexUser = resolved.find((entry) => entry.label === 'Codex user configuration');
  assert.equal(claudeUser.instructionFiles[0].present, true);
  assert.equal(claudeUser.instructionFiles[0].digest, createHash('sha256').update('# global\n').digest('hex'));
  assert.equal(codexUser.instructionFiles[0].name, 'AGENTS.md');
  assert.equal(codexUser.instructionFiles[0].present, false);
  assert.ok(!('digest' in codexUser.instructionFiles[0]));
});

test('resolveAutomaticSourceRoots reports present:false for a root that has never been created', (t) => {
  const dir = fixture(t);
  const configuration = readDiscoveryConfiguration({ loadConfig: () => loadKitConfig(path.join(dir, 'kit.json')) });
  const missingRoot = path.join(dir, 'never-created');
  const only = { ...configuration, automaticSources: configuration.automaticSources.map((s) => ({ ...s, enabled: s.id === 'codex-user' })) };

  const [resolved] = resolveAutomaticSourceRoots({
    configuration: only, paths: { codexDir: () => missingRoot }, platform: 'darwin', fsImpl: fs, installationKey: INSTALLATION_KEY,
  });
  assert.equal(resolved.present, false);
  assert.equal(resolved.root, missingRoot);
});

test('resolveAutomaticSourceRoots reports present:false when the path helper does not exist yet (hermes)', () => {
  const configuration = readDiscoveryConfiguration({ loadConfig: () => loadKitConfig('/nonexistent/kit.json') });
  const only = { ...configuration, automaticSources: configuration.automaticSources.map((s) => ({ ...s, enabled: s.id === 'hermes-user' })) };
  const [resolved] = resolveAutomaticSourceRoots({ configuration: only, paths: {}, platform: 'darwin', fsImpl: fs, installationKey: INSTALLATION_KEY });
  assert.equal(resolved.present, false);
  assert.equal(resolved.root, null);
});

test('resolveAutomaticSourceRoots expands "projects" into configured exact projects and collection roots, not the host-transcript list', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'kit.json');
  const projectRoot = path.join(dir, 'proj');
  const collectionRoot = path.join(dir, 'workspace');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(collectionRoot);
  const deps = memoryConfigDeps(file);
  addExactProject({ root: projectRoot }, deps).commit();
  addCollectionRoot({ root: collectionRoot }, deps).commit();

  const configuration = readDiscoveryConfiguration({ loadConfig: deps.loadConfig });
  const only = { ...configuration, automaticSources: configuration.automaticSources.map((s) => ({ ...s, enabled: s.id === 'projects' })) };
  const resolved = resolveAutomaticSourceRoots({ configuration: only, paths: {}, platform: 'darwin', fsImpl: fs, installationKey: INSTALLATION_KEY });

  assert.equal(resolved.length, 2);
  const kinds = resolved.map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, ['collection-root', 'exact-project']);
  assert.ok(resolved.every((entry) => isOpaqueId(entry.sourceId, 'src')));
});

test('resolveAutomaticSourceRoots marks a non-filesystem automatic source present without a root, using a real opaque sourceId', () => {
  const configuration = readDiscoveryConfiguration({ loadConfig: () => loadKitConfig('/nonexistent/kit.json') });
  const only = { ...configuration, automaticSources: configuration.automaticSources.map((s) => ({ ...s, enabled: s.id === 'ollama' })) };
  const [resolved] = resolveAutomaticSourceRoots({ configuration: only, paths: {}, platform: 'darwin', fsImpl: fs, installationKey: INSTALLATION_KEY });
  assert.ok(isOpaqueId(resolved.sourceId, 'src'));
  assert.deepEqual(resolved, {
    sourceId: resolved.sourceId, kind: 'automatic', root: null, environmentId: 'local', label: 'Ollama', filesystem: false, present: true,
  });
});

test('resolveAutomaticSourceRoots is stable: the same automatic source id always mints the same sourceId', () => {
  const configuration = readDiscoveryConfiguration({ loadConfig: () => loadKitConfig('/nonexistent/kit.json') });
  const only = { ...configuration, automaticSources: configuration.automaticSources.map((s) => ({ ...s, enabled: s.id === 'ollama' })) };
  const first = resolveAutomaticSourceRoots({ configuration: only, paths: {}, platform: 'darwin', fsImpl: fs, installationKey: INSTALLATION_KEY });
  const second = resolveAutomaticSourceRoots({ configuration: only, paths: {}, platform: 'darwin', fsImpl: fs, installationKey: INSTALLATION_KEY });
  assert.equal(first[0].sourceId, second[0].sourceId);
});

test('resolveAutomaticSourceRoots resolves nothing for a disabled automatic source', () => {
  const configuration = readDiscoveryConfiguration({ loadConfig: () => loadKitConfig('/nonexistent/kit.json') });
  const noneEnabled = { ...configuration, automaticSources: configuration.automaticSources.map((s) => ({ ...s, enabled: false })) };
  assert.deepEqual(resolveAutomaticSourceRoots({ configuration: noneEnabled, paths: {}, platform: 'darwin', fsImpl: fs, installationKey: INSTALLATION_KEY }), []);
});
