#!/usr/bin/env node
// scripts/real-state-tripwire.mjs
// Real-state tripwire: fingerprints every folder a test could write on the
// developer's machine and names each path that changed. Four incidents wrote
// real state (statusline version + env pins in the repo's .claude, the
// maintenance state, a heal receipt); this turns the next one into a failure.
// Imports only builtins: src/lib/paths.mjs snapshots os.homedir() at module
// scope and must never be loaded here. Node 22.13+.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_STATE_DIRS = ['.claude', '.swarm', '.agentic-qe', '.claude-flow', '.harness'];

/** Writers a live Claude Code / Ruflo / AQE session runs concurrently with a
 *  developer's test run. Excluded from failure only outside strict mode, and
 *  always printed. Each entry names the source that proves the writer. */
export const CONCURRENT_WRITERS = [
  { kind: 'config', pattern: /^claude-rate-limits\.json(\.[^/]*)?$/, writer: 'Claude Code statusline tee (src/templates/statusline-footer.cjs:52-66)' },
  { kind: 'config', pattern: /^claude-context-windows(\/|$)/, writer: 'Claude Code statusline context ledger (src/templates/statusline-footer.cjs:77-131)' },
  { kind: 'state', pattern: /^statusline-debug\.log$/, writer: 'statusline debug log (src/templates/statusline-footer.cjs:2-15)' },
  { kind: 'repo', pattern: /^\.swarm(\/|$)/, writer: 'Ruflo hooks and daemon of a live session' },
  { kind: 'repo', pattern: /^\.agentic-qe\/(?!llm-config\.json)/, writer: 'AQE hooks of a live session' },
  { kind: 'repo', pattern: /^\.claude-flow\/(?!config\.json$)/, writer: 'Ruflo hooks and statusline caches of a live session' },
];

export function isStrict(env = process.env) {
  return env.CI === 'true' || env.CI === '1' || env.AK_TRIPWIRE_STRICT === '1';
}

/**
 * Every real-state location a test could write, for the given platform.
 * @param {{ env?: Record<string, string|undefined>, platform?: string, homedir?: string, repoRoot: string }} o
 */
export function realStateRoots({ env = process.env, platform = process.platform, homedir = os.homedir(), repoRoot }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const configBases = [env.XDG_CONFIG_HOME, p.join(homedir, '.config'), env.APPDATA, p.join(homedir, 'AppData', 'Roaming')];
  const stateBases = [env.XDG_STATE_HOME, p.join(homedir, '.local', 'state'), env.LOCALAPPDATA, p.join(homedir, 'AppData', 'Local')];
  const primaryConfig = platform === 'win32'
    ? env.APPDATA || p.join(homedir, 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME || p.join(homedir, '.config');
  const roots = [
    ...configBases.filter(Boolean).map((base) => ({ kind: 'config', dir: p.join(base, 'agentic-kit') })),
    ...stateBases.filter(Boolean).map((base) => ({ kind: 'state', dir: p.join(base, 'agentic-kit') })),
    ...REPO_STATE_DIRS.map((name) => ({ kind: 'repo', dir: p.join(repoRoot, name), prefix: name })),
    // ak-managed guidance files in other tools' homes (sync/setup write them).
    { kind: 'user-file', dir: p.join(env.CLAUDE_CONFIG_DIR || p.join(homedir, '.claude'), 'CLAUDE.md') },
    { kind: 'user-file', dir: p.join(env.CODEX_HOME || p.join(homedir, '.codex'), 'AGENTS.md') },
    { kind: 'user-file', dir: p.join(primaryConfig, 'opencode', 'AGENTS.md') },
  ];
  const seen = new Set();
  return roots.filter((root) => {
    const key = platform === 'win32' ? p.normalize(root.dir).toLowerCase() : p.normalize(root.dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((root) => ({ ...root, label: `${root.kind}:${root.dir}` }));
}

const toRel = (...parts) => parts.filter(Boolean).join('/');

function hashFile(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function record(out, root, rel, abs) {
  let st;
  try { st = fs.lstatSync(abs); } catch (error) {
    if (error.code === 'ENOENT') return; // vanished between readdir and lstat
    out.set(abs, { root, rel, type: 'unreadable', code: error.code });
    return;
  }
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = fs.readlinkSync(abs); } catch { /* recorded as empty */ }
    out.set(abs, { root, rel, type: 'link', target });
  } else if (st.isDirectory()) {
    out.set(abs, { root, rel: `${rel}/`, type: 'dir' });
    let names;
    try { names = fs.readdirSync(abs); } catch (error) {
      out.set(abs, { root, rel: `${rel}/`, type: 'unreadable', code: error.code });
      return;
    }
    for (const name of names.sort()) record(out, root, toRel(rel, name), path.join(abs, name));
  } else {
    try { out.set(abs, { root, rel, type: 'file', size: st.size, sha256: hashFile(abs) }); } catch (error) {
      out.set(abs, { root, rel, type: 'unreadable', code: error.code });
    }
  }
}

/** Content-addressed snapshot of every root. Directory mtimes are ignored. */
export function snapshotRoots(roots) {
  const out = new Map();
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) { out.set(`absent:${root.dir}`, { root, rel: '', type: 'absent-root' }); continue; }
    if (root.kind === 'user-file') { record(out, root, path.basename(root.dir), root.dir); continue; }
    // The root itself is an entry, so a run that CREATES ~/.local/state/agentic-kit
    // (even empty) is reported as `+ <root>/`.
    out.set(root.dir, { root, rel: root.prefix ? `${root.prefix}/` : './', type: 'dir' });
    let names;
    try { names = fs.readdirSync(root.dir); } catch (error) {
      out.set(root.dir, { root, rel: root.prefix ? `${root.prefix}/` : './', type: 'unreadable', code: error.code });
      continue;
    }
    for (const name of names.sort()) record(out, root, toRel(root.prefix, name), path.join(root.dir, name));
  }
  return out;
}

const same = (a, b) => a.type === b.type && a.sha256 === b.sha256 && a.target === b.target && a.code === b.code;

function writerFor(entry) {
  return CONCURRENT_WRITERS.find((w) => w.kind === entry.root.kind && w.pattern.test(entry.rel.replace(/\/$/, '')))?.writer;
}

export function compareSnapshots(before, after, { strict = isStrict() } = {}) {
  const changes = [];
  for (const [key, now] of after) {
    const was = before.get(key);
    if (now.type === 'absent-root') continue;
    if (!was) changes.push({ op: '+', path: key, rel: now.rel, kind: now.root.kind, after: now });
    else if (!same(was, now)) changes.push({ op: '~', path: key, rel: now.rel, kind: now.root.kind, before: was, after: now });
  }
  for (const [key, was] of before) {
    if (was.type === 'absent-root' || after.has(key)) continue;
    changes.push({ op: '-', path: key, rel: was.rel, kind: was.root.kind, before: was });
  }
  const failing = [];
  const concurrent = [];
  for (const change of changes) {
    const writer = writerFor(change.after || change.before);
    if (!strict && writer) concurrent.push({ ...change, writer });
    else failing.push(change);
  }
  const byPath = (a, b) => a.path.localeCompare(b.path);
  return { failing: failing.sort(byPath), concurrent: concurrent.sort(byPath) };
}

const size = (e) => (e && e.type === 'file' ? `${e.size} bytes` : e ? e.type : 'absent');

export function formatReport({ failing, concurrent }) {
  const lines = [];
  if (failing.length) {
    lines.push(`real-state tripwire: ${failing.length} path(s) changed during the run`);
    for (const c of failing) lines.push(`  ${c.op} ${c.path} (${size(c.before)} -> ${size(c.after)})`);
    lines.push('A test wrote real user state. If you ran ak, the dashboard or `ak sync` yourself during the run, '
      + 'check whether the listed file holds your data or fixture data, and re-run with nothing else running.');
  }
  if (concurrent.length) {
    lines.push(`real-state tripwire: ${concurrent.length} path(s) changed by concurrent writers (not failing)`);
    for (const c of concurrent) lines.push(`  ${c.op} ${c.path} — ${c.writer}`);
  }
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────
function repoArg(argv) {
  const i = argv.indexOf('--repo');
  return i >= 0 ? path.resolve(argv[i + 1]) : process.cwd();
}

function serialize(map) {
  return JSON.stringify([...map].map(([key, e]) => [key, { ...e, root: e.root.label }]));
}

function deserialize(text, roots) {
  const byLabel = new Map(roots.map((r) => [r.label, r]));
  return new Map(JSON.parse(text).map(([key, e]) => [key, { ...e, root: byLabel.get(e.root) ?? { kind: 'unknown', label: e.root } }]));
}

function main(argv) {
  const [command, file] = argv;
  const roots = realStateRoots({ repoRoot: repoArg(argv) });
  if (command === 'snapshot' && file) {
    fs.writeFileSync(file, serialize(snapshotRoots(roots)));
    return 0;
  }
  if (command === 'compare' && file) {
    const result = compareSnapshots(deserialize(fs.readFileSync(file, 'utf8'), roots), snapshotRoots(roots));
    const report = formatReport(result);
    if (report) console.error(report);
    return result.failing.length ? 3 : 0;
  }
  console.error('usage: real-state-tripwire.mjs snapshot|compare <file> [--repo <dir>]');
  return 2;
}

// Compare real paths (drive-letter case differs on Windows): a missed match would
// make `pnpm test` exit 0 having run nothing.
const isMain = () => {
  if (!process.argv[1]) return false;
  const a = fs.realpathSync.native(path.resolve(process.argv[1]));
  const b = fs.realpathSync.native(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
