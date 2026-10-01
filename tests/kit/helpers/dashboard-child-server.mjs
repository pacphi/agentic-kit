// Shared harness for tests that need a REAL dashboard-server.mjs HTTP server,
// in a real child process with tests/helpers/spawn-guard.mjs preloaded (Branch
// Proving the in-process /api/status path spawns nothing on a warm
// cache needs the same "every child_process spawn lands in a ledger" technique
// tests/fixtures/status-zero-spawn-child.mjs uses for a bare
// collect() call, applied here to a whole running server instead).
//
// Unlike status-zero-spawn-child.mjs (which drives collect() directly and
// marks its own ledger boundaries from inside the same process), requests here
// arrive at the child over real HTTP from this file's PARENT — so the PARENT
// marks ledger boundaries itself, by appending directly to the same ndjson
// file between requests. AK_SPAWN_LEDGER_FILE just needs to be a path both
// processes can write to; nothing about spawn-guard's append (fs.appendFileSync)
// requires the writer to be the process the preload is loaded into.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..', '..');
// `--import` takes a module URL: a bare Windows path parses as a `d:` scheme.
const SPAWN_GUARD_URL = pathToFileURL(path.resolve(PKG_ROOT, 'tests', 'helpers', 'spawn-guard.mjs')).href;
const CHILD_FIXTURE = path.resolve(PKG_ROOT, 'tests', 'fixtures', 'dashboard-status-child.mjs');

/**
 * Starts the dashboard server for `cwd` in a real child process, with
 * spawn-guard preloaded. Resolves once the child reports it is listening.
 * @param {{ cwd: string, env: Record<string, string|undefined> }} opts
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number, token: string }>}
 */
export function startGuardedDashboard({ cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--import=${SPAWN_GUARD_URL}`, CHILD_FIXTURE, cwd], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errOut = '';
    let settled = false;
    const onData = (chunk) => {
      out += chunk;
      const m = out.match(/READY (\d+) (\S+)\n/);
      if (m && !settled) {
        settled = true;
        child.stdout.off('data', onData);
        resolve({ child, port: Number(m[1]), token: m[2] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => { errOut += c; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`dashboard child exited before READY (code ${code}): ${errOut || out}`));
    });
  });
}

/** Stops the child and waits until it has exited, so the caller can delete its
 *  cwd: Windows refuses to remove a running process's working directory. */
export async function stopGuardedDashboard(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const force = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000);
  await exited;
  clearTimeout(force);
}

/** GET a route off the guarded child, returning the parsed JSON and the raw
 *  body's byte length (UTF-8) — the exact unit the dashboard-cost budget
 *  cares about, not the string's character length. */
export function getJson(port, route, token) {
  return new Promise((resolve, reject) => {
    http.get({
      host: '127.0.0.1', port, path: route, headers: { 'x-dash-token': token },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        try {
          resolve({ status: res.statusCode, bytes: body.length, json: JSON.parse(body.toString('utf8')) });
        } catch {
          reject(new Error(`unparseable ${route} response (status ${res.statusCode}): ${body.toString('utf8').slice(0, 500)}`));
        }
      });
    }).on('error', reject);
  });
}

export function markLedgerBoundary(ledgerFile, label) {
  fs.appendFileSync(ledgerFile, `${JSON.stringify({ cmd: `__CALL_BOUNDARY_${label}__`, at: new Date().toISOString() })}\n`);
}

export function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Splits a ledger at `__CALL_BOUNDARY_<label>__` marker lines, mirroring
 *  status-zero-spawn.test.mjs's own helper of the same name. */
export function sliceByCallBoundary(lines, labels) {
  const slices = {};
  let start = 0;
  for (const label of labels) {
    const marker = `__CALL_BOUNDARY_${label}__`;
    const end = lines.findIndex((l, i) => i >= start && l.cmd === marker);
    if (end < start) throw new Error(`ledger is missing the ${marker} boundary — got ${JSON.stringify(lines.map((l) => l.cmd))}`);
    slices[label] = lines.slice(start, end);
    start = end + 1;
  }
  return slices;
}

/** versions.mjs's driftReport()/selfDrift() TTL cache only persists after a
 *  LIVE npm fetch succeeds (see status-zero-spawn.test.mjs's own comment on
 *  this exact predicate) — it can never go warm in a broken-PATH sandbox, so
 *  every OTHER zero-spawn assertion in this file filters this one, named,
 *  pre-existing exception out rather than weakening what it actually checks. */
export const isVersionDriftLookup = (line) => line.cmd === 'npm' && line.args?.[0] === 'view';
