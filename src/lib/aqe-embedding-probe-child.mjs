// Internal isolated worker: only synthetic text is sent to the selected embedder.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function classify(error) {
  const message = String(error?.message ?? '');
  if (/dim(ension)? mismatch/i.test(message)) return 'dimension-mismatch';
  if (/semantic smoke failed/.test(message)) return 'semantic-smoke-failed';
  if (/invalid vectors/.test(message)) return 'invalid-vectors';
  if (/invalid identity/.test(message)) return 'runtime-identity-unavailable';
  if (/HTTP (401|403)/.test(message)) return 'authentication-failed';
  if (/model.*(not found|missing)|not found.*model/i.test(message)) return 'model-unavailable';
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENOENT/.test(message)) return 'endpoint-unreachable';
  if (/timeout|timed out/i.test(message)) return 'endpoint-timeout';
  if (/local_files_only|allowRemoteModels|local.*file/i.test(message)) return 'local-model-unavailable';
  if (/optional package|Cannot find package|Cannot find module/.test(message)) return 'backend-unavailable';
  return 'embedding-probe-failed';
}

async function corpusEvidence(cfg, activeSpaceId) {
  if (!cfg.corpusPath) return undefined;
  if (!fs.existsSync(cfg.corpusPath)) return { status: 'unavailable', reason: 'corpus-not-found' };
  let db;
  try {
    const { openDatabase } = await import(pathToFileURL(path.join(cfg.packageRoot, 'dist/shared/safe-db.js')).href);
    db = openDatabase(cfg.corpusPath, { readonly: true, fileMustExist: true, autoRestore: false });
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qe_pattern_embeddings'").get();
    if (!table) return { status: 'unavailable', reason: 'embedding-table-not-found' };
    const hasSpace = db.prepare("PRAGMA table_info('qe_pattern_embeddings')").all().some(c => c.name === 'space_id');
    const rows = db.prepare(`SELECT ${hasSpace ? 'space_id' : 'NULL'} AS spaceId FROM qe_pattern_embeddings`).all().map(row => ({ spaceId: /^[a-f0-9]{64}$/.test(row.spaceId) ? row.spaceId : null }));
    const storedSpaceIds = [...new Set(rows.map(row => row.spaceId).filter(Boolean))].sort();
    const unverifiedVectors = rows.filter(row => !row.spaceId).length;
    const verifiedVectors = activeSpaceId ? rows.filter(row => row.spaceId === activeSpaceId).length : 0;
    const mismatchedVectors = activeSpaceId ? rows.filter(row => row.spaceId && row.spaceId !== activeSpaceId).length : null;
    return { status: !activeSpaceId ? 'unverified' : mismatchedVectors ? 'vector_space_mismatch'
      : unverifiedVectors ? 'unverified' : rows.length ? 'healthy' : 'empty',
    scope: 'sqlite-qe-pattern-embeddings', activeSpaceId, storedSpaceIds,
    verifiedVectors, mismatchedVectors, unverifiedVectors };
  } catch { return { status: 'unavailable', reason: 'corpus-read-failed' }; }
  finally { try { db?.close(); } catch {} }
}

let runtime;
let cfg;
let result;
try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  cfg = JSON.parse(input);
  if (cfg.backend === 'in-process') {
    // Resolve with AQE's ESM parent and import conditions, not require conditions.
    // Transformers publishes distinct CJS/ESM instances with independent env state.
    const parent = pathToFileURL(path.join(cfg.packageRoot, 'dist/learning/real-embeddings.js')).href;
    const transformers = await import(import.meta.resolve('@huggingface/transformers', parent));
    transformers.env.allowRemoteModels = cfg.allowDownload === true;
    if (cfg.modelCacheDir) transformers.env.cacheDir = cfg.modelCacheDir;
  }
  runtime = await import(pathToFileURL(path.join(cfg.packageRoot, 'dist/learning/real-embeddings.js')).href);
  const vectors = await runtime.computeBatchEmbeddings([
    'The cat is sitting on the mat.', 'A kitten rests on a rug.',
    'Database transactions require atomic commit guarantees.',
  ], { endpoint: cfg.backend === 'endpoint' ? cfg.endpoint : undefined,
    endpointToken: cfg.token, modelName: 'Xenova/all-MiniLM-L6-v2', enableCache: false });
  if (!Array.isArray(vectors) || vectors.length !== 3 || vectors.some(v => !Array.isArray(v)
    || v.length !== 384 || v.some(n => !Number.isFinite(n)) || !v.some(n => n !== 0))) throw Error('invalid vectors');
  const cosine = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0)
    / Math.sqrt(a.reduce((s, n) => s + n*n, 0) * b.reduce((s, n) => s + n*n, 0));
  const relatedSimilarity = cosine(vectors[0], vectors[1]);
  const unrelatedSimilarity = cosine(vectors[0], vectors[2]);
  if (relatedSimilarity <= unrelatedSimilarity + 0.05) throw Error('semantic smoke failed');
  const identity = runtime.getActiveEmbeddingSpaceIdentity();
  if (identity?.dimensions !== 384 || !/^[a-f0-9]{16}$/.test(identity.runtimeFingerprint)
    || !/^[a-f0-9]{64}$/.test(identity.spaceId)) throw Error('invalid identity');
  result = { status: 'passed', dimension: 384, fingerprint: identity.runtimeFingerprint,
    spaceId: identity.spaceId, relatedSimilarity, unrelatedSimilarity };
} catch (error) { result = { status: 'failed', reason: classify(error) }; }
finally { try { runtime?.resetInitialization(); } catch {} }
if (cfg?.corpusPath) result.corpus = await corpusEvidence(cfg, result.spaceId ?? null);
process.stdout.write('AK_EMBEDDING_PROBE=' + JSON.stringify(result) + '\n');
