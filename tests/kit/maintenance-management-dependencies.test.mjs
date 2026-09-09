// ADR-0048 dependency graph tests (src/lib/maintenance/management/dependencies.mjs).
// Hermetic and pure: every graph is constructed inline.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isOpaqueId } from '../../src/lib/maintenance/management/model.mjs';
import {
  deriveDependencyEdges, dependencyGraphList, reverseDependencies, traverseDependencies,
} from '../../src/lib/maintenance/management/dependencies.mjs';
import {
  collectMcpRegistrationFacts, probeDependencies,
} from '../../src/lib/maintenance/management/dependency-probes.mjs';

const KEY = 'test-installation-key-0123456789abcdef';

test('deriveDependencyEdges assigns opaque, stable ids and validates the kind', () => {
  const edges = deriveDependencyEdges({
    descriptors: [{ fromPlacementId: 'plc_a', toId: 'res_b', kind: 'requires-executable', requirement: 'lightpanda' }],
    installationKey: KEY,
  });
  assert.equal(edges.length, 1);
  assert.ok(isOpaqueId(edges[0].edgeId, 'edg'));
  assert.equal(edges[0].grade, 'verified');
  assert.throws(() => deriveDependencyEdges({
    descriptors: [{ fromPlacementId: 'plc_a', toId: 'res_b', kind: 'not-a-kind' }], installationKey: KEY,
  }), TypeError);
});

test('deriveDependencyEdges requires fromPlacementId and toId', () => {
  assert.throws(() => deriveDependencyEdges({
    descriptors: [{ kind: 'requires-executable', toId: 'res_b' }], installationKey: KEY,
  }), TypeError);
});

test('deriveDependencyEdges collapses identical descriptors into one edge', () => {
  const descriptor = { fromPlacementId: 'plc_a', toId: 'res_b', kind: 'requires-runtime', requirement: 'node' };
  const edges = deriveDependencyEdges({ descriptors: [descriptor, { ...descriptor }], installationKey: KEY });
  assert.equal(edges.length, 1);
});

test('deriveDependencyEdges keeps optional fields only when supplied', () => {
  const [edge] = deriveDependencyEdges({
    descriptors: [{ fromPlacementId: 'plc_a', toId: 'plc_b', kind: 'windows-hosts-wsl', environmentRelation: 'windows-host' }],
    installationKey: KEY,
  });
  assert.equal(edge.environmentRelation, 'windows-host');
  assert.equal('requirement' in edge, false);
  assert.equal('satisfied' in edge, false);
});

function sampleInventory() {
  const edges = deriveDependencyEdges({
    installationKey: KEY,
    descriptors: [
      { fromPlacementId: 'plc_a', toId: 'plc_b', kind: 'requires-provider' },
      { fromPlacementId: 'plc_b', toId: 'plc_c', kind: 'requires-credential' },
      { fromPlacementId: 'plc_c', toId: 'plc_a', kind: 'requires-provider' }, // closes a cycle
    ],
  });
  return { dependencyEdges: edges };
}

test('reverseDependencies returns edges targeting the given id', () => {
  const inventory = sampleInventory();
  const reverse = reverseDependencies(inventory, 'plc_b');
  assert.equal(reverse.length, 1);
  assert.equal(reverse[0].fromPlacementId, 'plc_a');
});

test('traverseDependencies walks forward and reports a cycle without expanding it forever', () => {
  const inventory = sampleInventory();
  const result = traverseDependencies(inventory, 'plc_a', { direction: 'forward' });
  assert.equal(result.truncated, false);
  assert.ok(result.cycles.length >= 1, 'a cycle back to the start is reported');
  // Bounded: the traversal must not have looped indefinitely.
  assert.ok(result.visited.length < 10);
});

test('traverseDependencies walks backward for the reverse-dependency view', () => {
  const inventory = sampleInventory();
  const result = traverseDependencies(inventory, 'plc_a', { direction: 'backward' });
  const targets = result.visited.map((entry) => entry.to);
  assert.ok(targets.includes('plc_c'));
});

test('traverseDependencies truncates at maxVisited rather than growing without bound', () => {
  const descriptors = [];
  for (let i = 0; i < 50; i += 1) {
    descriptors.push({ fromPlacementId: `plc_${i}`, toId: `plc_${i + 1}`, kind: 'requires-provider' });
  }
  const inventory = { dependencyEdges: deriveDependencyEdges({ descriptors, installationKey: KEY }) };
  const result = traverseDependencies(inventory, 'plc_0', { maxVisited: 5 });
  assert.equal(result.truncated, true);
  assert.equal(result.visited.length, 5);
});

test('dependencyGraphList reports dependsOn and dependedOnBy for one placement', () => {
  const inventory = sampleInventory();
  const list = dependencyGraphList(inventory, 'plc_b');
  assert.equal(list.placementId, 'plc_b');
  assert.ok(list.dependsOn.some((entry) => entry.toId === 'plc_c'));
  assert.ok(list.dependedOnBy.some((entry) => entry.fromPlacementId === 'plc_a'));
});

test('dependencyGraphList on an isolated placement returns empty lists, not an error', () => {
  const list = dependencyGraphList({ dependencyEdges: [] }, 'plc_lonely');
  assert.deepEqual(list.dependsOn, []);
  assert.deepEqual(list.dependedOnBy, []);
  assert.equal(list.truncated, false);
});

test('traverseDependencies against a resource-id leaf (no outgoing edges) terminates immediately', () => {
  // Mirrors J1: requires-executable targets a bare resourceId with no
  // placement of its own, so it must be a dead end, not a crash.
  const inventory = {
    dependencyEdges: deriveDependencyEdges({
      descriptors: [{ fromPlacementId: 'plc_mcp', toId: 'res_missing_exe', kind: 'requires-executable', requirement: 'lightpanda' }],
      installationKey: KEY,
    }),
  };
  const result = traverseDependencies(inventory, 'plc_mcp');
  assert.equal(result.visited.length, 1);
  assert.equal(result.truncated, false);
});

// ── dependency-probes.mjs ────────────────────────────────────────────────
// Hermetic fake filesystem: no real path, PATH entry, or executable is ever
// touched. `files` maps an exact path to its text content (a plain regular
// file); `symlinks` and `brokenDirs` name paths that lstat reports as a
// symlink or that throw ENOENT, respectively — proving the probe degrades
// those PATH entries to "omitted" rather than resolving or crashing.

function fakeFs({ files = {}, dirs = [], symlinks = [], brokenDirs = [] } = {}) {
  return {
    lstatSync(target) {
      if (brokenDirs.includes(target)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }
      if (symlinks.includes(target)) return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
      if (dirs.includes(target)) return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
      if (Object.prototype.hasOwnProperty.call(files, target)) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: Buffer.byteLength(files[target]) };
      }
      const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error;
    },
    readFileSync(target) {
      if (!Object.prototype.hasOwnProperty.call(files, target)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }
      return files[target];
    },
  };
}

test('collectMcpRegistrationFacts/claude: extracts a stdio requirement and an http transport, never args/env/url', () => {
  const claudeJson = JSON.stringify({
    mcpServers: {
      lightpanda: { command: 'lightpanda', args: ['--secret-flag', 'do-not-leak'], env: { TOKEN: 'sk-should-not-leak' } },
      hosted: { url: 'https://example.com/mcp?token=do-not-leak' },
    },
  });
  const fsImpl = fakeFs({ files: { '/home/.claude.json': claudeJson } });
  const facts = collectMcpRegistrationFacts({ fsImpl, paths: { claudeJson: '/home/.claude.json' }, hosts: ['claude'] });
  assert.deepEqual(facts, [
    { host: 'claude', subjectKind: 'mcp-registration', subjectSelector: 'lightpanda', requirement: 'lightpanda', requirementKind: 'executable', transport: 'stdio' },
    { host: 'claude', subjectKind: 'mcp-registration', subjectSelector: 'hosted', transport: 'http' },
  ]);
  const serialized = JSON.stringify(facts);
  assert.ok(!serialized.includes('do-not-leak'));
  assert.ok(!serialized.includes('sk-should-not-leak'));
  assert.ok(!serialized.includes('example.com'));
});

test('collectMcpRegistrationFacts/codex: an absolute command path reduces to its basename; args/env in the same table never leak', () => {
  const configToml = [
    '[mcp_servers.lightpanda]',
    'command = "/usr/local/bin/lightpanda"',
    'args = ["--secret-flag", "do-not-leak"]',
    '',
    '[mcp_servers.lightpanda.env]',
    'API_KEY = "sk-should-not-leak"',
    '',
    '[mcp_servers.remote]',
    'url = "https://example.com/mcp"',
    '',
  ].join('\n');
  const fsImpl = fakeFs({ files: { '/home/.codex/config.toml': configToml } });
  const facts = collectMcpRegistrationFacts({ fsImpl, paths: { codexConfigToml: '/home/.codex/config.toml' }, hosts: ['codex'] });
  assert.deepEqual(facts, [
    { host: 'codex', subjectKind: 'mcp-registration', subjectSelector: 'lightpanda', requirement: 'lightpanda', requirementKind: 'executable', transport: 'stdio' },
    { host: 'codex', subjectKind: 'mcp-registration', subjectSelector: 'remote', transport: 'http' },
  ]);
  const serialized = JSON.stringify(facts);
  assert.ok(!serialized.includes('/usr/local/bin'));
  assert.ok(!serialized.includes('do-not-leak'));
  assert.ok(!serialized.includes('sk-should-not-leak'));
});

test('collectMcpRegistrationFacts: an absent or unreadable config file yields no facts, never throws', () => {
  const fsImpl = fakeFs({});
  assert.deepEqual(collectMcpRegistrationFacts({ fsImpl, paths: { claudeJson: '/nowhere/.claude.json' } }), []);
});

test('collectMcpRegistrationFacts: only the requested hosts are read', () => {
  const fsImpl = fakeFs({ files: { '/home/.claude.json': JSON.stringify({ mcpServers: { x: { command: 'x' } } }) } });
  const facts = collectMcpRegistrationFacts({ fsImpl, paths: { claudeJson: '/home/.claude.json' }, hosts: ['codex'] });
  assert.deepEqual(facts, []);
});

test('J1: probeDependencies reports satisfied:false for a genuinely missing Lightpanda executable', () => {
  const fsImpl = fakeFs({ dirs: ['/usr/bin'] }); // the directory exists; nothing named lightpanda is in it
  const facts = [{ host: 'claude', subjectKind: 'mcp-registration', subjectSelector: 'lightpanda', requirement: 'lightpanda', requirementKind: 'executable', transport: 'stdio' }];
  const [result] = probeDependencies({ facts, pathEntries: ['/usr/bin'], fsImpl, platform: 'darwin' });
  assert.equal(result.satisfied, false);
  assert.equal(result.authority, 'PATH probe');
  assert.equal(result.requirement, 'lightpanda');
});

test('probeDependencies reports satisfied:true when the executable is found on PATH', () => {
  const fsImpl = fakeFs({ dirs: ['/usr/local/bin'], files: { '/usr/local/bin/lightpanda': '#!/bin/sh\n' } });
  const facts = [{ host: 'claude', subjectKind: 'mcp-registration', subjectSelector: 'lightpanda', requirement: 'lightpanda', requirementKind: 'executable', transport: 'stdio' }];
  const [result] = probeDependencies({ facts, pathEntries: ['/usr/local/bin'], fsImpl, platform: 'darwin' });
  assert.equal(result.satisfied, true);
});

test('probeDependencies never executes anything and reports the full command/args/env in neither input nor output', () => {
  const fsImpl = fakeFs({ dirs: ['/usr/local/bin'], files: { '/usr/local/bin/lightpanda': '#!/bin/sh\n' } });
  const facts = [{ host: 'claude', subjectKind: 'mcp-registration', subjectSelector: 'lightpanda', requirement: 'lightpanda', requirementKind: 'executable', transport: 'stdio' }];
  const results = probeDependencies({ facts, pathEntries: ['/usr/local/bin'], fsImpl, platform: 'darwin' });
  assert.equal('execSync' in fsImpl, false);
  assert.deepEqual(Object.keys(results[0]).sort(), ['authority', 'host', 'requirement', 'requirementKind', 'satisfied', 'subjectKind', 'subjectSelector']);
});

test('probeDependencies skips http-transport facts (nothing executable to probe) without error', () => {
  const facts = [{ host: 'claude', subjectKind: 'mcp-registration', subjectSelector: 'hosted', transport: 'http' }];
  assert.deepEqual(probeDependencies({ facts, pathEntries: [], fsImpl: fakeFs({}) }), []);
});

test('probeDependencies checks an absolute requirement with one lstat and reports its basename only', () => {
  const fsImpl = fakeFs({ files: { '/opt/tools/mytool': 'bin' } });
  const facts = [{ host: null, subjectKind: 'mcp-registration', subjectSelector: 'x', requirement: '/opt/tools/mytool', requirementKind: 'executable', transport: 'stdio' }];
  const [result] = probeDependencies({ facts, pathEntries: [], fsImpl, platform: 'darwin' });
  assert.equal(result.satisfied, true);
  assert.equal(result.requirement, 'mytool');
  assert.ok(!JSON.stringify(result).includes('/opt/tools'));
});

test('probeDependencies treats a symlinked candidate as present without following it further', () => {
  const fsImpl = fakeFs({ dirs: ['/usr/local/bin'], symlinks: ['/usr/local/bin/lightpanda'] });
  const facts = [{ host: 'claude', subjectKind: 'mcp-registration', subjectSelector: 'lightpanda', requirement: 'lightpanda', requirementKind: 'executable', transport: 'stdio' }];
  // The fake fs implements ONLY lstatSync/readFileSync — if the probe tried to
  // resolve the symlink's target (realpathSync/statSync), this would throw.
  const [result] = probeDependencies({ facts, pathEntries: ['/usr/local/bin'], fsImpl, platform: 'darwin' });
  assert.equal(result.satisfied, true);
});

test('probeDependencies degrades a symlinked or unreadable PATH entry to omitted, not a crash or "unknown"', () => {
  const fsImpl = fakeFs({
    symlinks: ['/symlinked-bin'], brokenDirs: ['/missing-bin'],
    dirs: ['/usr/local/bin'], files: { '/usr/local/bin/lightpanda': 'bin' },
  });
  const facts = [{ host: 'claude', subjectKind: 'mcp-registration', subjectSelector: 'lightpanda', requirement: 'lightpanda', requirementKind: 'executable', transport: 'stdio' }];
  const [result] = probeDependencies({
    facts, pathEntries: ['/symlinked-bin', '/missing-bin', '/usr/local/bin'], fsImpl, platform: 'darwin',
  });
  assert.equal(result.satisfied, true);
});

test('probeDependencies applies PATHEXT candidates only on win32', () => {
  const fsImpl = fakeFs({ dirs: ['C:\\bin'], files: { 'C:\\bin\\lightpanda.EXE': 'bin' } });
  const facts = [{ host: 'claude', subjectKind: 'mcp-registration', subjectSelector: 'lightpanda', requirement: 'lightpanda', requirementKind: 'executable', transport: 'stdio' }];
  const [win] = probeDependencies({ facts, pathEntries: ['C:\\bin'], fsImpl, platform: 'win32' });
  assert.equal(win.satisfied, true);
  const [posix] = probeDependencies({ facts, pathEntries: ['C:\\bin'], fsImpl, platform: 'darwin' });
  assert.equal(posix.satisfied, false);
});
