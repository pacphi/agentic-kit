import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEJA_VU_BIN,
  DEJA_VU_DOCTOR_SCHEMA_VERSION,
  DEJA_VU_MIN_VERSION,
  DEJA_VU_PACKAGE,
  DEJA_VU_TARGETS,
  buildDejaVuInstallCommand,
  buildDejaVuUninstallCommand,
  parseDejaVuDoctor,
  parseDejaVuInstallHelp,
  requiredDejaVuTargets,
  validateDejaVuIndexPath,
} from '../../src/lib/deja-vu.mjs';

const FIXTURES = new URL('./fixtures/deja-vu/', import.meta.url);
const fixture = (name) => fs.readFileSync(new URL(name, FIXTURES), 'utf8');

test('v0.19 companion identity and Kit-owned host target map are immutable', () => {
  assert.equal(DEJA_VU_PACKAGE, '@vshulcz/deja-vu');
  assert.equal(DEJA_VU_MIN_VERSION, '0.19.0');
  assert.equal(DEJA_VU_BIN, 'deja');
  assert.equal(DEJA_VU_DOCTOR_SCHEMA_VERSION, 2);
  assert.deepEqual(DEJA_VU_TARGETS, {
    claude: { mcp: 'claude-code', auto: 'claude-auto' },
    codex: { mcp: 'codex', auto: 'codex-auto' },
    opencode: { mcp: 'opencode', auto: 'opencode-auto' },
  });
  assert.equal(Object.isFrozen(DEJA_VU_TARGETS), true);
  assert.equal(Object.isFrozen(DEJA_VU_TARGETS.claude), true);
  assert.deepEqual(requiredDejaVuTargets(), [
    'claude-code', 'claude-auto', 'codex', 'codex-auto', 'opencode', 'opencode-auto',
  ]);
});

test('doctor schema v2 becomes bounded, path-free facts and accepts additive fields', () => {
  const raw = JSON.parse(fixture('doctor-v2.json'));
  raw.added_in_v2 = { path: '/private/SENTINEL/additive', error: 'SENTINEL additive' };
  raw.index.future_counter = 42;

  const parsed = parseDejaVuDoctor(raw);
  assert.equal(parsed.state, 'ok');
  assert.equal(parsed.reason, null);
  assert.equal(Object.isFrozen(parsed), true);
  assert.deepEqual(parsed.facts, {
    schemaVersion: 2,
    stores: {
      total: 2,
      states: {
        ok: 1, missing: 0, unreadable: 0, 'parsed-zero': 0, denied: 1,
        'needs-sqlite3': 0, 'needs-zstd': 0, unplugged: 0, unknown: 0,
      },
      partial: 1,
      unchecked: 0,
    },
    index: { state: 'stale', staleStores: 1 },
    mcp: {
      targets: {
        'claude-code': 'wired',
        'claude-auto': 'unknown',
        codex: 'unknown',
        'codex-auto': 'unknown',
        opencode: 'unknown',
        'opencode-auto': 'unknown',
      },
      unknownTargets: 1,
    },
    sqlite3: { state: 'ok' },
    version: { state: 'offline', current: '0.19.0' },
    policy: {
      state: 'unreadable',
      indexedSessions: 10,
      withheld: { search: 0, mcp: 0, auto: 3 },
    },
    sync: { state: 'unreadable', peerCount: 1, peersWithErrors: 1, peersAhead: 1 },
  });
  const serialized = JSON.stringify(parsed);
  assert.doesNotMatch(serialized, /SENTINEL|\/private|\.jsonl|\.claude/);
});

test('doctor parser accepts JSON text but degrades missing, future, malformed, and unsafe shapes', () => {
  assert.equal(parseDejaVuDoctor(fixture('doctor-v2.json')).state, 'ok');

  const cases = [
    [{}, 'schema-missing'],
    [{ schema_version: 999 }, 'schema-unsupported'],
    ['{"schema_version":2,', 'json-malformed'],
    [[], 'envelope-invalid'],
    [{ ...JSON.parse(fixture('doctor-v2.json')), stores: 'SENTINEL raw shape' }, 'shape-invalid'],
  ];
  for (const [input, reason] of cases) {
    const parsed = parseDejaVuDoctor(input);
    assert.equal(parsed.state, 'degraded');
    assert.equal(parsed.reason, reason);
    assert.equal(parsed.facts, null);
    assert.doesNotMatch(JSON.stringify(parsed), /SENTINEL|raw shape/);
  }
});

test('doctor unknown enum values are retained only as controlled unknown facts', () => {
  const raw = JSON.parse(fixture('doctor-v2.json'));
  raw.index.state = 'SENTINEL-new-index-state';
  raw.stores[0].state = 'SENTINEL-new-store-state';
  raw.mcp[0].state = 'SENTINEL-new-mcp-state';

  const parsed = parseDejaVuDoctor(raw);
  assert.equal(parsed.state, 'degraded');
  assert.equal(parsed.reason, 'value-unsupported');
  assert.equal(parsed.facts.index.state, 'unknown');
  assert.equal(parsed.facts.stores.states.unknown, 1);
  assert.equal(parsed.facts.mcp.targets['claude-code'], 'unknown');
  assert.doesNotMatch(JSON.stringify(parsed), /SENTINEL/);
});

test('install help capability parser reads only the target block and fails closed', () => {
  const healthy = parseDejaVuInstallHelp(fixture('install-help-v0.19.0.txt'));
  assert.equal(healthy.supported, true);
  assert.deepEqual(healthy.missingTargets, []);
  assert.deepEqual(healthy.requiredTargets, requiredDejaVuTargets());

  const missing = fixture('install-help-v0.19.0.txt')
    .replace('claude-code, ', '')
    + '\nExample prose outside the target block: claude-code\n';
  const incompatible = parseDejaVuInstallHelp(missing);
  assert.equal(incompatible.supported, false);
  assert.deepEqual(incompatible.missingTargets, ['claude-code']);

  assert.deepEqual(parseDejaVuInstallHelp('claude-code codex opencode'), {
    supported: false,
    requiredTargets: requiredDejaVuTargets(),
    missingTargets: requiredDejaVuTargets(),
  });
});

test('command construction uses one explicit target and suppresses guidance and per-target warmup', () => {
  assert.deepEqual(buildDejaVuInstallCommand('claude', 'mcp'), {
    command: 'deja',
    args: ['install', 'claude-code', '--no-guidance', '--no-index'],
  });
  assert.deepEqual(buildDejaVuInstallCommand('codex', 'auto'), {
    command: 'deja',
    args: ['install', 'codex-auto', '--no-guidance', '--no-index'],
  });
  assert.deepEqual(buildDejaVuUninstallCommand('opencode', 'auto'), {
    command: 'deja', args: ['uninstall', 'opencode-auto'],
  });
  for (const bad of [
    () => buildDejaVuInstallCommand('cursor', 'mcp'),
    () => buildDejaVuInstallCommand('claude', '--all'),
    () => buildDejaVuUninstallCommand('claude', '--auto'),
  ]) assert.throws(bad, /unsupported deja-vu host or mode/);
});

test('derived index validation accepts only canonical index.db below an allowed data root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-deja-path-'));
  const home = path.join(root, 'home');
  const defaultRoot = path.join(home, '.cache', 'deja');
  const source = path.join(home, '.claude', 'projects');
  const config = path.join(home, '.config', 'deja');
  fs.mkdirSync(defaultRoot, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  try {
    const expected = path.join(defaultRoot, 'index.db');
    const canonicalExpected = path.join(fs.realpathSync.native(defaultRoot), 'index.db');
    assert.deepEqual(validateDejaVuIndexPath(expected, { homeDir: home, sourceRoots: [source], configRoots: [config] }), {
      ok: true, path: canonicalExpected,
    });

    const override = path.join(root, 'private-index', 'index.db');
    assert.equal(validateDejaVuIndexPath(override, { homeDir: home }).ok, false);
    const acceptedOverride = validateDejaVuIndexPath(override, {
      homeDir: home, allowedRoots: [path.dirname(override)],
    });
    assert.equal(acceptedOverride.ok, true);
    assert.equal(path.basename(acceptedOverride.path), 'index.db');

    const rejected = [
      home,
      '.',
      path.join(defaultRoot, '..', '..'),
      path.join(source, 'index.db'),
      path.join(config, 'index.db'),
      path.join(defaultRoot, 'not-the-index'),
    ];
    for (const candidate of rejected) {
      const result = validateDejaVuIndexPath(candidate, {
        homeDir: home,
        allowedRoots: [defaultRoot, source, config],
        sourceRoots: [source],
        configRoots: [config],
      });
      assert.equal(result.ok, false, `${candidate} must be rejected`);
      assert.equal('path' in result, false, 'a rejection must not echo the sensitive path');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('derived index validation rejects a symlink escape without returning the raw path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-deja-link-'));
  const home = path.join(root, 'home');
  const defaultRoot = path.join(home, '.cache', 'deja');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(defaultRoot, { recursive: true });
  fs.mkdirSync(outside);
  try {
    const link = path.join(defaultRoot, 'escape');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const candidate = path.join(link, 'index.db');
    const result = validateDejaVuIndexPath(candidate, { homeDir: home });
    assert.equal(result.ok, false);
    assert.equal('path' in result, false);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
