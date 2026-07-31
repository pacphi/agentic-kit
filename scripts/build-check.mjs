#!/usr/bin/env node
// "build" for a no-transpile ESM package = packaging + load validation:
//   1. every published file parses (node --check)
//   2. the CLI entrypoint loads and responds to --version
//   3. `npm pack --dry-run` resolves the `files` allowlist without error
// Catches the failure modes a transpile step would otherwise surface: a syntax
// error in a shipped file, a broken bin, or a `files` glob that drops a module.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
//
// `git ls-files` failing (not a repo, git absent, GIT_DIR confusion) used to
// resolve to an empty stdout, which the old code silently treated as "zero
// files to check" — this step could report "✓ syntax-check 0 shipped files"
// having parsed nothing, and the build gate would still pass. Now: a failed
// `git ls-files` call THROWS (loud, unrecoverable) rather than degrading to
// an empty list, and `--others --exclude-standard` is added so a newly
// written, not-yet-`git add`ed module is still syntax-checked — a file the
// old tracked-only invocation would silently skip.
const listFiles = (dir) => {
  const out = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', dir], { cwd: root, encoding: 'utf8' });
  if (out.status !== 0) {
    throw new Error(`git ls-files ${dir} failed (exit ${out.status}): ${out.stderr || out.error || 'unknown error'}`);
  }
  const candidates = out.stdout
    .split('\n')
    .filter((f) => /\.(mjs|cjs|js)$/.test(f));
  const missing = candidates.filter((f) => !existsSync(path.join(root, f)));
  if (missing.length) {
    console.log(`  omitted ${missing.length} tracked deletion(s): ${missing.join(', ')}`);
  }
  return candidates.filter((f) => existsSync(path.join(root, f)));
};
const shipped = [...listFiles('bin'), ...listFiles('src')];
// A gate that can pass having checked nothing is worse than no gate — assert
// a non-trivial floor so an empty/near-empty list fails loudly instead of
// silently reading as "all clear".
if (shipped.length < 20) {
  throw new Error(`only ${shipped.length} shipped files found under bin/+src/ — expected 20+; refusing to report a false "all clear"`);
}
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
let forbidden = [];
try {
  const meta = JSON.parse(pack.stdout);
  const packedPaths = meta[0]?.files?.map((f) => f.path) ?? [];
  fileCount = packedPaths.length;
  const bundlesBin = packedPaths.includes('bin/agentic-kit.mjs');
  const forbiddenPatterns = [
    /(?:^|\/)\.(?:agentic-qe|claude-flow|swarm)(?:\/|$)/,
    /(?:^|\/)\.claude(?:\/|$)/,
    /(?:^|\/)\.env(?:\.|$)/,
    /(?:^|\/)[^/]*\.key\.pem$/,
  ];
  forbidden = packedPaths.filter((file) => forbiddenPatterns.some((pattern) => pattern.test(file)));
  packOk = packOk && fileCount > 0 && bundlesBin && forbidden.length === 0;
} catch { packOk = false; }
if (forbidden.length) {
  console.error(`  refused generated/private package artifacts:\n  ${forbidden.join('\n  ')}`);
}
step('npm pack --dry-run resolves files', packOk, `${fileCount} files`);

// Sanity: published version is readable.
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
step('package.json version present', !!pkgVersion, pkgVersion);

if (failures) { console.error(`\nbuild-check: ${failures} failure(s)`); process.exit(1); }
console.log('\nbuild-check: OK');
