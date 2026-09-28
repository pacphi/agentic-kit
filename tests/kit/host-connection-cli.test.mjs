// ak host check-connection — the consent-gated CLI twin of the dashboard's
// paid connection check (ADR-0053). Every test here uses a fake reader
// (deps.createReader): no test performs a real inference or a real network
// call. Covers: an unmanaged/unknown host refuses before any probe, a
// non-TTY invocation without --yes refuses and sends nothing, --yes sends
// exactly one confirmed request with the fresh evidence key, --dry-run
// previews and sends nothing even with --yes, --json prints { host,
// connection } alone on stdout while human lines go to stderr, a reader
// that throws (stale evidence) exits 1 with its message, and the printed
// disclosure is byte-for-byte the same sentence the dashboard renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/commands/x/host-connection.mjs';
import { CONNECTION_CHECK_DISCLOSURE } from '../../src/lib/host-connection-disclosure.mjs';
import { renderPage } from '../../src/lib/dashboard/page.mjs';

function baseEntry(host) {
  return {
    host, canCheckConnection: true, connectionUnavailable: null,
    evidenceKey: 'a'.repeat(64), target: { model: 'claude-opus-5-5', provider: null },
  };
}

/** A readiness view with `overrides` merged per host, e.g. { codex: { canCheckConnection: false } }. */
function viewWith(overrides = {}) {
  const hosts = {};
  for (const host of ['claude', 'codex', 'opencode']) hosts[host] = { ...baseEntry(host), ...(overrides[host] ?? {}) };
  return { checkedAt: '2026-09-28T00:00:00Z', hosts };
}

/** A fake createHostReadinessReader()-shaped function: `read({force})` always
 * resolves `view`; `checkConnection(args)` records every call in `calls` and
 * defers to `checkConnectionImpl` (default: never called — most tests assert
 * it is never reached). `.close()` records that it ran. */
function fakeReader({ view, calls = [], checkConnectionImpl } = {}) {
  const read = async () => view;
  read.checkConnection = async (args) => {
    calls.push(args);
    if (!checkConnectionImpl) throw new Error('checkConnection must not be called');
    return checkConnectionImpl(args);
  };
  read.closed = false;
  read.close = () => { read.closed = true; };
  return read;
}

function passingCheck(host, overrides = {}) {
  return async () => ({ hosts: { [host]: { connection: { state: 'pass', reason: 'Provider responded', model: 'claude-opus-5-5', ...overrides } } } });
}

function capture() {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return { text: () => lines.join('\n'), restore: () => { console.log = orig; } };
}

/** Real stdout/stderr split, so a --json test can prove human lines never
 * reach stdout — the same mechanism humanOutputToStderr itself patches. */
function captureStreams() {
  const out = [], err = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  return {
    out: () => out.join(''), err: () => err.join(''),
    restore: () => { process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite; },
  };
}

test('an unmanaged host refuses before any probe and never prints the disclosure', async () => {
  const calls = [];
  const view = viewWith({ codex: { canCheckConnection: false, connectionUnavailable: 'Connection checks run only for hosts managed by ak.' } });
  const reader = fakeReader({ view, calls });
  const cap = capture();
  let code;
  try { code = await run({ flags: {}, positionals: ['codex'], deps: { createReader: () => reader } }); }
  finally { cap.restore(); }
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.match(cap.text(), /Connection checks run only for hosts managed by ak\./);
  assert.doesNotMatch(cap.text(), new RegExp(CONNECTION_CHECK_DISCLOSURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(reader.closed, true, 'the reader is always closed');
});

test('unavailable local checks (a null view) refuse with their own message, not "unknown host"', async () => {
  const calls = [];
  const reader = fakeReader({ view: null, calls });
  const cap = capture();
  let code;
  try { code = await run({ flags: {}, positionals: ['codex'], deps: { createReader: () => reader } }); }
  finally { cap.restore(); }
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.match(cap.text(), /local host checks are unavailable/);
});

test('an unrecognized host name refuses before any probe', async () => {
  const calls = [];
  const reader = fakeReader({ view: viewWith(), calls });
  const cap = capture();
  let code;
  try { code = await run({ flags: {}, positionals: ['bogus'], deps: { createReader: () => reader } }); }
  finally { cap.restore(); }
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.match(cap.text(), /unknown host: bogus/);
});

test('a non-TTY invocation without --yes refuses, sends nothing, and still shows the disclosure', async () => {
  const originalTTY = process.stdin.isTTY;
  process.stdin.isTTY = false;
  const calls = [];
  const reader = fakeReader({ view: viewWith(), calls });
  const cap = capture();
  let code;
  try { code = await run({ flags: {}, positionals: ['codex'], deps: { createReader: () => reader } }); }
  finally { cap.restore(); process.stdin.isTTY = originalTTY; }
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.match(cap.text(), /the connection check sends a paid request; re-run with --yes to confirm/);
  assert.ok(cap.text().includes(CONNECTION_CHECK_DISCLOSURE), 'the printed disclosure is the exact shared sentence');
});

test('--yes sends exactly one confirmed request with the view\'s fresh evidence key', async () => {
  const calls = [];
  const reader = fakeReader({ view: viewWith(), calls, checkConnectionImpl: passingCheck('codex') });
  const cap = capture();
  let code;
  try { code = await run({ flags: { yes: true }, positionals: ['codex'], deps: { createReader: () => reader } }); }
  finally { cap.restore(); }
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { host: 'codex', confirm: true, evidenceKey: 'a'.repeat(64) });
  assert.match(cap.text(), /state: pass/);
});

test('--dry-run --yes previews the target and disclosure and sends nothing', async () => {
  const calls = [];
  const reader = fakeReader({ view: viewWith(), calls, checkConnectionImpl: passingCheck('codex') });
  const cap = capture();
  let code;
  try { code = await run({ flags: { yes: true, 'dry-run': true }, positionals: ['codex'], deps: { createReader: () => reader } }); }
  finally { cap.restore(); }
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.match(cap.text(), /dry run — no request sent/);
  assert.ok(cap.text().includes(CONNECTION_CHECK_DISCLOSURE));
});

test('a checkConnection failure (e.g. stale evidence) exits 1 with the reader\'s own message', async () => {
  const calls = [];
  const reader = fakeReader({
    view: viewWith(), calls,
    checkConnectionImpl: async () => { throw new Error('Health evidence is stale; refresh before checking'); },
  });
  const cap = capture();
  let code;
  try { code = await run({ flags: { yes: true }, positionals: ['codex'], deps: { createReader: () => reader } }); }
  finally { cap.restore(); }
  assert.equal(code, 1);
  assert.match(cap.text(), /Health evidence is stale; refresh before checking/);
});

test('a non-pass result exits 1', async () => {
  const reader = fakeReader({ view: viewWith(), checkConnectionImpl: passingCheck('codex', { state: 'fail', reason: 'The native host reported an unsuccessful connection check.' }) });
  const cap = capture();
  let code;
  try { code = await run({ flags: { yes: true }, positionals: ['codex'], deps: { createReader: () => reader } }); }
  finally { cap.restore(); }
  assert.equal(code, 1);
});

test('--json prints { host, connection } alone on stdout; every human line lands on stderr', async () => {
  const calls = [];
  const reader = fakeReader({ view: viewWith(), calls, checkConnectionImpl: passingCheck('codex') });
  const streams = captureStreams();
  let code;
  try { code = await run({ flags: { yes: true, json: true }, positionals: ['codex'], deps: { createReader: () => reader } }); }
  finally { streams.restore(); }
  assert.equal(code, 0);
  const parsed = JSON.parse(streams.out().trim());
  assert.deepEqual(parsed, { host: 'codex', connection: { state: 'pass', reason: 'Provider responded', model: 'claude-opus-5-5' } });
  assert.match(streams.err(), /host: codex/);
  assert.ok(streams.err().includes(CONNECTION_CHECK_DISCLOSURE));
  assert.doesNotMatch(streams.out(), /host: codex/, 'human lines never reach stdout under --json');
});

test('the rendered dashboard page carries the exact same (escaped) disclosure sentence', () => {
  const html = renderPage({ name: 'agentic-kit', version: '4.0.0-test' });
  assert.ok(html.includes(CONNECTION_CHECK_DISCLOSURE), 'page.mjs renders the shared constant, not a copy');
});
