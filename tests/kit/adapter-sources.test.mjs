// Remote manifest sources (ADR-0031 P6). All offline: fetchFn/execFileFn are
// always injected, no real network or npm/tar invocation happens. Verifies
// the three source forms (file / https / npm), their failure modes each
// mapped to a named SourceError.reason, and — via admitAdapters — that the
// resolve-before-hash ordering makes a mutated remote source show up as
// 'consent-stale' rather than being silently re-trusted.
//
// Also carries regression coverage for the security-review fix-first pass:
// (1) a hanging https body read must be bounded by timeoutMs, not hang
//     forever; (2) npm tar extraction never touches disk (stdout-only);
// (6) file sources refuse symlinks/directories and enforce maxBytes;
// (7) the npm version/tag half is validated, not just character-classed;
// (14) external text is sanitized (control chars stripped, length bounded)
//     before it enters a SourceError detail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveManifestSource, SourceError } from '../../src/lib/adapters/sources.mjs';
import { admitAdapters, hashManifest } from '../../src/lib/adapters/admission.mjs';
import { validateAdapterManifest } from '../../src/lib/adapters/manifest.mjs';

function validHost(overrides = {}) {
  return {
    id: 'hermes',
    label: 'Hermes',
    install: { bin: 'hermes', externalInstallPolicy: 'detect-never-overwrite' },
    capabilities: {
      canDriveSession: true, canBePrimary: false, canRouteActivities: true,
      commandStatusline: false, transcripts: true, usage: false,
      nativeMcpConfig: false, nativeGuidance: false,
    },
    trust: { approvalPolicy: 'unchanged', changes: [] },
    enabledByDefault: false,
    configProjection: 'ruflo',
    observability: [],
    ...overrides,
  };
}

function validManifest(overrides = {}) {
  return {
    name: 'hermes',
    version: '1.0.0',
    contract: 1,
    host: validHost(),
    detection: { bin: 'hermes' },
    driving: { surfaces: ['acp'] },
    trust: {
      changes: [{
        id: 'hermes-subprocess-hooks', kind: 'third-party-adapter', scope: 'project',
        owner: 'hermes', value: 'subprocess hooks', effect: 'run consented lifecycle hooks for hermes',
      }],
    },
    ...overrides,
  };
}

function trustingConsent(trusted = {}) {
  return {
    recordedHashFor: (name) => trusted[name] ?? null,
    isTrusted: (name, hash) => trusted[name] === hash,
  };
}

/** Builds a fetch-shaped Response stub: ok/status/headers.get/body.getReader
 * over the given bytes, delivered as a single chunk. */
function jsonResponse(payload, { status = 200, declareLength = true } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return bytesResponse(bytes, { status, declareLength });
}

function textResponse(text, { status = 200, declareLength = true } = {}) {
  return bytesResponse(new TextEncoder().encode(text), { status, declareLength });
}

function bytesResponse(bytes, { status = 200, declareLength = true } = {}) {
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    type: 'basic',
    headers: { get: (name) => (declareLength && name.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
        cancel: async () => {},
      }),
    },
  };
}

/** A reader that yields multiple chunks, exceeding maxBytes only once all
 * are combined (so a Content-Length precheck can't catch it — it must be
 * caught by the streamed cap instead). Tracks whether cancel() was called. */
function chunkedOversizeResponse(chunks) {
  let index = 0;
  let cancelled = false;
  return {
    response: {
      ok: true,
      status: 200,
      type: 'basic',
      headers: { get: () => null }, // no Content-Length declared
      body: {
        getReader: () => ({
          read: async () => {
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = chunks[index++];
            return { done: false, value };
          },
          cancel: async () => { cancelled = true; },
        }),
      },
    },
    wasCancelled: () => cancelled,
  };
}

/** A response whose body reader hangs forever — never resolves, never
 * rejects, and never observes any signal itself. Used to prove
 * resolveHttpsSource bounds the BODY READ, not just the initial fetch
 * (regression for finding 1). */
function hangingBodyResponse() {
  return {
    ok: true,
    status: 200,
    type: 'basic',
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => {},
      }),
    },
  };
}

const neverCalled = (label) => (...args) => { throw new Error(`${label} must not be called (args: ${JSON.stringify(args)})`); };

// ── file source ──────────────────────────────────────────────────────────

test('file path source: passthrough read + JSON.parse, no network', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-file-'));
  const file = path.join(dir, 'manifest.json');
  const payload = { name: 'hermes', contract: 1 };
  await fs.writeFile(file, JSON.stringify(payload), 'utf8');
  try {
    const result = await resolveManifestSource(file, { fetchFn: neverCalled('fetchFn') });
    assert.deepEqual(result.raw, payload);
    assert.equal(result.origin, 'file');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('file path source: missing file -> source-unreachable', async () => {
  await assert.rejects(
    () => resolveManifestSource('/nonexistent/path/does-not-exist.json'),
    (error) => error instanceof SourceError && error.reason === 'source-unreachable',
  );
});

test('file source (finding 6): a symlink is refused, not followed, even to a valid manifest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-file-symlink-'));
  const real = path.join(dir, 'real.json');
  const link = path.join(dir, 'link.json');
  await fs.writeFile(real, JSON.stringify(validManifest()), 'utf8');
  await fs.symlink(real, link);
  try {
    await assert.rejects(
      () => resolveManifestSource(link),
      (error) => error instanceof SourceError && error.reason === 'source-invalid',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('file source (finding 6): a directory is refused', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-file-dir-'));
  try {
    await assert.rejects(
      () => resolveManifestSource(dir),
      (error) => error instanceof SourceError && error.reason === 'source-invalid',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('file source (finding 6): an oversized file is refused before being fully read', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-file-big-'));
  const file = path.join(dir, 'big.json');
  await fs.writeFile(file, JSON.stringify({ padding: 'x'.repeat(1000) }), 'utf8');
  try {
    await assert.rejects(
      () => resolveManifestSource(file, { maxBytes: 100 }),
      (error) => error instanceof SourceError && error.reason === 'source-too-large',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── https:// source ──────────────────────────────────────────────────────

test('http:// is refused as source-insecure, before any fetch', async () => {
  await assert.rejects(
    () => resolveManifestSource('http://example.com/manifest.json', { fetchFn: neverCalled('fetchFn') }),
    (error) => error instanceof SourceError && error.reason === 'source-insecure',
  );
});

test('a 3xx redirect response is refused, not followed', async () => {
  const fetchFn = async () => ({
    type: 'opaqueredirect', status: 0, ok: false, headers: { get: () => null }, body: null,
  });
  await assert.rejects(
    () => resolveManifestSource('https://example.com/manifest.json', { fetchFn }),
    (error) => error instanceof SourceError && error.reason === 'source-unreachable'
      && /redirects are not followed/.test(error.message),
  );
});

test('a plain 3xx status (non-opaque) is also refused', async () => {
  const fetchFn = async () => ({
    type: 'basic', status: 302, ok: false, headers: { get: () => null }, body: null,
  });
  await assert.rejects(
    () => resolveManifestSource('https://example.com/manifest.json', { fetchFn }),
    (error) => error instanceof SourceError && error.reason === 'source-unreachable',
  );
});

test('declared Content-Length above maxBytes is rejected before any body read', async () => {
  let readerCreated = false;
  const fetchFn = async () => ({
    ok: true, status: 200, type: 'basic',
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? '999999' : null) },
    body: { getReader: () => { readerCreated = true; return { read: neverCalled('reader.read') }; } },
  });
  await assert.rejects(
    () => resolveManifestSource('https://example.com/manifest.json', { fetchFn, maxBytes: 100 }),
    (error) => error instanceof SourceError && error.reason === 'source-too-large',
  );
  assert.equal(readerCreated, false, 'the body must never be read once Content-Length alone exceeds the cap');
});

test('an oversized streamed body (no declared Content-Length) is caught by the streamed cap and cancels the reader', async () => {
  const chunk = new TextEncoder().encode('x'.repeat(8));
  const { response, wasCancelled } = chunkedOversizeResponse([chunk, chunk]); // 16 bytes total
  const fetchFn = async () => response;
  await assert.rejects(
    () => resolveManifestSource('https://example.com/manifest.json', { fetchFn, maxBytes: 10 }),
    (error) => error instanceof SourceError && error.reason === 'source-too-large',
  );
  assert.equal(wasCancelled(), true, 'the reader must be cancelled the moment the cap is crossed');
});

test('a timeout during the initial fetch aborts and reports source-unreachable', async () => {
  const fetchFn = (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  await assert.rejects(
    () => resolveManifestSource('https://example.com/manifest.json', { fetchFn, timeoutMs: 20 }),
    (error) => error instanceof SourceError && error.reason === 'source-unreachable' && /timed out/.test(error.message),
  );
});

test('regression (finding 1): a hanging body read is bounded by timeoutMs, not left to hang forever', async () => {
  const fetchFn = async () => hangingBodyResponse();
  const start = Date.now();
  await assert.rejects(
    () => resolveManifestSource('https://example.com/manifest.json', { fetchFn, timeoutMs: 300 }),
    (error) => error instanceof SourceError && error.reason === 'source-unreachable' && /timed out/.test(error.message),
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1500, `expected the body-read hang to be bounded by timeoutMs, took ${elapsed}ms`);
});

test('invalid JSON body -> source-invalid-json', async () => {
  const fetchFn = async () => textResponse('{ this is not valid json');
  await assert.rejects(
    () => resolveManifestSource('https://example.com/manifest.json', { fetchFn }),
    (error) => error instanceof SourceError && error.reason === 'source-invalid-json',
  );
});

test('a valid https manifest resolves with origin "url"', async () => {
  const payload = validManifest();
  const fetchFn = async () => jsonResponse(payload);
  const result = await resolveManifestSource('https://example.com/manifest.json', { fetchFn });
  assert.deepEqual(result.raw, payload);
  assert.equal(result.origin, 'url');
});

// ── npm:<pkg> source ─────────────────────────────────────────────────────

/** Stub execFileFn that fabricates what real npm+tar would have produced:
 * `npm pack` "writes" a .tgz into --pack-destination, and
 * `tar -xzOf <tgz> package/ak-adapter.json` "extracts" by returning the
 * member content on stdout — never touching disk, matching the real
 * implementation's stdout-only extraction (finding 2). No real npm/tar
 * binary or network is invoked.
 *   - failTar: simulate tar exiting non-zero (member not in the archive).
 *   - emptyMember: simulate a symlink/non-regular member — tar succeeds
 *     (exit 0) but produces no data on stdout. */
function fakeNpmExecFileFn(payload, { failTar = false, emptyMember = false } = {}) {
  return async (_cmd, args) => {
    if (args[0] === 'pack') {
      const destIndex = args.indexOf('--pack-destination');
      const dest = args[destIndex + 1];
      fsSync.writeFileSync(path.join(dest, 'fake-pkg-1.0.0.tgz'), 'fake tarball bytes');
      return { stdout: '', stderr: '' };
    }
    if (args[0] === '-xzOf') {
      if (failTar) throw Object.assign(new Error('tar: package/ak-adapter.json not found in archive'), { code: 2 });
      if (emptyMember) return { stdout: '', stderr: '' };
      return { stdout: JSON.stringify(payload), stderr: '' };
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
}

test('npm: happy path — resolves ak-adapter.json extracted (via stdout) from the package root, and cleans up its temp dir', async () => {
  const payload = validManifest();
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-npm-'));
  try {
    const result = await resolveManifestSource('npm:fake-pkg@1.0.0', {
      execFileFn: fakeNpmExecFileFn(payload),
      tmpDir: tmpBase,
    });
    assert.deepEqual(result.raw, payload);
    assert.equal(result.origin, 'npm');
    const remaining = await fs.readdir(tmpBase);
    assert.deepEqual(remaining, [], 'the mkdtemp working dir must be removed after a successful resolve');
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});

test('npm: scoped package spec with a version resolves correctly', async () => {
  const payload = validManifest();
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-npm-scoped-'));
  try {
    const result = await resolveManifestSource('npm:@acme/hermes-adapter@2.1.0', {
      execFileFn: fakeNpmExecFileFn(payload),
      tmpDir: tmpBase,
    });
    assert.deepEqual(result.raw, payload);
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});

test('npm: exact semver version is accepted', async () => {
  const payload = validManifest();
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-npm-ver-'));
  try {
    const result = await resolveManifestSource('npm:fake-pkg@1.2.3', {
      execFileFn: fakeNpmExecFileFn(payload), tmpDir: tmpBase,
    });
    assert.deepEqual(result.raw, payload);
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});

test('npm: a dist-tag version ("latest") is accepted', async () => {
  const payload = validManifest();
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-npm-tag-'));
  try {
    const result = await resolveManifestSource('npm:fake-pkg@latest', {
      execFileFn: fakeNpmExecFileFn(payload), tmpDir: tmpBase,
    });
    assert.deepEqual(result.raw, payload);
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});

test('npm (finding 7): a git-shorthand disguised as a version is rejected before execFileFn is called', async () => {
  await assert.rejects(
    () => resolveManifestSource('npm:pkg@attacker/repo', { execFileFn: neverCalled('execFileFn') }),
    (error) => error instanceof SourceError && error.reason === 'source-invalid'
      && /not a version or dist-tag/.test(error.message),
  );
});

test('npm (finding 7): a local-path-shaped version is rejected before execFileFn is called', async () => {
  await assert.rejects(
    () => resolveManifestSource('npm:pkg@../../x', { execFileFn: neverCalled('execFileFn') }),
    (error) => error instanceof SourceError && error.reason === 'source-invalid',
  );
});

test('npm: package-name injection attempts are rejected before execFileFn is ever called', async () => {
  const attempts = ['npm:foo; rm -rf /', 'npm:foo$(x)', 'npm:foo bar', 'npm:foo`x`', 'npm:foo|bar'];
  for (const source of attempts) {
    await assert.rejects(
      () => resolveManifestSource(source, { execFileFn: neverCalled(`execFileFn for ${source}`) }),
      (error) => error instanceof SourceError && error.reason === 'source-invalid',
      `expected ${source} to be rejected as source-invalid`,
    );
  }
});

test('npm (finding 2): tar exiting non-zero (member not in archive) -> source-invalid, temp dir cleaned up', async () => {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-npm-missing-'));
  try {
    await assert.rejects(
      () => resolveManifestSource('npm:fake-pkg@1.0.0', {
        execFileFn: fakeNpmExecFileFn({}, { failTar: true }),
        tmpDir: tmpBase,
      }),
      (error) => error instanceof SourceError && error.reason === 'source-invalid'
        && /does not ship an ak-adapter\.json/.test(error.message),
    );
    const remaining = await fs.readdir(tmpBase);
    assert.deepEqual(remaining, [], 'the mkdtemp working dir must be removed even on a failure path');
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});

test('npm (finding 2): a symlink member (empty stdout, tar exits 0) is refused explicitly and honestly', async () => {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-npm-symlink-'));
  try {
    await assert.rejects(
      () => resolveManifestSource('npm:fake-pkg@1.0.0', {
        execFileFn: fakeNpmExecFileFn({}, { emptyMember: true }),
        tmpDir: tmpBase,
      }),
      (error) => error instanceof SourceError && error.reason === 'source-invalid'
        && /produced no content/.test(error.message),
    );
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});

test('npm: npm pack itself failing -> source-unreachable, temp dir cleaned up', async () => {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-npm-packfail-'));
  const execFileFn = async () => { throw new Error('npm ERR! 404 Not Found'); };
  try {
    await assert.rejects(
      () => resolveManifestSource('npm:does-not-exist@9.9.9', { execFileFn, tmpDir: tmpBase }),
      (error) => error instanceof SourceError && error.reason === 'source-unreachable',
    );
    const remaining = await fs.readdir(tmpBase);
    assert.deepEqual(remaining, [], 'the mkdtemp working dir must be removed even when npm pack fails');
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});

test('npm (finding 5): oversized extracted manifest (stdout) -> source-too-large', async () => {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-npm-oversize-'));
  const bigPayload = { name: 'hermes', padding: 'x'.repeat(1000) };
  try {
    await assert.rejects(
      () => resolveManifestSource('npm:fake-pkg@1.0.0', {
        execFileFn: fakeNpmExecFileFn(bigPayload),
        tmpDir: tmpBase,
        maxBytes: 100,
      }),
      (error) => error instanceof SourceError && error.reason === 'source-too-large',
    );
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});

test('regression (finding 14): control characters (C0 and C1, incl. U+009B CSI) are stripped and detail length is bounded before entering a SourceError', async () => {
  const dirty = `line one\nline two\x1B[8A\x9B2Jmalicious cursor move${'z'.repeat(500)}`;
  const execFileFn = async () => { throw new Error(dirty); };
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-src-npm-dirty-'));
  try {
    await assert.rejects(
      () => resolveManifestSource('npm:fake-pkg@1.0.0', { execFileFn, tmpDir: tmpBase }),
      (error) => {
        assert.ok(error instanceof SourceError);
        assert.ok(!error.message.includes('\x1B'), 'ESC control byte must be stripped');
        assert.ok(!error.message.includes('\x9b'), 'C1 CSI (U+009B) must be stripped');
        assert.ok(!error.message.includes('\n'), 'newline must be stripped');
        assert.ok(error.message.length < 300, `detail must be length-bounded, got ${error.message.length}`);
        return true;
      },
    );
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});

// ── integration: admitAdapters + resolve-before-hash ordering ──────────────

test('admitAdapters: a mutated https-sourced manifest since consent was recorded is refused as consent-stale', async () => {
  const first = validManifest();
  const second = validManifest({ version: '1.0.1' }); // valid, but different content -> different hash

  // Simulate: consent was recorded against an EARLIER resolve of `first`.
  const firstValidated = validateAdapterManifest(first);
  const consentedHash = hashManifest(firstValidated);

  // By the time admission actually runs, the remote now serves `second`.
  const fetchFn = async () => jsonResponse(second);
  const readManifest = (source) => resolveManifestSource(source, { fetchFn }).then((r) => r.raw);

  const results = await admitAdapters({
    cfg: { hostAdapters: [{ name: 'hermes', source: 'https://example.com/hermes.json' }] },
    readManifest,
    consent: trustingConsent({ hermes: consentedHash }),
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].admitted, false);
  assert.equal(results[0].reason, 'consent-stale');
});

test('admitAdapters: an unchanged https-sourced manifest matching consent is admitted', async () => {
  const manifest = validManifest();
  const validated = validateAdapterManifest(manifest);
  const hash = hashManifest(validated);

  const fetchFn = async () => jsonResponse(manifest);
  const readManifest = (source) => resolveManifestSource(source, { fetchFn }).then((r) => r.raw);

  const results = await admitAdapters({
    cfg: { hostAdapters: [{ name: 'hermes', source: 'https://example.com/hermes.json' }] },
    readManifest,
    consent: trustingConsent({ hermes: hash }),
  });

  assert.equal(results[0].admitted, true);
});
