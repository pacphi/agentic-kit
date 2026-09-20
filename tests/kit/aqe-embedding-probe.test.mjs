import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { probeAqeEmbeddings } from '../../src/lib/aqe-embedding-probe.mjs';

const env = { AQE_EMBEDDER_ENDPOINT: 'http://127.0.0.1:11434', AQE_EMBEDDER_TOKEN: 'private-token' };
function fixture(t, body) {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-embedding-client-'));
  t.after(() => fs.rmSync(packageRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(packageRoot, 'dist/learning'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(packageRoot, 'dist/learning/real-embeddings.js'), body);
  return packageRoot;
}

test('an absent endpoint is unconfigured and never inferred from local services', async () => {
  assert.deepEqual(await probeAqeEmbeddings({ env: {} }), { status: 'not-configured', reason: 'embedding-endpoint-not-configured' });
});

test('rejects credentials, paths and non-HTTP endpoints without echoing their contents', async () => {
  for (const endpoint of ['http://user:private-token@localhost', 'http://localhost/v1', 'http://localhost/?token=private-token', 'file:///private-token']) {
    const result = await probeAqeEmbeddings({ env: { AQE_EMBEDDER_ENDPOINT: endpoint } });
    assert.equal(result.status, 'invalid-config');
    assert.equal(JSON.stringify(result).includes('private-token'), false);
  }
});

test('missing installed endpoint client and unbounded timeouts are explicit', async () => {
  assert.equal((await probeAqeEmbeddings({ env, packageRoot: '/missing-aqe-client' })).status, 'unavailable');
  assert.equal((await probeAqeEmbeddings({ env, timeoutMs: 30_001 })).status, 'invalid-config');
});

const good = `
export async function computeBatchEmbeddings(texts, config) {
  if (texts.length !== 3 || config.enableCache !== false) throw Error('bad config');
  const a = Array(384).fill(0); a[0] = 1;
  const b = Array(384).fill(0); b[0] = 0.8; b[1] = 0.6;
  const c = Array(384).fill(0); c[2] = 1;
  return [a,b,c];
}
export function getActiveEmbeddingSpaceIdentity() {
  return { dimensions:384, runtimeFingerprint:'0123456789abcdef', spaceId:'a'.repeat(64) };
}
export function resetInitialization() {}
`;

test('uses actual initialized identity and isolates memory and environment', async t => {
  const packageRoot = fixture(t, good.replace("if (texts.length", `
    const fs = await import('node:fs');
    if (process.env.AQE_MEMORY_PATH === '/unsafe' || process.env.UNRELATED_SECRET || process.env.NODE_OPTIONS) throw Error('environment leaked');
    fs.writeFileSync(process.env.AQE_MEMORY_PATH, 'isolated');
    fs.writeFileSync(new URL('../../probe-path', import.meta.url), process.cwd());
    if (config.endpointToken !== 'private-token') throw Error('missing token');
    if (texts.length`));
  const result = await probeAqeEmbeddings({ env: {...env, AQE_MEMORY_PATH:'/unsafe', UNRELATED_SECRET:'secret'}, packageRoot });
  assert.equal(result.status, 'passed');
  assert.equal(result.spaceId, 'a'.repeat(64));
  assert.equal(result.fingerprint, '0123456789abcdef');
  assert.equal(result.relatedSimilarity, 0.8);
  assert.equal(fs.existsSync(fs.readFileSync(path.join(packageRoot,'probe-path'),'utf8')), false);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('supports an absolute unix endpoint through AQE runtime', async t => {
  const packageRoot = fixture(t, good);
  assert.equal((await probeAqeEmbeddings({packageRoot, env:{AQE_EMBEDDER_ENDPOINT:'unix:/tmp/embedder.sock'}})).status, 'passed');
});

test('classifies failures without exposing sensitive upstream messages', async t => {
  for (const [message, reason] of [['dim mismatch','dimension-mismatch'], ['HTTP 404 model not found','model-unavailable'], ['HTTP 401','authentication-failed'], ['ECONNREFUSED','endpoint-unreachable']]) {
    const packageRoot = fixture(t, `export async function computeBatchEmbeddings() {throw Error('${message} private-token');} export function resetInitialization() {}`);
    const result = await probeAqeEmbeddings({packageRoot,env});
    assert.equal(result.reason, reason);
    assert.equal(JSON.stringify(result).includes('private-token'), false);
  }
});

test('constant vectors fail the semantic smoke check', async t => {
  const packageRoot = fixture(t, good.replace('return [a,b,c]', 'return [a,a,a]'));
  assert.equal((await probeAqeEmbeddings({packageRoot,env})).reason,'semantic-smoke-failed');
});

test('stalled runtime is terminated by the deadline', async t => {
  const packageRoot = fixture(t, 'export async function computeBatchEmbeddings() { await new Promise(resolve=>setTimeout(resolve,60000)); }');
  assert.equal((await probeAqeEmbeddings({packageRoot,env,timeoutMs:200})).reason,'probe-process-failed-or-timed-out');
});

test('in-process backend disables downloads unless explicitly requested', async t => {
  const packageRoot = fixture(t, good.replace('if (texts.length', `
    const { env } = await import('@huggingface/transformers');
    if (env.allowRemoteModels !== false) throw Error('unexpected download');
    if (config.endpoint !== undefined) throw Error('endpoint override');
    if (texts.length`));
  const transformerDir = path.join(packageRoot, 'node_modules/@huggingface/transformers');
  fs.mkdirSync(transformerDir, {recursive:true});
  fs.writeFileSync(path.join(transformerDir,'package.json'), '{"type":"module","main":"index.js"}');
  fs.writeFileSync(path.join(transformerDir,'index.js'), 'export const env = {allowRemoteModels:true};');
  assert.equal((await probeAqeEmbeddings({packageRoot,env,backend:'in-process'})).status,'passed');
});

function corpusFixture(packageRoot, rows) {
  const shared = path.join(packageRoot,'dist/shared');
  fs.mkdirSync(shared,{recursive:true});
  fs.writeFileSync(path.join(shared,'safe-db.js'), `
    export function openDatabase(file, options) {
      if (!options.readonly || !options.fileMustExist || options.autoRestore) throw Error('unsafe DB options');
      return {prepare(sql) {return {get(){return {name:'qe_pattern_embeddings'};},
        all(){return sql.startsWith('PRAGMA') ? [{name:'space_id'}] : ${JSON.stringify(rows)};}};},close(){}};
    }`);
  const corpusPath = path.join(packageRoot,'corpus.db');
  fs.writeFileSync(corpusPath,'unchanged');
  return corpusPath;
}

test('compares stored provenance against the initialized runtime and preserves corpus', async t => {
  const packageRoot = fixture(t,good);
  const corpusPath = corpusFixture(packageRoot,[{spaceId:'a'.repeat(64)},{spaceId:'b'.repeat(64)},{spaceId:null}]);
  const result = await probeAqeEmbeddings({packageRoot,env,corpusPath});
  assert.equal(result.corpus.status,'vector_space_mismatch');
  assert.equal(result.corpus.verifiedVectors,1);
  assert.equal(result.corpus.mismatchedVectors,1);
  assert.equal(result.corpus.unverifiedVectors,1);
  assert.equal(fs.readFileSync(corpusPath,'utf8'),'unchanged');
});

test('failed runtime leaves compatibility unknown, never infers a mismatch', async t => {
  const packageRoot = fixture(t,'export async function computeBatchEmbeddings(){throw Error("HTTP 404 model not found")}');
  const corpusPath = corpusFixture(packageRoot,[{spaceId:'a'.repeat(64)}]);
  const result = await probeAqeEmbeddings({packageRoot,env,corpusPath});
  assert.equal(result.corpus.status,'unverified');
  assert.equal(result.corpus.mismatchedVectors,null);
  assert.equal(result.corpus.activeSpaceId,null);
});

 test('explicit bootstrap can enable downloads while preserving runtime identity', async t => {
  const packageRoot = fixture(t, good.replace('if (texts.length', `
    const { env } = await import('@huggingface/transformers');
    if (env.allowRemoteModels !== true) throw Error('download opt-in missing');
    if (texts.length`));
  const dir = path.join(packageRoot,'node_modules/@huggingface/transformers');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module","main":"index.js"}');
  fs.writeFileSync(path.join(dir,'index.js'),'export const env = {allowRemoteModels:false};');
  assert.equal((await probeAqeEmbeddings({packageRoot,env:{},backend:'in-process',allowDownload:true})).status,'passed');
});

test('malformed stored space IDs are unverified and never reflected', async t => {
  const packageRoot = fixture(t,good);
  const corpusPath = corpusFixture(packageRoot,[{spaceId:'private-token'}]);
  const result = await probeAqeEmbeddings({packageRoot,env,corpusPath});
  assert.equal(result.corpus.unverifiedVectors,1);
  assert.equal(JSON.stringify(result).includes('private-token'),false);
});
