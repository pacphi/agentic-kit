import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { prepareAqeEmbedding } from '../../src/lib/aqe-embedding-lifecycle.mjs';

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${instance.address().port}`;
}
const cfg = endpoint => ({ aqeEmbedding: { mode: 'endpoint', endpoint, provisioning: 'ollama' } });
const probe = async () => ({ status: 'passed', dimension: 384 });

test('real local provisioning transport uses Ollama JSON API and is idempotent', async t => {
  let alias = false;
  const writes = [];
  const endpoint = await server(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'POST') writes.push([req.url, JSON.parse(body)]);
    if (req.url === '/api/copy') alias = true;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/tags' ? { models: alias ? [{ name: 'Xenova/all-MiniLM-L6-v2:latest' }] : [] } : {}));
  });
  assert.equal((await prepareAqeEmbedding(cfg(endpoint), { probe })).ok, true);
  assert.equal((await prepareAqeEmbedding(cfg(endpoint), { probe })).changed, false);
  assert.deepEqual(writes, [
    ['/api/pull', { model: 'all-minilm:22m', stream: false }],
    ['/api/copy', { source: 'all-minilm:22m', destination: 'Xenova/all-MiniLM-L6-v2' }],
  ]);
});

test('provisioning never follows redirects to another service', async t => {
  let visited = false;
  const destination = await server(t, (req, res) => { visited = true; res.end('{}'); });
  const endpoint = await server(t, (req, res) => { res.writeHead(302, { Location: destination }); res.end(); });
  assert.equal((await prepareAqeEmbedding(cfg(endpoint), { probe })).ok, false);
  assert.equal(visited, false);
});

test('oversized, malformed and error responses fail without reflecting raw content', async t => {
  for (const payload of ['secret invalid json', JSON.stringify({ error: 'secret' }), 'x'.repeat(1_000_001)]) {
    const endpoint = await server(t, (req, res) => res.end(payload));
    const result = await prepareAqeEmbedding(cfg(endpoint), { probe });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('HTTP failure never reaches the semantic proof or exposes a response body', async t => {
  const endpoint = await server(t, (req, res) => { res.statusCode = 500; res.end('private-service-detail'); });
  const result = await prepareAqeEmbedding(cfg(endpoint), { probe: async () => assert.fail() });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('private-service-detail'), false);
});
