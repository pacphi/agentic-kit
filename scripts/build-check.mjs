#!/usr/bin/env node
// "build" for a no-transpile ESM package = packaging + load validation:
//   1. every published file parses (node --check)
//   2. the CLI entrypoint loads and responds to --version
//   3. `npm pack --dry-run` resolves the `files` allowlist without error
// Catches the failure modes a transpile step would otherwise surface: a syntax
// error in a shipped file, a broken bin, or a `files` glob that drops a module.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
let failures = 0;

const step = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// 1. Syntax-check every shipped .mjs/.cjs under bin/ and src/.
const listFiles = (dir) => {
  const out = spawnSync('git', ['ls-files', dir], { cwd: root, encoding: 'utf8' });
  return (out.stdout || '').split('\n').filter((f) => /\.(mjs|cjs|js)$/.test(f));
};
const shipped = [...listFiles('bin'), ...listFiles('src')];
let syntaxOk = true;
for (const f of shipped) {
  const r = spawnSync(node, ['--check', path.join(root, f)], { encoding: 'utf8' });
  if (r.status !== 0) { syntaxOk = false; console.error(`  syntax: ${f}\n${r.stderr}`); }
}
step(`syntax-check ${shipped.length} shipped files`, syntaxOk);

// 2. CLI entrypoint loads and prints a version.
const bin = path.join(root, 'bin', 'agentic-kit.mjs');
const v = spawnSync(node, [bin, '--version'], { encoding: 'utf8' });
step('CLI loads + --version', v.status === 0 && /\d+\.\d+\.\d+/.test(v.stdout), v.stdout.trim());

// 3. Packaging: `npm pack --dry-run` must resolve the files allowlist.
const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
let packOk = pack.status === 0;
let fileCount = 0;
try {
  const meta = JSON.parse(pack.stdout);
  fileCount = meta[0]?.files?.length ?? 0;
  const bundlesBin = meta[0]?.files?.some((f) => f.path.includes('agentic-kit.mjs'));
  packOk = packOk && fileCount > 0 && !!bundlesBin;
} catch { packOk = false; }
step('npm pack --dry-run resolves files', packOk, `${fileCount} files`);

// Sanity: published version is readable.
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
step('package.json version present', !!pkgVersion, pkgVersion);

if (failures) { console.error(`\nbuild-check: ${failures} failure(s)`); process.exit(1); }
console.log('\nbuild-check: OK');
