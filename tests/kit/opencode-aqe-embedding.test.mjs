import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileOpencodeAqeEmbedding, opencodeConverged, applyOpencode } from '../../src/lib/opencode-core.mjs';

function fixture(t, { owned = true, endpoint, priorEndpoint } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-opencode-embedding-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const configFile = path.join(cwd, 'opencode.json');
  const entry = { type: 'local', command: ['aqe-mcp'], enabled: true, timeout: 30000,
    environment: { AQE_LEARNING_ENABLED: 'true', AQE_WORKERS_ENABLED: 'true', NODE_ENV: 'production',
      ...(endpoint !== undefined ? { AQE_EMBEDDER_ENDPOINT: endpoint } : {}) } };
  const doc = { mcp: { 'agentic-qe': entry, FOREIGN: { anything: true } }, permission: { '*': 'ask' }, skills: { paths: ['untouched'] } };
  const cfg = { aqe: true, aqeEmbedding: { mode: 'endpoint', endpoint: 'http://127.0.0.1:11434' },
    integrations: { hosts: { opencode: true }, ownership: { opencode: { mcp: owned ? 'ak' : null, managed: {
      mcp: owned ? { 'agentic-qe': { prior: priorEndpoint === undefined ? null
        : { ...structuredClone(entry), environment: { ...entry.environment, AQE_EMBEDDER_ENDPOINT: priorEndpoint } }, written: structuredClone(entry) } } : {},
      permissions: { KEEP: { prior: 'ask', written: 'allow' } }, paths: ['untouched'],
    } } } } };
  fs.writeFileSync(configFile, JSON.stringify(doc, null, 2));
  return { cwd, cfg, doc, configFile, read: () => JSON.parse(fs.readFileSync(configFile, 'utf8')) };
}

test('narrow OpenCode endpoint change leaves unrelated configuration and receipts untouched', t => {
  const f = fixture(t);
  const beforeOwnership = structuredClone(f.cfg.integrations.ownership.opencode.managed);
  const result = reconcileOpencodeAqeEmbedding(f.cfg, { configFile: f.configFile });
  assert.equal(result.ok, true); assert.equal(result.changed, true); assert.equal(result.markersChanged, true);
  const after = f.read();
  assert.equal(after.mcp['agentic-qe'].environment.AQE_EMBEDDER_ENDPOINT, f.cfg.aqeEmbedding.endpoint);
  delete after.mcp['agentic-qe'].environment.AQE_EMBEDDER_ENDPOINT;
  assert.deepEqual(after, f.doc);
  assert.deepEqual(f.cfg.integrations.ownership.opencode.managed.permissions, beforeOwnership.permissions);
  assert.deepEqual(f.cfg.integrations.ownership.opencode.managed.paths, beforeOwnership.paths);
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, { configFile: f.configFile }).changed, false);
});

test('dry run is read-only and reports same planned endpoint change', t => {
  const f = fixture(t); const before = fs.readFileSync(f.configFile, 'utf8'); const cfgBefore = structuredClone(f.cfg);
  const result = reconcileOpencodeAqeEmbedding(f.cfg, { configFile: f.configFile, dryRun: true });
  assert.equal(result.ok, true); assert.equal(result.changed, true);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), before); assert.deepEqual(f.cfg, cfgBefore);
  assert.deepEqual(fs.readdirSync(f.cwd), ['opencode.json']);
});

test('equal unowned endpoint remains unowned; absent or conflicting unowned value is refused', t => {
  const f = fixture(t, { owned: false, endpoint: 'http://127.0.0.1:11434' });
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, { configFile: f.configFile }).ok, true);
  assert.deepEqual(f.cfg.integrations.ownership.opencode.managed.mcp, {});
  f.cfg.aqeEmbedding.endpoint = 'http://localhost:11434';
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, { configFile: f.configFile }).ok, false);
  delete f.doc.mcp['agentic-qe'].environment.AQE_EMBEDDER_ENDPOINT;
  fs.writeFileSync(f.configFile, JSON.stringify(f.doc));
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, { configFile: f.configFile }).ok, false);
});

test('unmanaged restores exact prior endpoint; edits and symlinked configs stay protected', t => {
  const f = fixture(t, { endpoint: 'http://127.0.0.1:11434', priorEndpoint: 'http://localhost:1234' });
  f.cfg.aqeEmbedding = { mode: 'unmanaged' };
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, { configFile: f.configFile }).ok, true);
  assert.equal(f.read().mcp['agentic-qe'].environment.AQE_EMBEDDER_ENDPOINT, 'http://localhost:1234');
  f.cfg.aqeEmbedding = { mode: 'in-process' };
  const edited = f.read(); edited.mcp['agentic-qe'].timeout = 123;
  fs.writeFileSync(f.configFile, JSON.stringify(edited));
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, { configFile: f.configFile }).ok, false);
  const link = path.join(f.cwd, 'link.json'); fs.symlinkSync(f.configFile, link);
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, { configFile: link }).ok, false);
});

test('missing registration and JSONC override report pending without fabricating config', t => {
  const f = fixture(t);
  fs.unlinkSync(f.configFile);
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, { configFile: f.configFile }).ok, false);
  assert.equal(fs.existsSync(f.configFile), false);
  fs.writeFileSync(f.configFile, '{}');
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, { configFile: f.configFile }).ok, false);
  fs.writeFileSync(path.join(f.cwd, 'opencode.jsonc'), '{}');
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, { configFile: f.configFile }).ok, false);
});

test('narrow updates stay converged with full OpenCode lifecycle', async t => {
  const f = fixture(t);
  // Establish complete normal lifecycle state before changing only the endpoint.
  fs.writeFileSync(f.configFile, '{}');
  f.cfg.integrations.ownership.opencode = { mcp: null, managed: null };
  const opts = { configFile: f.configFile, brainShim: path.join(f.cwd, 'no-brain') };
  assert.equal((await applyOpencode(f.cfg, opts)).ok, true);
  f.cfg.aqeEmbedding = { mode: 'in-process' };
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, opts).ok, true);
  assert.equal((await opencodeConverged(f.cfg, opts)).converged, true);
  f.cfg.aqeEmbedding = { mode: 'unmanaged' };
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, opts).ok, true);
  assert.equal((await opencodeConverged(f.cfg, opts)).converged, true);
});

test('restored pre-kit endpoint survives broad lifecycle sync', async t => {
  const f = fixture(t, { owned: false, endpoint: 'http://127.0.0.1:11434' });
  const opts = { configFile: f.configFile, brainShim: path.join(f.cwd, 'no-brain') };
  assert.equal((await applyOpencode(f.cfg, opts)).ok, true);
  f.cfg.aqeEmbedding.endpoint = 'http://localhost:11434';
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, opts).ok, true);
  f.cfg.aqeEmbedding = { mode: 'unmanaged' };
  assert.equal(reconcileOpencodeAqeEmbedding(f.cfg, opts).ok, true);
  assert.equal(f.read().mcp['agentic-qe'].environment.AQE_EMBEDDER_ENDPOINT, 'http://127.0.0.1:11434');
  assert.equal((await opencodeConverged(f.cfg, opts)).converged, true);
  assert.equal((await applyOpencode(f.cfg, opts)).ok, true);
  assert.equal(f.read().mcp['agentic-qe'].environment.AQE_EMBEDDER_ENDPOINT, 'http://127.0.0.1:11434');
});
