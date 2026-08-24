// Hook-file integrity proofs for the adapter consent boundary (Adrian's PR
// 131 follow-up). These tests deliberately exercise the real filesystem and
// hook-runner seam, while never allowing the mutated hook to execute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  admitAdapters, hashAdapterContent, hashManifest,
} from '../../src/lib/adapters/admission.mjs';
import { validateAdapterManifest } from '../../src/lib/adapters/manifest.mjs';
import { runAdapterHook } from '../../src/lib/adapters/hook-runner.mjs';

function validHost(id = 'hermes') {
  return {
    id,
    label: 'Hermes',
    install: { bin: 'hermes', externalInstallPolicy: 'detect-never-overwrite' },
    capabilities: {
      canDriveSession: false, canBePrimary: false, canRouteActivities: true,
      commandStatusline: false, transcripts: false, usage: false,
      nativeMcpConfig: false, nativeGuidance: false,
    },
    trust: { approvalPolicy: 'unchanged', changes: [] },
    enabledByDefault: false,
    configProjection: 'ruflo',
    observability: [],
  };
}

function fileManifest(id = 'hermes') {
  return validateAdapterManifest({
    name: id,
    version: '1.0.0',
    contract: 1,
    host: validHost(id),
    detection: { bin: 'hermes' },
    driving: { surfaces: ['cli-subprocess'] },
    lifecycle: {
      detect: { hook: { command: [process.execPath, 'detect-hook.mjs'], files: ['detect-hook.mjs'] } },
    },
    trust: { changes: [] },
  });
}

test('hashAdapterContent combines the validated manifest with sorted per-file digests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-integrity-'));
  try {
    fs.writeFileSync(path.join(dir, 'detect-hook.mjs'), 'process.stdout.write("one");\n');
    const manifest = fileManifest();
    const first = hashAdapterContent(manifest, { baseDir: dir });
    assert.equal(first.manifestHash, hashManifest(manifest));
    assert.deepEqual(first.hookFiles.map((file) => file.path), ['detect-hook.mjs']);

    fs.writeFileSync(path.join(dir, 'detect-hook.mjs'), 'process.stdout.write("two");\n');
    const second = hashAdapterContent(manifest, { baseDir: dir });
    assert.notEqual(second.hash, first.hash);
    assert.notEqual(second.hookFiles[0].sha256, first.hookFiles[0].sha256);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('path-backed hooks without an explicit inventory are refused before consent can admit them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-integrity-'));
  try {
    const raw = structuredClone(fileManifest());
    delete raw.lifecycle.detect.hook.files;
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(path.join(dir, 'detect-hook.mjs'), 'process.stdout.write("one");\n');
    fs.writeFileSync(manifestPath, JSON.stringify(raw));
    const result = await admitAdapters({
      cfg: { hostAdapters: [{ name: 'hermes', source: manifestPath }] },
      readManifest: async () => raw,
      consent: { recordedHashFor: () => 'anything', isTrusted: () => true },
    });
    assert.equal(result[0].admitted, false);
    assert.equal(result[0].reason, 'hook-file-not-declared');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remote sources refuse path-backed hooks instead of pretending npm/URL bytes are immutable', () => {
  const manifest = fileManifest();
  assert.throws(
    () => hashAdapterContent(manifest, { baseDir: null }),
    (error) => error.reason === 'hook-files-unavailable',
  );
});

test('pre-spawn verification fails closed when a declared hook file changes after consent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-integrity-'));
  try {
    const manifest = fileManifest();
    const hookPath = path.join(dir, 'detect-hook.mjs');
    fs.writeFileSync(hookPath, 'process.stdout.write("trusted");\n');
    const integrity = hashAdapterContent(manifest, { baseDir: dir });
    fs.writeFileSync(hookPath, 'process.stdout.write("mutated");\n');

    const result = await runAdapterHook({
      hook: manifest.lifecycle.detect.hook,
      hostId: manifest.host.id,
      verb: 'detect',
      manifest,
      integrity,
      baseDir: dir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.match(result.detail, /hook-content-changed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('admission marks consent stale when only a declared hook file changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-integrity-'));
  try {
    const manifest = fileManifest();
    const manifestPath = path.join(dir, 'manifest.json');
    const hookPath = path.join(dir, 'detect-hook.mjs');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(hookPath, 'process.stdout.write("trusted");\n');
    const trustedHash = hashAdapterContent(manifest, { baseDir: dir }).hash;
    fs.writeFileSync(hookPath, 'process.stdout.write("mutated");\n');

    const result = await admitAdapters({
      cfg: { hostAdapters: [{ name: 'hermes', source: manifestPath }] },
      readManifest: async () => manifest,
      consent: { recordedHashFor: () => trustedHash, isTrusted: (_name, hash) => hash === trustedHash },
    });
    assert.equal(result[0].admitted, false);
    assert.equal(result[0].reason, 'consent-stale');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
