// Remote manifest sources (ADR-0031, work item P6): resolves an adapter
// manifest's `source` (kit.json's hostAdapters[].source) into raw parsed
// JSON bytes. This module is a pure fetch/parse layer — validation, hashing,
// and consent stay admission.mjs's job.
//
// Security-review-mandated ordering: this resolver runs BEFORE hashing.
// admission.mjs's admitOne calls readManifest() (which delegates here) and
// only afterward validates + hashes the result. That means consent pins the
// RESOLVED content, not a name: a mutable remote (an npm dist-tag moving, a
// URL's content changing) produces different bytes on the next admission
// pass, which hashes differently and is refused as 'consent-stale' rather
// than being silently re-trusted. Nothing in this file may cache or memoize
// across calls — every call re-resolves from scratch, which is what makes
// that invalidation automatic instead of something callers must remember to
// force.
//
// Three source forms, dispatched on prefix:
//   - a file path (no recognized prefix) — no network, ever (offline-first
//     is a repo invariant); an `lstat` gate refuses anything that is not a
//     plain regular file (symlinks, directories, FIFOs, devices) and
//     enforces `maxBytes` before the content is ever read, then JSON.parse.
//   - https://...   — HTTPS only, no redirects followed, bounded time and
//     bytes (a Content-Length pre-check, a streamed hard cap, and a single
//     timeout budget that stays armed across BOTH the initial request and
//     the full body read — a response that sends headers and then never
//     delivers the rest of the body must not hang forever).
//   - npm:<pkg>[@version|tag] — `npm pack` (never executing the package's
//     own scripts) into a throwaway temp dir, then `tar` extracts exactly
//     `package/ak-adapter.json` STRAIGHT TO STDOUT — never to disk. A
//     tarball member can be a symlink (arbitrary local file read via a
//     followed link), a FIFO (extraction hang), or a device node; -O
//     sidesteps that whole class by never writing extracted content to the
//     filesystem at all, and the subprocess's own `maxBuffer` — bounded
//     tight to `maxBytes` for this one call, not the generic subprocess cap
//     used elsewhere — rejects an oversized member before it fully lands in
//     process memory, closing the decompression-bomb angle a disk-based
//     extraction would otherwise have to police after the fact.
//
// Why npm tarball extraction shells npm+tar rather than adding a `tar`
// dependency: this package is zero-runtime-dependency by ADR-0016, npm is
// already shelled elsewhere in this codebase (providers.mjs's installHost,
// heal.mjs's upgradePackage/selfUpdate), and `npm pack` of a remote spec
// downloads the package without ever running ITS scripts (belt:
// --ignore-scripts, on top of the fact that `npm pack` only runs
// prepare/prepack/postpack in the first place — this flag closes that off
// too). Reaching for a tar library would trade a well-audited system binary
// for a new supply-chain dependency to buy nothing extraction-to-stdout
// couldn't already do more simply.
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveShim } from '../exec.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 262_144;
// Subprocess stdout/stderr capture cap for `npm pack` itself — its own
// textual/progress output, never the manifest content (which goes through a
// separately, tightly bounded maxBuffer — see resolveNpmSource).
const SUBPROCESS_MAX_BUFFER = 16 * 1024 * 1024;
// SourceError detail text is bounded to this length, matching
// src/lib/execution/runner.mjs's boundedFailure precedent.
const DETAIL_MAX_LENGTH = 240;

const defaultExecFile = promisify(nodeExecFile);

export class SourceError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'SourceError';
    this.reason = reason;
  }
}

/** Strips C0 control characters (0x00–0x1F) and the full C1 range
 * (0x7F–0x9F inclusive — DEL plus every C1 control, e.g. U+009B CSI) from
 * external text before it can enter a SourceError detail — subprocess
 * stderr, thrown-error messages, and JSON-parse error snippets are all
 * attacker-influenced text (npm/tar output, a remote server's response,
 * error text derived from a hostile manifest) that later gets printed raw
 * by consumers (the bin warning path, the trust CLI). '\n'/'\t'/'\r'
 * collapse to a single space rather than vanish, so a multi-line message
 * stays readable as one line; every other C0/C1 byte is dropped outright —
 * this defuses ANSI escape sequences (ESC-prefixed AND the single-byte C1
 * form, e.g. U+009B in place of ESC+'[') and terminal-control tricks, not
 * just newlines. Bounded to DETAIL_MAX_LENGTH chars afterward. */
function sanitizeDetail(text) {
  const input = String(text ?? '');
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (code === 0x09 || code === 0x0a || code === 0x0d) { out += ' '; continue; }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  return out.trim().slice(0, DETAIL_MAX_LENGTH);
}

/** Single choke point for constructing a SourceError: every detail string,
 * however it was built, passes through sanitizeDetail here — callers never
 * need to remember to sanitize at each throw site individually. */
function sourceError(reason, detail) {
  return new SourceError(reason, sanitizeDetail(detail));
}

// Every character an npm package spec (name[@version-or-tag]) may legally
// contain, checked against the WHOLE spec string before any parsing —
// command-injection surface. A spec containing ';', '$', '`', whitespace,
// or any other shell/argv-hostile character is rejected here, before it is
// ever assembled into an argv array (even though execFile+shell:false
// already blocks shell interpretation — this is belt-and-suspenders, the
// same posture as assertId elsewhere in this codebase).
const NPM_SPEC_CHARS_RE = /^[A-Za-z0-9@/._-]+$/;
// A conservative structural shape for the package-name portion only
// (scope optional): must start with an alphanumeric, never '.' or '_'.
const NPM_NAME_RE = /^(?:@[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*$/;
// Exact semver only (no ranges — a range is meaningless for "pin one
// tarball"), mirroring manifest.mjs's SEMVER_RE.
const NPM_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
// A dist-tag ('latest', 'next', 'beta', ...): no '/' — that's the exact
// shape npm's own git-shorthand ("user/repo") and local-path ("../x")
// resolvers key off, so excluding '/' here is what keeps `npm:pkg@version`
// from silently reinterpreting the version half as a different resolver
// entirely (finding 7).
const NPM_DIST_TAG_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** Splits "name[@version-or-tag]" into { name, version }. Scoped names
 * (`@scope/pkg`) have a leading '@' that is not a version separator, so the
 * search for the separating '@' starts after the scope's '/'. */
function parseNpmSpec(spec) {
  const scoped = spec.startsWith('@');
  const rest = scoped ? spec.slice(1) : spec;
  const at = rest.indexOf('@');
  if (at === -1) return { name: spec, version: undefined };
  const name = scoped ? `@${rest.slice(0, at)}` : rest.slice(0, at);
  const version = rest.slice(at + 1);
  return { name, version };
}

function isMaxBufferError(error) {
  return error?.code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER' || /maxBuffer/i.test(error?.message ?? '');
}

async function resolveFileSource(source, maxBytes) {
  // lstat, not stat: a symlink must be refused as itself (isFile() false on
  // the link), never silently followed to whatever it points at — the same
  // "no arbitrary local read via a followed link" posture the npm path's
  // stdout-only extraction enforces (finding 6 mirrors finding 2).
  let stat;
  try {
    stat = await fs.lstat(source);
  } catch (error) {
    throw sourceError('source-unreachable', error?.message ?? String(error));
  }
  if (!stat.isFile()) {
    throw sourceError('source-invalid', `'${source}' is not a regular file — symlinks, directories, and special files are refused`);
  }
  if (stat.size > maxBytes) {
    throw sourceError('source-too-large', `'${source}' is ${stat.size} bytes, exceeding the ${maxBytes}-byte cap`);
  }
  let text;
  try {
    text = await fs.readFile(source, 'utf8');
  } catch (error) {
    throw sourceError('source-unreachable', error?.message ?? String(error));
  }
  try {
    /** @type {'file'} */
    const origin = 'file';
    return { raw: JSON.parse(text), origin };
  } catch (error) {
    throw sourceError('source-invalid-json', error?.message ?? String(error));
  }
}

/** Streamed read with a hard byte cap, mirroring the bounded-read pattern in
 * src/lib/execution/opencode.mjs's responseJson: cancel the reader the
 * moment the cap is crossed, on top of an early Content-Length rejection.
 * Abort-aware: `signal` is the SAME AbortSignal that bounds the whole
 * resolve (see resolveHttpsSource) — every reader.read() races against it,
 * so a response that sends headers and then never delivers the rest of the
 * body still gets cut off at `timeoutMs`, not left to hang forever. */
async function readBoundedBody(response, maxBytes, label,
  { signal, timeoutMs } = /** @type {{signal?: AbortSignal, timeoutMs?: number}} */ ({})) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw sourceError('source-too-large', `${label} declared Content-Length ${declared} exceeds ${maxBytes} bytes`);
  }
  if (!response.body?.getReader) {
    throw sourceError('source-unreachable', `${label} did not expose a bounded response stream`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const abortedPromise = signal
    ? new Promise((_, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    })
    : null;
  try {
    for (;;) {
      const step = abortedPromise ? Promise.race([reader.read(), abortedPromise]) : reader.read();
      const { done, value } = await step;
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw sourceError('source-too-large', `${label} response exceeded ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      await reader.cancel().catch(() => {});
      throw sourceError('source-unreachable', `${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    reader.releaseLock?.();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(combined);
}

async function resolveHttpsSource(url, { fetchFn, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The timer/controller stay alive for the ENTIRE resolve — fetch AND the
  // full body read — cleared only in this outer finally. Clearing it right
  // after the header fetch (the prior shape) let a 200 response with a
  // body that never finishes arriving hang resolveManifestSource forever;
  // since bootstrapHostAdapters runs on every `ak` command with the
  // experimental flag on, that hang bricked the whole CLI (finding 1).
  try {
    let response;
    try {
      // redirect: 'manual' — a redirect is REFUSED outright, never
      // followed. Fail-closed and explicit beats chasing a redirect chain
      // to who-knows-where (ADR-0023 posture): pin the final URL instead.
      response = await fetchFn(url, { redirect: 'manual', signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw sourceError('source-unreachable', `${url} timed out after ${timeoutMs}ms`);
      }
      throw sourceError('source-unreachable', error?.message ?? String(error));
    }

    // redirect:'manual' fetch implementations report a redirect either as
    // an opaque 'opaqueredirect' response (status 0, browser-shaped fetch)
    // or a plain 3xx status (some Node fetch implementations) — cover both.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw sourceError('source-unreachable', 'redirects are not followed for adapter manifests — pin the final URL');
    }
    if (!response.ok) {
      throw sourceError('source-unreachable', `${url} responded with HTTP ${response.status}`);
    }

    const text = await readBoundedBody(response, maxBytes, url, { signal: controller.signal, timeoutMs });
    try {
      /** @type {'url'} */
      const origin = 'url';
      return { raw: JSON.parse(text), origin };
    } catch (error) {
      throw sourceError('source-invalid-json', error?.message ?? String(error));
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Run `npm pack` as a bounded subprocess. Resolves the command through
 * `resolveShimFn` — production always passes src/lib/exec.mjs's real
 * resolveShim (a no-op on POSIX, but the difference between a working and
 * ENOENT'd npm invocation on Windows); tests inject a passthrough so their
 * execFileFn stubs can assert the LOGICAL argv without also having to model
 * Windows' PowerShell-wrapped shim shape (that shape is exec.mjs's own test
 * responsibility, not this module's). Never shell:true; argv arrays only. */
async function execBounded(execFileFn, cmd, args, { cwd, timeoutMs, maxBuffer }, label, resolveShimFn) {
  const invocation = resolveShimFn(cmd, args);
  if (invocation.resolved === false) {
    throw sourceError('source-unreachable', `no safe invocation found for ${cmd}`);
  }
  try {
    await execFileFn(invocation.command, invocation.args, {
      cwd, timeout: timeoutMs, maxBuffer, shell: false,
    });
  } catch (error) {
    throw sourceError('source-unreachable', `${label} failed: ${error?.message ?? String(error)}`);
  }
}

async function resolveNpmSource(spec, {
  execFileFn, timeoutMs, maxBytes, tmpDir, resolveShimFn,
}) {
  if (!NPM_SPEC_CHARS_RE.test(spec)) {
    throw sourceError('source-invalid', `npm spec contains disallowed characters: ${spec}`);
  }
  const { name, version } = parseNpmSpec(spec);
  if (!name || !NPM_NAME_RE.test(name)) {
    throw sourceError('source-invalid', `not a valid npm package name: ${name || '(empty)'}`);
  }
  // The version/tag half is validated SEPARATELY from the character-class
  // gate above: that gate alone still permits e.g. 'pkg@attacker/repo' (npm
  // git-shorthand) or 'pkg@../../x' (npm's local-path resolver) through,
  // silently swapping which resolver npm uses for something that reads like
  // a version pin. Restricting it to exact semver or a slash-free dist-tag
  // keeps `npm:` sources anchored to "one tarball, from the registry".
  if (version !== undefined && !(NPM_SEMVER_RE.test(version) || NPM_DIST_TAG_RE.test(version))) {
    throw sourceError('source-invalid', `not a version or dist-tag: ${version}`);
  }

  const dir = fsSync.mkdtempSync(path.join(tmpDir ?? os.tmpdir(), 'ak-adapter-src-'));
  try {
    await execBounded(
      execFileFn,
      'npm',
      ['pack', spec, '--ignore-scripts', '--pack-destination', dir],
      { cwd: dir, timeoutMs, maxBuffer: SUBPROCESS_MAX_BUFFER },
      'npm pack',
      resolveShimFn,
    );

    const entries = await fs.readdir(dir);
    const tarball = entries.find((entry) => entry.endsWith('.tgz'));
    if (!tarball) {
      throw sourceError('source-invalid', `npm pack for '${spec}' produced no tarball`);
    }

    // Extract ONLY package/ak-adapter.json, straight to stdout (-O) —
    // never to disk. See the module header for why.
    const invocation = resolveShimFn('tar', ['-xzOf', tarball, 'package/ak-adapter.json']);
    if (invocation.resolved === false) {
      throw sourceError('source-unreachable', 'no safe invocation found for tar');
    }
    let stdout;
    try {
      // maxBuffer bounded tight to maxBytes (plus small encoding slack),
      // not the generic SUBPROCESS_MAX_BUFFER above: this stdout IS the
      // manifest content, so an oversized member is rejected by execFile's
      // own buffer ceiling before it fully lands in process memory.
      ({ stdout } = await execFileFn(invocation.command, invocation.args, {
        cwd: dir, timeout: timeoutMs, maxBuffer: maxBytes + 4096, shell: false,
      }));
    } catch (error) {
      if (isMaxBufferError(error)) {
        throw sourceError('source-too-large', `ak-adapter.json for '${spec}' exceeds ${maxBytes} bytes`);
      }
      // npm pack already proved the package itself was reachable; a
      // subsequent failure extracting this ONE specific member is, in
      // practice, always "the member isn't in the archive" — refuse it as
      // an invalid source, not an unreachable one.
      throw sourceError('source-invalid', `package '${spec}' does not ship an ak-adapter.json at its root`);
    }

    // A symlink (or other non-regular) tar entry carries no data blocks, so
    // -O extraction of one yields empty stdout. Refuse that explicitly and
    // honestly, rather than letting an opaque JSON.parse('') error stand in
    // for "this entry produced nothing, on purpose".
    if (!stdout || !stdout.trim()) {
      throw sourceError('source-invalid', `package '${spec}' member 'package/ak-adapter.json' produced no content — symlinks and other non-regular tar entries are not followed`);
    }
    if (Buffer.byteLength(stdout, 'utf8') > maxBytes) {
      throw sourceError('source-too-large', `ak-adapter.json for '${spec}' exceeds ${maxBytes} bytes`);
    }

    try {
      /** @type {'npm'} */
      const origin = 'npm';
      return { raw: JSON.parse(stdout), origin };
    } catch (error) {
      throw sourceError('source-invalid-json', error?.message ?? String(error));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Resolve an adapter manifest `source` string into raw parsed JSON.
 * Dispatches on prefix: `https://...`, `npm:<pkg>[@version|tag]`, or (no
 * recognized prefix) a local file path. Throws SourceError with a named
 * `.reason` on any failure — never returns partial or best-effort content.
 *
 * @param {string} source
 * @param {{fetchFn?:typeof fetch, execFileFn?:(cmd:string,args:string[],opts:any)=>Promise<{stdout:string,stderr:string}>,
 *   resolveShimFn?:(cmd:string,args:string[])=>{command:string,args:string[],resolved:boolean},
 *   timeoutMs?:number, maxBytes?:number, tmpDir?:string}} [options]
 * @returns {Promise<{raw:any, origin:'file'|'url'|'npm'}>}
 */
export async function resolveManifestSource(source, {
  fetchFn = globalThis.fetch,
  execFileFn = defaultExecFile,
  resolveShimFn = resolveShim,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  tmpDir,
} = {}) {
  if (typeof source !== 'string' || !source) {
    throw sourceError('source-invalid', 'source must be a non-empty string');
  }
  if (source.startsWith('https://')) {
    return resolveHttpsSource(source, { fetchFn, timeoutMs, maxBytes });
  }
  if (source.startsWith('http://')) {
    throw sourceError('source-insecure', 'http:// sources are not permitted for adapter manifests — use https://');
  }
  if (source.startsWith('npm:')) {
    return resolveNpmSource(source.slice('npm:'.length), {
      execFileFn, timeoutMs, maxBytes, tmpDir, resolveShimFn,
    });
  }
  return resolveFileSource(source, maxBytes);
}
