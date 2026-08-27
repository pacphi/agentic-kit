// Test-only sandbox for the machine-mutating commands (setup/status/sync/
// verify/uninstall). Those commands write into the developer's REAL home
// (~/.claude/CLAUDE.md, ~/.config/agentic-kit/kit.json, ~/.claude.json, shell
// rc files), so every test that exercises them must redirect the home first.
//
// src/lib/paths.mjs snapshots os.homedir() at MODULE SCOPE, so the redirect
// only works if it happens before that module is ever loaded. ESM hoists
// `import` declarations above all module body code — therefore a test file
// using this helper must pull in kit modules with dynamic `await import()`
// ONLY, after calling sandboxHome(). This file itself imports nothing but node
// builtins so that importing it never drags paths.mjs in early.
//
// The env keys mirror the CI smoke job (.github/workflows/ci.yml) and the
// existing spawn-based tests (provider-cli.test.mjs): HOME/XDG_CONFIG_HOME on
// POSIX, USERPROFILE/APPDATA on Windows — configBase() reads APPDATA rather
// than XDG_CONFIG_HOME on win32, so both pairs are required or the sandbox is
// silently bypassed there.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Redirect every home-relative kit path at a throwaway directory.
 * @param {string} prefix mkdtemp prefix, for readable leftovers on failure
 * @returns {string} the sandbox home
 */
export function sandboxHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  const cfg = path.join(home, '.config');
  fs.mkdirSync(cfg, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = cfg;
  process.env.APPDATA = cfg;
  process.env.NO_COLOR = '1';
  // Nothing invokable on PATH: every exec.run() spawn ENOENTs immediately, so
  // these tests never launch a real claude/npm/ruflo/aqe and never depend on
  // one being installed. Deterministic on the dev box and in CI alike.
  process.env.PATH = path.join(home, 'no-such-bin');
  return home;
}

/**
 * Redirect only the platform config base for a single test. paths.mjs reads
 * XDG_CONFIG_HOME on POSIX and APPDATA on Windows, so setting just one leaves
 * the other platform writing to the runner's real user config directory.
 * @param {import('node:test').TestContext} testContext
 * @param {string} prefix
 * @returns {string} the temporary config base
 */
export function sandboxConfigBase(testContext, prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const previous = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
  };
  process.env.XDG_CONFIG_HOME = base;
  process.env.APPDATA = base;
  testContext.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  return base;
}

/** Fail loudly (rather than mutating the developer's machine) if the redirect
 *  above did not take — call once per test file, right after the kit modules
 *  are imported. */
export function assertSandboxed(paths, home) {
  const real = os.homedir();
  if (paths.home !== home || !paths.claudeDir().startsWith(home) || !paths.configDir().startsWith(home)) {
    throw new Error(
      `home sandbox NOT active (paths.home=${paths.home}, want ${home}) — refusing to run against ${real}`,
    );
  }
}

const walk = (dir, base, out) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) { out.set(`${rel}/`, 'dir'); walk(full, base, out); } else if (e.isSymbolicLink()) {
      out.set(rel, `link:${fs.readlinkSync(full)}`);
    } else {
      out.set(rel, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  }
  return out;
};

/** Content-addressed snapshot of a directory tree: path → sha256 (or 'dir'). */
export const snapshot = (dir) => walk(dir, dir, new Map());

/** Assert a tree is byte-for-byte what it was, naming every added/removed/
 *  modified path — the load-bearing assertion behind every `--dry-run` test. */
export function assertUnchanged(before, dir, message) {
  const after = snapshot(dir);
  const diffs = [];
  for (const k of after.keys()) if (!before.has(k)) diffs.push(`+ ${k}`);
  for (const [k, v] of before) {
    if (!after.has(k)) diffs.push(`- ${k}`);
    else if (after.get(k) !== v) diffs.push(`~ ${k}`);
  }
  if (diffs.length) throw new Error(`${message}\n  ${diffs.join('\n  ')}`);
}

/** Run `fn` with console.log/error captured; returns { result, out }. */
export async function captureLog(fn) {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(' '));
  const realLog = console.log; const realErr = console.error;
  console.log = push; console.error = push;
  try {
    return { result: await fn(), out: lines.join('\n') };
  } finally {
    console.log = realLog; console.error = realErr;
  }
}

export const rmrf = (...dirs) => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};

/** A minimal fake npm global root so globalRoot()-driven probes are hermetic. */
let fakeRootSeq = 0;
export function fakeGlobalRoot(home, pkgs = {}) {
  // A fresh tree per call — reusing one directory would let an earlier
  // fixture's packages leak into a later "package is missing" scenario.
  const root = path.join(home, `fake-global-${fakeRootSeq++}`, 'node_modules');
  for (const [name, version] of Object.entries(pkgs)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** kit.json whose version-drift caches are already FRESH, so driftReport /
 *  selfDrift never reach the network (and never rewrite the file). */
export function offlineKitConfig(extra = {}) {
  return {
    ruvnetBrain: false, // its drift probe hits the GitHub releases API
    versionCheck: {
      ttlHours: 24,
      last: Date.now(),
      seen: { ruflo: '9.9.9', 'agentic-qe': '9.9.9' },
      self: { last: Date.now(), best: { version: '0.0.1', tag: 'latest' } },
    },
    ...extra,
  };
}

export function writeKitConfig(home, cfg) {
  const dir = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kit.json'), JSON.stringify(cfg, null, 2) + '\n');
}

/** A throwaway "project" (git repo root) to use as cwd. */
export function sandboxProject(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-proj-`));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return fs.realpathSync(dir);
}
