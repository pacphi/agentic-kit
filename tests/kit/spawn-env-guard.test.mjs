// tests/kit/spawn-env-guard.test.mjs
// A spawned child that inherits the developer's XDG_*/LOCALAPPDATA/TMPDIR writes
// that developer's real tool state (six files created ~/.local/state/opencode,
// ~/.cache/opencode and ~/.local/share/opencode this way). Every child env in
// tests/ is built by spawnEnv()/sandboxEnvFor(); a deliberate exception carries
// the marker comment `spawn-env: inherits (<reason>)` on the same line.
// Two checks: no line spreads process.env, and every child_process call names an
// `env` option (a call without one inherits process.env implicitly). The second
// check reads source text: it sees calls to names bound from child_process and
// `require('node:child_process').x(`. A call whose options object is built
// elsewhere shows no `env`, so it needs the marker; a call through a local
// wrapper function is not seen at all. A call nested inside another
// call's arguments, or inside a string (a grandchild script), runs with the
// outer call's environment and is not checked separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnEnv, sandboxEnvFor, INHERITED_STATE_KEYS } from './helpers/home-sandbox.mjs';

const TESTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const HELPER = path.join(TESTS, 'kit', 'helpers', 'home-sandbox.mjs');
const INHERIT = /\.\.\.\s*process\.env\b|env:\s*process\.env\b/;

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fixtures') files(full, out); } else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

test('no test builds a child environment from process.env outside the sandbox helper', () => {
  const offenders = [];
  for (const file of files(TESTS)) {
    if (file === SELF || file === HELPER) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (INHERIT.test(line) && !/spawn-env: inherits \(.+\)/.test(line)) offenders.push(`${path.relative(TESTS, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `use spawnEnv(home, extra) from tests/kit/helpers/home-sandbox.mjs:\n  ${offenders.join('\n  ')}`);
});

const CP_FNS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const MARKER = /spawn-env: inherits \(.+\)/;

/** Replace string, template and comment contents with spaces (offsets and
 *  newlines are kept), so a scan sees code only. */
function codeOnly(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//' || two === '/*') {
      const end = two === '//' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2) + 2;
      const stop = end <= 1 || end === -1 ? src.length : end;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += c + src.slice(i + 1, j).replace(/[^\n]/g, ' ') + c;
      i = j + 1;
    } else { out += c; i += 1; }
  }
  return out;
}

/** Names this file binds from node:child_process, and its namespace aliases. */
function childProcessBindings(src) {
  const names = new Set();
  const namespaces = new Set();
  const from = String.raw`['"](?:node:)?child_process['"]`;
  for (const m of src.matchAll(new RegExp(String.raw`import\s*\{([^{}]*)\}\s*from\s*${from}`, 'g'))) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (CP_FNS.has(orig)) names.add((alias || orig).trim());
    }
  }
  for (const m of src.matchAll(new RegExp(String.raw`import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*${from}`, 'g'))) namespaces.add(m[1]);
  for (const m of src.matchAll(new RegExp(String.raw`\{([^{}]*)\}\s*=\s*(?:await\s+import|require)\(\s*${from}\s*\)`, 'g'))) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s*:\s*/);
      if (CP_FNS.has(orig)) names.add((alias || orig).trim());
    }
  }
  return { names, namespaces };
}

/** First lines of child_process calls in `src` that pass no `env` option. */
export function implicitInheritCalls(src) {
  const { names, namespaces } = childProcessBindings(src);
  const code = codeOnly(src);
  const found = [];
  let coveredUntil = -1;
  const call = /(\w+)\s*\(/g;
  for (let m = call.exec(code); m; m = call.exec(code)) {
    const start = m.index;
    if (start < coveredUntil) continue;
    const before = code.slice(0, start);
    const viaRequire = /require\(\s*'\s*'\s*\)\s*\.\s*$/.test(before) && /child_process/.test(src.slice(Math.max(0, start - 40), start));
    const viaNamespace = [...namespaces].some((ns) => new RegExp(String.raw`\b${ns}\s*\.\s*$`).test(before));
    const direct = names.has(m[1]) && !/[.\w$]\s*$/.test(before.slice(-1)) && !/function\s*$/.test(before);
    if (!(CP_FNS.has(m[1]) && (viaRequire || viaNamespace)) && !direct) continue;
    let depth = 1;
    let i = start + m[0].length;
    while (i < code.length && depth > 0) {
      if ('([{'.includes(code[i])) depth += 1;
      else if (')]}'.includes(code[i])) depth -= 1;
      i += 1;
    }
    coveredUntil = i;
    if (/[{,]\s*env\s*[:,}]/.test(code.slice(start, i))) continue;
    const line = before.split('\n').length;
    if (MARKER.test(src.split('\n')[line - 1])) continue;
    found.push(line);
  }
  return found;
}

test('every child_process call in tests/ passes an env option or carries the marker', () => {
  const offenders = [];
  for (const file of files(TESTS)) {
    if (file === SELF || file === HELPER) continue;
    for (const line of implicitInheritCalls(fs.readFileSync(file, 'utf8'))) offenders.push(`${path.relative(TESTS, file)}:${line}`);
  }
  assert.deepEqual(offenders, [], `pass env: spawnEnv(home) from tests/kit/helpers/home-sandbox.mjs, or mark a deliberate exception:\n  ${offenders.join('\n  ')}`);
});

test('the implicit-inheritance scan sees bare, aliased and required calls and skips strings and nested calls', () => {
  const src = [
    "import { spawnSync, execFileSync as run } from 'node:child_process';",
    "spawnSync('git', ['status']);",
    "run(process.execPath, ['x'], { cwd: '/tmp' });",
    "spawnSync('git', ['log'], { env: spawnEnv(home) });",
    "spawnSync('git', ['log'], { ...opts, env });",
    "spawnSync('ls'); // spawn-env: inherits (probe)",
    "const script = \"spawnSync('inner')\";",
    "spawnSync(process.execPath, ['-e', script, String(spawnSync('x'))], {",
    "  env: spawnEnv(home),",
    '});',
    "require('node:child_process').spawn(process.execPath, ['-e', '']);",
    'obj.spawnSync(1);',
    "async function f() { const { execFileSync: ef } = await import('node:child_process'); ef('x'); }",
    'function exec(x) { return x; }',
    "exec('not child_process');",
  ].join('\n');
  assert.deepEqual(implicitInheritCalls(src), [2, 3, 11, 13]);
});

const tempHome = (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-spawn-env-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};

test('spawnEnv pins every per-user base inside the sandbox, whatever the parent exported', (t) => {
  const home = tempHome(t);
  const env = spawnEnv(home, { EXTRA: '1' });
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP', 'npm_config_cache']) {
    assert.ok(env[key] && env[key].startsWith(home), `${key}=${env[key]} escapes ${home}`);
  }
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME', 'CLAUDE_FLOW_DB_PATH', 'CLAUDE_FLOW_MEMORY_PATH']) {
    assert.equal(env[key], undefined, `${key} must not be inherited`);
  }
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.EXTRA, '1');
  assert.deepEqual(Object.keys(sandboxEnvFor(home)).sort(),
    INHERITED_STATE_KEYS.filter((k) => !['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME', 'CLAUDE_FLOW_DB_PATH', 'CLAUDE_FLOW_MEMORY_PATH'].includes(k)).sort());
});

test('a real child sees the sandboxed state base, not the parent one', (t) => {
  const home = tempHome(t);
  const r = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify([process.env.XDG_STATE_HOME, require("os").tmpdir()]))'],
    { env: spawnEnv(home), encoding: 'utf8' });
  const [state, tmp] = JSON.parse(r.stdout);
  assert.ok(state.startsWith(home));
  assert.ok(tmp.startsWith(home));
});
