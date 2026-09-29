import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { spawnEnv } from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The Maintenance service statically imports footprint/index.mjs, so blocking
// that module's import would reject a valid injected run. Instrument its real
// constructor instead; the management facade is lazy and must never import.
const guard = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/maintenance/management/service.mjs')) {
    throw new Error('real management facade imported');
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith('/footprint/index.mjs')) return loaded;
  const needle = '  const collect = {';
  const source = String(loaded.source);
  if (source.split(needle).length !== 2) throw new Error('collector constructor guard no longer matches');
  return { ...loaded, source: source.replace(needle,
    "  throw new Error('real footprint collector constructed');\\n" + needle) };
}
`;

const child = `
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register('data:text/javascript,' + encodeURIComponent(process.env.AK_REFRESH_GUARD));
const { run } = await import(pathToFileURL(process.env.AK_MAINTAIN_MODULE).href);
const calls = [];
const refreshStages = {
  maintenance: async () => { calls.push('maintenance'); return { ok: true }; },
  inventory: async () => { calls.push('inventory'); return { ok: true }; },
  local: async () => { calls.push('local'); return { ok: true }; },
};
const service = { async report() { calls.push('report'); return { mode: 'read-only' }; } };
const lines = [];
const originalLog = console.log;
console.log = (...args) => lines.push(args.join(' '));
let code;
try {
  code = await run({ flags: { json: true, refresh: '' }, positionals: ['report'],
    deps: { refreshStages, service } });
} finally {
  console.log = originalLog;
}
assert.equal(code, 0, lines.join('\\n'));
assert.deepEqual(calls, ['maintenance', 'inventory', 'local', 'report']);
const result = JSON.parse(lines.join('\\n'));
assert.equal(result.mode, 'read-only');
assert.equal(result.refresh.ok, true);
assert.deepEqual(result.refresh.stages.map(({ id }) => id), ['maintenance', 'inventory', 'local']);
originalLog('injected refresh used no real constructors');
`;

test('injected maintain refresh constructs no real collector or management facade', (t) => {
  const home = tempDir('ak-maintain-injected-home', t);
  const project = tempDir('ak-maintain-injected-project', t);
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', child], {
    cwd: project,
    env: spawnEnv(home, {
      AK_MAINTAIN_MODULE: path.join(ROOT, 'src/commands/maintain.mjs'),
      AK_REFRESH_GUARD: guard,
    }),
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /injected refresh used no real constructors/);
});
