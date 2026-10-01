import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveShim, run } from '../../src/lib/exec.mjs';
import { callMcpTools } from '../../src/lib/mcp-tool-call.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';

const templates = Object.fromEntries(['cmd', 'ps1'].map((ext) => [ext,
  fs.readFileSync(new URL(`../fixtures/npm-windows-shim/ruflo.${ext}`, import.meta.url), 'utf8')]));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-npm-shim-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'node_modules', 'ruflo', 'bin', 'ruflo.js');
  const manifest = path.join(root, 'node_modules', 'ruflo', 'package.json');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '#!/usr/bin/env node\n');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'ruflo', bin: { ruflo: 'bin/ruflo.js' } }));
  for (const ext of ['cmd', 'ps1']) fs.writeFileSync(path.join(root, `ruflo.${ext}`), templates[ext]);
  const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  fs.mkdirSync(path.dirname(powershell), { recursive: true }); fs.writeFileSync(powershell, 'fixture');
  const node = path.join(root, 'node.exe'); fs.writeFileSync(node, 'fixture');
  const env = { PATH: root, PATHEXT: '.EXE;.CMD', SystemRoot: root };
  return { root, entry, manifest, node, powershell, env };
}

test('recognized npm shim maps to its declared public bin with literal argv and adjacent Node', (t) => {
  const f = fixture(t);
  const args = ['mcp', 'start', 'a & b', 'quoted " argument', '$(ignored)', '', '\n'];
  assert.deepEqual(resolveShim('ruflo', args, { windows: true, env: f.env }), {
    command: f.node, args: [f.entry, ...args], resolved: true,
  });
  assert.deepEqual(resolveShim(path.join(f.root, 'ruflo.cmd'), args, { windows: true, env: f.env }), {
    command: f.node, args: [f.entry, ...args], resolved: true,
  });
  assert.equal(resolveShim('ruflo', args, { windows: true, env: f.env, npmBin: false }).command, f.powershell);
  for (const ext of ['cmd', 'ps1']) {
    fs.writeFileSync(path.join(f.root, `ruflo.${ext}`), templates[ext].replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
  }
  assert.equal(resolveShim('ruflo', args, { windows: true, env: f.env }).command, f.node, 'CRLF templates remain recognized');
});

test('PATH-selected installation and case-insensitive Node lookup beat current runtime/global guesses', (t) => {
  const f = fixture(t); const other = fixture(t);
  fs.rmSync(f.node);
  const env = { pAtH: `${f.root}${path.delimiter}${other.root}`, pAtHeXt: '.CMD', sYsTeMrOoT: f.root };
  assert.deepEqual(resolveShim('ruflo', ['mcp', 'start'], { windows: true, env }), {
    command: other.node, args: [f.entry, 'mcp', 'start'], resolved: true,
  });
});

for (const mutation of ['cmd', 'ps1', 'manifest', 'foreign-package', 'undeclared-bin', 'traversal', 'shebang', 'missing-bin', 'missing-node']) {
  test(`${mutation} cannot silently bypass a custom or unverified wrapper`, (t) => {
    const f = fixture(t);
    if (mutation === 'cmd' || mutation === 'ps1') fs.appendFileSync(path.join(f.root, `ruflo.${mutation}`), '\ncustom-behavior\n');
    if (mutation === 'manifest') fs.writeFileSync(f.manifest, 'broken json');
    if (mutation === 'foreign-package') fs.writeFileSync(f.manifest, JSON.stringify({ name: 'other', bin: { ruflo: 'bin/ruflo.js' } }));
    if (mutation === 'undeclared-bin') fs.writeFileSync(f.manifest, JSON.stringify({ name: 'ruflo', bin: { other: 'bin/ruflo.js' } }));
    if (mutation === 'traversal') fs.writeFileSync(f.manifest, JSON.stringify({ name: 'ruflo', bin: { ruflo: '../other.js' } }));
    if (mutation === 'shebang') fs.writeFileSync(f.entry, '#!/usr/bin/env node --require injected\n');
    if (mutation === 'missing-bin') fs.rmSync(f.entry);
    if (mutation === 'missing-node') fs.rmSync(f.node);
    assert.equal(resolveShim('ruflo', [], { windows: true, env: f.env }).command, f.powershell);
  });
}

test('custom wrapper first on PATH and native executable precedence remain authoritative', (t) => {
  const first = fixture(t); const second = fixture(t);
  fs.appendFileSync(path.join(first.root, 'ruflo.ps1'), '\n# user customization\n');
  const env = { ...first.env, PATH: `${first.root}${path.delimiter}${second.root}` };
  assert.equal(resolveShim('ruflo', [], { windows: true, env }).command, first.powershell);
  fs.writeFileSync(path.join(first.root, 'ruflo.exe'), 'native');
  assert.deepEqual(resolveShim('ruflo', ['literal'], { windows: true, env }), {
    command: path.join(first.root, 'ruflo.exe'), args: ['literal'], resolved: true,
  });
});

test('bin symlink escaping its package cannot authorize bypass', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.js'); fs.writeFileSync(outside, '#!/usr/bin/env node\n');
  fs.rmSync(f.entry); fs.symlinkSync(outside, f.entry);
  assert.equal(resolveShim('ruflo', [], { windows: true, env: f.env }).command, f.powershell);
});

test('recognized public entry point answers MCP initialize without stdin EOF', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t);
  fs.rmSync(f.node); fs.symlinkSync(process.execPath, f.node);
  fs.writeFileSync(f.entry, `#!/usr/bin/env node
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line);
  if(r.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:'2024-11-05'}})+'\\n');
});
`);
  const spec = resolveShim('ruflo', ['mcp', 'start'], { windows: true, env: f.env });
  assert.equal(spec.command, f.node);
  const result = await callMcpTools({ ...spec, cwd: f.root, env: spawnEnv(f.root), calls: [], timeoutMs: 1000 });
  assert.equal(result.status, 'ok');
});

test('scoped package aliases and string bin declarations require manifest agreement', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.manifest, JSON.stringify({ name: 'ruflo', bin: './bin/ruflo.js' }));
  assert.equal(resolveShim('ruflo', [], { windows: true, env: f.env }).command, f.node);
  const target = 'node_modules/@scope/tool/bin/cli.js';
  const entry = path.join(f.root, ...target.split('/'));
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '#!/usr/bin/env node\n');
  const manifest = path.join(f.root, 'node_modules', '@scope', 'tool', 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({ name: '@scope/tool', bin: { ruflo: 'bin/cli.js' } }));
  for (const ext of ['cmd', 'ps1']) {
    const oldTarget = ext === 'cmd' ? 'node_modules\\ruflo\\bin\\ruflo.js' : 'node_modules/ruflo/bin/ruflo.js';
    fs.writeFileSync(path.join(f.root, `ruflo.${ext}`), templates[ext].replaceAll(oldTarget, ext === 'cmd' ? target.replaceAll('/', '\\') : target));
  }
  assert.deepEqual(resolveShim('ruflo', [], { windows: true, env: f.env }), {
    command: f.node, args: [entry], resolved: true,
  });
  fs.writeFileSync(manifest, JSON.stringify({ name: '@scope/tool', bin: 'bin/cli.js' }));
  assert.equal(resolveShim('ruflo', [], { windows: true, env: f.env }).command, f.powershell);
});

test('run honors a differently cased PATH override without duplicate environment keys', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t);
  fs.rmSync(f.node); fs.symlinkSync(process.execPath, f.node);
  fs.writeFileSync(f.entry, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({argv:process.argv.slice(2),paths:Object.keys(process.env).filter(k=>k.toUpperCase()==='PATH')}));
`);
  const args = ['mcp', 'quoted " value', 'a & b', ''];
  const result = await run('ruflo', args, { windows: true, env: {
    pAtH: f.root, pAtHeXt: '.CMD', sYsTeMrOoT: f.root,
  } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { argv: args, paths: ['pAtH'] });
});

test('an earlier cmd with no safe sibling does not fall through to another installation', (t) => {
  const first = fixture(t); const second = fixture(t);
  fs.rmSync(path.join(first.root, 'ruflo.ps1'));
  const env = { ...first.env, PATH: `${first.root}${path.delimiter}${second.root}` };
  assert.deepEqual(resolveShim('ruflo', ['mcp'], { windows: true, env }), {
    command: 'ruflo', args: ['mcp'], resolved: false,
  });
});

test('package symlink escaping the selected installation cannot authorize bypass', { skip: process.platform === 'win32' }, (t) => {
  const first = fixture(t); const second = fixture(t);
  const pkg = path.join(first.root, 'node_modules', 'ruflo');
  fs.rmSync(pkg, { recursive: true });
  fs.symlinkSync(path.join(second.root, 'node_modules', 'ruflo'), pkg);
  assert.equal(resolveShim('ruflo', [], { windows: true, env: first.env }).command, first.powershell);
});
