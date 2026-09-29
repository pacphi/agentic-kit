import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tempDir } from './helpers/temp-dir.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';

const hook = fileURLToPath(new URL('../../scripts/trace-ort.mjs', import.meta.url));

function pkg(root, name, version, { commonjs = false, malformed = false } = {}) {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), malformed ? '{bad' : JSON.stringify({ name, version, main: 'index.js', type: commonjs ? 'commonjs' : 'module' }));
  fs.writeFileSync(path.join(dir, 'index.js'), commonjs ? 'module.exports = 1;\n' : 'export default 1;\n');
  return dir;
}

function run(root, source, log = path.join(root, 'trace.jsonl')) {
  const home = path.join(root, 'home');
  const entry = path.join(root, 'entry.mjs');
  fs.writeFileSync(entry, source);
  const env = spawnEnv(home, { NODE_OPTIONS: `--import=${hook}`, TRACE_ORT_LOG: log });
  const child = spawnSync(process.execPath, [entry], { cwd: root, env, encoding: 'utf8' });
  const records = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { child, records };
}

test('records CJS and ESM resolution once per distinct package root', (t) => {
  const root = tempDir('trace-ort', t);
  const huggingface = pkg(root, '@huggingface/transformers', '4.3.0');
  const ort = pkg(root, 'onnxruntime-node', '1.30.0', { commonjs: true });
  const nested = path.join(root, 'nested');
  const old = pkg(nested, '@huggingface/transformers', '3.8.1');
  const { child, records } = run(root, `import '@huggingface/transformers';
import '@huggingface/transformers';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('onnxruntime-node');
require('onnxruntime-node');
const nestedRequire = createRequire(${JSON.stringify(path.join(nested, 'entry.cjs'))});
nestedRequire('@huggingface/transformers');
`);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(records.filter((r) => r.type === 'start').length, 1);
  assert.deepEqual(records.filter((r) => r.type === 'package').map((r) => [r.name, r.version, r.root]).sort(), [
    ['@huggingface/transformers', '3.8.1', old],
    ['@huggingface/transformers', '4.3.0', huggingface],
    ['onnxruntime-node', '1.30.0', ort],
  ].sort());
  assert.ok(records.every((r) => r.pid === records[0].pid));
});

test('reports unknown version without executing package metadata', (t) => {
  const root = tempDir('trace-ort-version', t);
  pkg(root, '@xenova/transformers', undefined);
  const { child, records } = run(root, "import '@xenova/transformers';\n");
  assert.equal(child.status, 0, child.stderr);
  assert.equal(records.find((r) => r.type === 'package')?.version, 'unknown');
});

test('an unusable or absent log target does not change the command result', (t) => {
  const root = tempDir('trace-ort-failure', t);
  pkg(root, 'onnxruntime-node', '1.30.0', { commonjs: true });
  const source = "import { createRequire } from 'node:module'; createRequire(import.meta.url)('onnxruntime-node');\n";
  const invalid = run(root, source, path.join(root, 'missing', 'trace.jsonl'));
  assert.equal(invalid.child.status, 0, invalid.child.stderr);
  assert.match(invalid.child.stderr, /trace-ort.*log/i);
  const absent = run(root, source, '');
  assert.equal(absent.child.status, 0, absent.child.stderr);
  assert.match(absent.child.stderr, /trace-ort.*log/i);
});

test('NODE_OPTIONS traces inherited child processes with separate start receipts', (t) => {
  const root = tempDir('trace-ort-child', t);
  pkg(root, 'onnxruntime-node', '1.21.0', { commonjs: true });
  const childFile = path.join(root, 'child.cjs');
  fs.writeFileSync(childFile, "require('onnxruntime-node');\n");
  const { child, records } = run(root, `import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, [${JSON.stringify(childFile)}], { encoding: 'utf8' });
if (result.status !== 0) process.exit(result.status || 1);
`);
  assert.equal(child.status, 0, child.stderr);
  const starts = records.filter((r) => r.type === 'start');
  assert.equal(starts.length, 2);
  assert.equal(new Set(starts.map((r) => r.pid)).size, 2);
  assert.equal(records.filter((r) => r.type === 'package').length, 1);
  assert.equal(records.find((r) => r.type === 'package')?.version, '1.21.0');
});
