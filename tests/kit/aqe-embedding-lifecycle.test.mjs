import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareAqeEmbedding } from '../../src/lib/aqe-embedding-lifecycle.mjs';

const local = { aqe: true, aqeEmbedding: { mode: 'endpoint', endpoint: 'http://127.0.0.1:11434', provisioning: 'ollama' } };
const pass = async () => ({ status: 'passed', dimension: 384, fingerprint: '0123456789abcdef' });

test('local setup downloads missing model, creates AQE alias, then proves embeddings', async () => {
  const calls = [];
  const r = await prepareAqeEmbedding(local, { probe: pass, request: async (route, body) => {
    calls.push([route, body]);
    if (route === '/api/tags') return { models: [] };
    return {};
  } });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map(c => c[0]), ['/api/tags', '/api/pull', '/api/tags', '/api/copy']);
  assert.equal(calls[1][1].model, 'all-minilm:22m');
  assert.equal(calls[3][1].destination, 'Xenova/all-MiniLM-L6-v2');
});

test('an alias created during the download is preserved', async () => {
  let downloaded = false;
  const calls = [];
  await prepareAqeEmbedding(local, { probe: pass, request: async route => {
    calls.push(route);
    if (route === '/api/pull') { downloaded = true; return {}; }
    return { models: downloaded ? [{ name: 'Xenova/all-MiniLM-L6-v2:latest' }] : [] };
  } });
  assert.equal(calls.includes('/api/copy'), false);
});

test('repeated setup preserves an existing alias and performs no model writes', async () => {
  const calls = [];
  const r = await prepareAqeEmbedding(local, { probe: pass, request: async route => {
    calls.push(route); return { models: [{ name: 'Xenova/all-MiniLM-L6-v2:latest' }] };
  } });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['/api/tags']);
});

test('missing service gives actionable incomplete setup instead of hash fallback', async () => {
  let probed = false;
  const r = await prepareAqeEmbedding(local, { probe: async () => { probed = true; }, request: async () => { throw Error('secret raw error'); } });
  assert.equal(r.ok, false);
  assert.match(r.detail, /Ollama/);
  assert.equal(r.detail.includes('secret'), false);
  assert.equal(probed, false);
});

// Node's fetch rejects a refused loopback connection with TypeError('fetch failed')
// whose cause carries code ECONNREFUSED (an AggregateError when `localhost` resolves twice).
const refused = () => new TypeError('fetch failed', {
  cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }),
});

test('an installed Ollama that refuses connections is reported as not running, not missing', async () => {
  let probed = false;
  const run = installed => prepareAqeEmbedding(local, {
    probe: async () => { probed = true; }, request: async () => { throw refused(); },
    ollamaInstalled: async () => installed,
  });
  const stopped = await run(true);
  const missing = await run(false);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.status, 'failed');
  assert.match(stopped.detail, /Ollama is installed but not running at http:\/\/127\.0\.0\.1:11434/);
  assert.match(stopped.detail, /ollama serve/);
  assert.doesNotMatch(stopped.detail, /Install Ollama/);
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /Install Ollama/);
  assert.equal(probed, false);
});

test('the Ollama install check runs only after a refused connection', async () => {
  let checked = 0;
  const r = await prepareAqeEmbedding(local, { probe: pass,
    request: async () => { throw new Error('local-service-request-failed'); },
    ollamaInstalled: async () => { checked++; return true; } });
  assert.equal(r.ok, false);
  assert.equal(checked, 0);
  assert.match(r.detail, /Install Ollama/);
});

test('read-only verification names a stopped Ollama when the selected local endpoint is unreachable', async () => {
  const r = await prepareAqeEmbedding(local, { provision: false, request: async () => assert.fail(),
    probe: async () => ({ status: 'failed', reason: 'endpoint-unreachable' }), ollamaInstalled: async () => true });
  assert.equal(r.ok, false);
  assert.match(r.detail, /endpoint-unreachable/);
  assert.match(r.detail, /Ollama is installed but not running/);
  assert.doesNotMatch(r.detail, /Install Ollama/);
});

test('an unreachable external endpoint never gets Ollama-specific guidance', async () => {
  let checked = 0;
  const cfg = { aqeEmbedding: { mode: 'endpoint', endpoint: 'https://embed.example' } };
  const r = await prepareAqeEmbedding(cfg, { request: async () => assert.fail(),
    probe: async () => ({ status: 'failed', reason: 'endpoint-unreachable' }),
    ollamaInstalled: async () => { checked++; return true; } });
  assert.equal(r.ok, false);
  assert.equal(checked, 0);
  assert.doesNotMatch(r.detail, /not running/);
});

test('external backends are never provisioned and failed semantic checks remain failed', async () => {
  const cfg = { aqeEmbedding: { mode: 'endpoint', endpoint: 'https://example.com' } };
  const r = await prepareAqeEmbedding(cfg, { request: async () => { throw Error('must not run'); },
    probe: async () => ({ status: 'failed', reason: 'model-unavailable' }) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /model-unavailable/);
});

test('unmanaged and disabled AQE do not download, probe or enroll', async () => {
  for (const cfg of [{}, { ...local, aqe: false }]) {
    const r = await prepareAqeEmbedding(cfg, { request: async () => assert.fail(), probe: async () => assert.fail() });
    assert.equal(r.status, 'skipped');
  }
});

test('read-only mode never downloads missing models', async () => {
  const calls = [];
  const r = await prepareAqeEmbedding(local, { provision: false, request: async route => { calls.push(route); }, probe: pass });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, []);
});
test('read-only verification can inspect an explicit ambient endpoint without enrolling it', async () => {
  const cfg = {};
  const r = await prepareAqeEmbedding(cfg, { provision: false,
    env: { AQE_EMBEDDER_ENDPOINT: 'http://localhost:11434' }, probe: pass,
    request: async () => assert.fail() });
  assert.equal(r.status, 'ok');
  assert.deepEqual(cfg, {});
});

// agentic-qe#754: a passing probe proves the embedder, not AQE's pattern index
// binding (3.14.4 refuses to open its ANN index without runtime provenance).
test('a passing probe says the embedder is verified, and names what stays separate', async () => {
  const r = await prepareAqeEmbedding(local, { probe: pass, request: async () => ({ models: [{ name: 'Xenova/all-MiniLM-L6-v2:latest' }] }) });
  assert.equal(r.ok, true);
  assert.equal(r.detail, 'embedder verified (384 dimensions); AQE pattern index binding and existing corpus compatibility remain separate');
});

test('setup and sync ask the probe to check the pattern index, and say what it found', async () => {
  const request = async () => ({ models: [{ name: 'Xenova/all-MiniLM-L6-v2:latest' }] });
  const asked = [];
  const probe = (patternIndex) => async (options) => { asked.push(options.verifyPatternIndex); return { ...(await pass(options)), ...(patternIndex ? { patternIndex } : {}) }; };
  const verified = await prepareAqeEmbedding(local, { probe: probe({ status: 'passed' }), request });
  assert.equal(verified.detail, 'embedder verified (384 dimensions); AQE pattern index binding verified; existing corpus compatibility remains separate');
  const lexical = await prepareAqeEmbedding(local, { probe: probe({ status: 'failed', reason: 'lexical-fallback' }), request });
  assert.equal(lexical.detail, 'embedder verified (384 dimensions); AQE pattern index binding unverified (lexical-fallback); existing corpus compatibility remains separate');
  const below = await prepareAqeEmbedding(local, { probe: probe({ status: 'unavailable', reason: 'version-below-fix' }), request });
  assert.match(below.detail, /binding unverified \(version-below-fix\)/);
  assert.deepEqual(asked, [true, true, true]);
});

test('no src/ surface claims AQE pattern search works', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|cjs|js)$/.test(entry.name)
        && /pattern search (is )?working|semantic search (is )?ready/i.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
    }
  };
  walk('src');
  assert.deepEqual(offenders, []);
});
