import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as pathModule from '../../src/lib/paths.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('xdgBase keeps only absolute XDG values for both path flavors', () => {
  assert.equal(typeof pathModule.xdgBase, 'function');
  for (const [p, absolute] of [[path.posix, '/opt/cfg'], [path.win32, 'C:\\cfg']]) {
    const fallback = p.join(absolute, 'fallback');
    for (const value of [undefined, '', 'rel/cfg', './cfg']) {
      assert.equal(pathModule.xdgBase('XDG_CONFIG_HOME', fallback, { env: { XDG_CONFIG_HOME: value }, p }), fallback);
    }
    assert.equal(pathModule.xdgBase('XDG_CONFIG_HOME', fallback, { env: { XDG_CONFIG_HOME: absolute }, p }), absolute);
  }
});

test('relative XDG values cannot redirect live paths or tool root discovery into cwd', { skip: process.platform === 'win32' }, (t) => {
  const home = tempDir('ak-xdg-relative-home', t);
  const cwd = path.join(home, 'work');
  fs.mkdirSync(cwd);
  const pathsUrl = new URL('../../src/lib/paths.mjs', import.meta.url).href;
  const footprintUrl = new URL('../../src/lib/footprint/index.mjs', import.meta.url).href;
  const script = `import * as paths from ${JSON.stringify(pathsUrl)};
import { knownFileSpecs } from ${JSON.stringify(footprintUrl)};
console.log(JSON.stringify([paths.configDir(), paths.evidenceDir(),
  ...knownFileSpecs().map((row) => row.path), ...paths.toolInternalDirs()]));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env: spawnEnv(home, {
      XDG_CONFIG_HOME: 'rel/cfg', XDG_STATE_HOME: 'rel/state',
      XDG_DATA_HOME: 'rel/data', XDG_CACHE_HOME: 'rel/cache',
    }),
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const paths = JSON.parse(child.stdout);
  assert.ok(paths.length > 10);
  for (const candidate of paths) {
    assert.ok(path.isAbsolute(candidate), candidate);
    assert.ok(candidate.startsWith(`${home}${path.sep}`), candidate);
    assert.doesNotMatch(candidate, /(?:^|[/\\])rel(?:[/\\]|$)/);
  }
  assert.ok(paths.includes(path.join(home, '.local', 'state', 'agentic-kit', 'runtime-debug.log')));
});

test('new source readers use the shared XDG base validator', () => {
  const allowed = new Set(['src/lib/paths.mjs', 'src/templates/statusline-footer.cjs',
    'src/lib/adapters/manifest.mjs']);
  const matches = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(at); continue; }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, at).split(path.sep).join('/');
      if (allowed.has(relative)) continue;
      const source = fs.readFileSync(at, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (/\b(?:process\.)?env\.XDG_[A-Z_]+|env\[['"]XDG_/.test(source)) matches.push(relative);
    }
  };
  visit(path.join(root, 'src'));
  assert.deepEqual(matches, []);
});
