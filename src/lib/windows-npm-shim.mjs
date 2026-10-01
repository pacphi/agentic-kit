// Recognize, never interpret, npm cmd-shim 8's plain `env node` wrapper pair.
// Fingerprints normalize only CRLF and the package entry path. Any flags,
// environment assignments, comments or custom behavior keep the PS fallback.
// Fixtures were emitted by cmd-shim 8.0.0; the ps1 hash matches the native
// Ruflo 3.48.0 CI artifact. No package manager or package code runs here.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const CMD_TEMPLATE = '46268d032014c41f0112ffc0f52a9b297a809c289587e984e5919c65f29dad79';
const PS_TEMPLATE = '11a7c411407320ddc34a9ae9633d6372b1867994ff723693be5be16148dd45a8';

export function windowsEnvValue(env, key) {
  return env[Object.keys(env).sort().find((name) => name.toUpperCase() === key.toUpperCase())];
}

/** Windows treats environment names case-insensitively. Remove a replaced
 * spelling before applying the override, so Node's sorted env selection and
 * the resolver agree about the caller's PATH and runtime. */
export function mergeWindowsEnv(base, overrides) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    for (const old of Object.keys(merged)) if (old.toUpperCase() === key.toUpperCase()) delete merged[old];
    merged[key] = value;
  }
  return merged;
}

function readBounded(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 65536) throw Error('not a bounded shim or manifest');
  return fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
}
const fingerprint = (source, target) => createHash('sha256').update(source.replaceAll(target, '<ENTRY>')).digest('hex');
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.split(path.sep).includes('..') && !path.isAbsolute(relative);
}
function plainNodeShebang(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const data = Buffer.alloc(128);
    const size = fs.readSync(fd, data, 0, data.length, 0);
    return /^#!\/usr\/bin\/env node\r?\n/.test(data.subarray(0, size).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

/** Map ONLY the PATH-selected, unchanged npm wrapper pair to its own manifest's
 * public bin. Never consult a global-root guess or bypass an internal bundle.
 * Return null when ownership, containment, template or runtime is uncertain. */
export function npmShimInvocation(candidate, args, env) {
  try {
    const cmd = readBounded(candidate);
    const ps = readBounded(`${candidate.slice(0, -4)}.ps1`);
    const target = ps.match(/"\$basedir\/(node_modules\/[A-Za-z0-9@_./-]+)"/)?.[1];
    if (!target || target.split('/').some((part) => !part || part === '.' || part === '..')) return null;
    if (fingerprint(ps, target) !== PS_TEMPLATE
      || fingerprint(cmd, target.replaceAll('/', '\\')) !== CMD_TEMPLATE) return null;
    const parts = target.split('/');
    const packageName = parts[1].startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1];
    const base = path.resolve(path.dirname(candidate));
    const packageRoot = path.join(base, 'node_modules', ...packageName.split('/'));
    const pkg = JSON.parse(readBounded(path.join(packageRoot, 'package.json')));
    if (pkg.name !== packageName) return null;
    const name = path.basename(candidate).slice(0, -4);
    const declared = typeof pkg.bin === 'string'
      ? (packageName.split('/').at(-1) === name ? pkg.bin : null) : pkg.bin?.[name];
    if (typeof declared !== 'string' || !declared || path.win32.isAbsolute(declared)
      || path.isAbsolute(declared) || declared.split(/[\\/]/).includes('..')) return null;
    const entry = path.resolve(base, ...parts);
    if (path.resolve(packageRoot, declared) !== entry || !isFile(entry)) return null;
    const realPackage = fs.realpathSync(packageRoot);
    if (!inside(fs.realpathSync(base), realPackage)
      || !inside(realPackage, fs.realpathSync(entry)) || !plainNodeShebang(entry)) return null;
    // npm chooses adjacent node.exe first, then node.exe on the caller's PATH.
    // Do not substitute agentic-kit's current runtime or a different npm tree.
    const adjacent = path.join(base, 'node.exe');
    const node = isFile(adjacent) ? adjacent : (windowsEnvValue(env, 'PATH') || '')
      .split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir, 'node.exe')).find(isFile);
    return node ? { command: node, args: [entry, ...args], resolved: true } : null;
  } catch { return null; }
}
