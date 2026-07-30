import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OPENROUTER_ACTIVITY_URL,
  normalizeOpenRouterActivity,
  readOpenRouterActivity,
  refreshOpenRouterActivity,
} from '../../src/lib/usage-openrouter.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ak-openrouter-usage-'));
const RAW = {
  data: [
    {
      byok_usage_inference: 0.012,
      completion_tokens: 125,
      date: '2026-07-28',
      endpoint_id: 'endpoint-secret-a',
      model: 'openai/gpt-5.6',
      model_permaslug: 'openai/gpt-5.6-20260701',
      prompt_tokens: 50,
      provider_name: 'OpenAI',
      reasoning_tokens: 25,
      requests: 5,
      usage: 0.015,
    },
    {
      byok_usage_inference: 0.003,
      completion_tokens: 75,
      date: '2026-07-28',
      endpoint_id: 'endpoint-secret-b',
      model: 'openai/gpt-5.6',
      model_permaslug: 'openai/gpt-5.6-20260701',
      prompt_tokens: 25,
      provider_name: 'OpenAI',
      reasoning_tokens: 10,
      requests: 2,
      usage: 0.009,
    },
    {
      byok_usage_inference: 0,
      completion_tokens: 30,
      date: '2026-07-29',
      endpoint_id: 'endpoint-secret-c',
      model: 'z-ai/glm-5.2',
      model_permaslug: 'z-ai/glm-5.2',
      prompt_tokens: 20,
      provider_name: 'Z.AI',
      reasoning_tokens: 0,
      requests: 1,
      usage: 0.004,
    },
  ],
};

test('normalization aggregates endpoint rows and discards every correlation identifier', () => {
  const out = normalizeOpenRouterActivity(RAW, { now: Date.parse('2026-07-30T00:00:00Z') });
  assert.equal(out.provider, 'openrouter');
  assert.equal(out.fetchedAt, '2026-07-30T00:00:00.000Z');
  assert.deepEqual(out.coverage, {
    completedUtcDays: 30,
    from: '2026-06-30',
    through: '2026-07-29',
  });
  assert.deepEqual(out.activitySpan, {
    from: '2026-07-28',
    through: '2026-07-29',
  });
  assert.equal(out.rows.length, 2, 'two endpoint rows for one model/day collapse');
  assert.equal(out.rows[0].requests, 7);
  assert.equal(out.rows[0].promptTokens, 75);
  assert.equal(out.rows[0].completionTokens, 200);
  assert.equal(out.totals.requests, 8);
  assert.equal(out.totals.promptTokens, 95);
  assert.equal(out.totals.completionTokens, 230);
  assert.equal(out.byModel.length, 2);
  assert.equal(out.byProvider.length, 2);

  const wire = JSON.stringify(out);
  for (const forbidden of ['endpoint_id', 'endpoint-secret', 'api_key_hash', 'user_id', 'session']) {
    assert.equal(wire.includes(forbidden), false, `${forbidden} must not enter the cache`);
  }
});

test('normalization accepts an honest empty window and rejects any malformed row', () => {
  const empty = normalizeOpenRouterActivity({ data: [] }, { now: 0 });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.totals.requests, 0);
  assert.throws(
    () => normalizeOpenRouterActivity({ data: [{ endpoint_id: 'only-an-id' }] }),
    /invalid date/,
  );
  assert.throws(() => normalizeOpenRouterActivity({
    data: [RAW.data[0], { ...RAW.data[1], provider_name: undefined }],
  }), /row 1 has invalid provider_name/);
  assert.throws(() => normalizeOpenRouterActivity({
    data: [{ ...RAW.data[0], requests: -1 }],
  }), /row 0 has invalid requests/);
  assert.throws(() => normalizeOpenRouterActivity({
    data: [{ ...RAW.data[0], completion_tokens: 1.5 }],
  }), /row 0 has invalid completion_tokens/);
  assert.throws(() => normalizeOpenRouterActivity({}), /data\[\]/);
});

test('refresh uses only the management key, writes a private atomic cache, and never stores the key', async () => {
  const dir = tmp();
  const cacheFile = path.join(dir, 'openrouter-activity.json');
  const key = 'management-secret-must-not-land';
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify(RAW), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const out = await refreshOpenRouterActivity({
    key,
    cacheFile,
    fetchImpl,
    now: Date.parse('2026-07-30T01:00:00Z'),
  });
  assert.equal(request.url, OPENROUTER_ACTIVITY_URL);
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.headers.Authorization, `Bearer ${key}`);
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.equal(out.totals.requests, 8);

  const wire = fs.readFileSync(cacheFile, 'utf8');
  assert.equal(wire.includes(key), false);
  assert.equal(wire.includes('endpoint-secret'), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
  assert.deepEqual(readOpenRouterActivity({ cacheFile }), out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an inference key is never an implicit substitute for a management key', async () => {
  await assert.rejects(
    refreshOpenRouterActivity({
      key: null,
      fetchImpl: async () => { throw new Error('must not fetch'); },
    }),
    /OPENROUTER_MANAGEMENT_KEY is required/,
  );
});

test('HTTP/schema/size failures preserve the last good cache', async () => {
  const dir = tmp();
  const cacheFile = path.join(dir, 'openrouter-activity.json');
  fs.writeFileSync(cacheFile, '{"sentinel":"old"}');

  await assert.rejects(
    refreshOpenRouterActivity({
      key: 'management-key',
      cacheFile,
      fetchImpl: async () => new Response('nope', { status: 403 }),
    }),
    /HTTP 403/,
  );
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), '{"sentinel":"old"}');

  await assert.rejects(
    refreshOpenRouterActivity({
      key: 'management-key',
      cacheFile,
      fetchImpl: async () => new Response(JSON.stringify({
        data: [RAW.data[0], { ...RAW.data[1], reasoning_tokens: null }],
      }), { status: 200 }),
    }),
    /invalid reasoning_tokens/,
  );
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), '{"sentinel":"old"}');

  await assert.rejects(
    refreshOpenRouterActivity({
      key: 'management-key',
      cacheFile,
      maxBytes: 10,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => '100' },
        text: async () => JSON.stringify(RAW),
      }),
    }),
    /exceeds 10 bytes/,
  );
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), '{"sentinel":"old"}');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('offline reads fail closed on corrupt and unknown-schema caches', () => {
  const dir = tmp();
  const cacheFile = path.join(dir, 'openrouter-activity.json');
  assert.equal(readOpenRouterActivity({ cacheFile }), null);
  fs.writeFileSync(cacheFile, '{bad json');
  assert.equal(readOpenRouterActivity({ cacheFile }), null);
  fs.writeFileSync(cacheFile, JSON.stringify({
    schemaVersion: 999,
    provider: 'openrouter',
    fetchedAt: '2026-07-30T00:00:00Z',
    totals: {},
    byModel: [],
    byProvider: [],
    rows: [],
  }));
  assert.equal(readOpenRouterActivity({ cacheFile }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
