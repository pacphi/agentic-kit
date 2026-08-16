// x host adapters — the trust CLI (ADR-0031 P1) plus the tiered conformance
// subcommand (ADR-0031 P4). Covers: flag gating (zero reads/writes when off),
// the trust happy path (consent recorded at
// hashManifest(validateAdapterManifest(raw))), refusal of an invalid
// manifest, the non-interactive-without---yes fail-closed guard, idempotent
// re-trust, stale-hash disclosure, revoke true/false, list states, an
// unknown adapter name, and `conformance`'s printed table + recording +
// exit codes.
//
// Also covers grant/promote, gate, status, and revoke-grant (ADR-0031 P5 +
// P7, implemented in the sibling host-adapters-grants.mjs but dispatched
// through this same `run()`): the grant happy/refusal paths against a
// force-recorded passed tier, capability allow-listing (aqeProvider and any
// other non-TIER_GRANTS value rejected), hash-pinned staleness voiding a
// grant, the non-interactive confirm gate, gate's ref validation, status's
// passed/gated/granted rendering and stale marking, and that no new
// subcommand ever accepts/forwards an exercise/callback option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/commands/x/host-adapters.mjs';
import { hashManifest } from '../../src/lib/adapters/admission.mjs';
import { validateAdapterManifest } from '../../src/lib/adapters/manifest.mjs';
import {
  recordedHashFor, recordConsent, revokeConsent,
} from '../../src/lib/adapters/consent.mjs';
import { HOST_REGISTRY } from '../../src/lib/adapters/registries.mjs';
import {
  grantsFor, recordTierResult, recordTierGate, grantCapability, grantedCapabilitiesFor,
} from '../../src/lib/adapters/grants.mjs';
import { runTieredConformance } from '../../src/lib/adapters/conformance.mjs';

const ON_ENV = { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' };
const OFF_ENV = {};

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
    lifecycle: { detect: { hook: { command: ['hermes', 'detect'], timeoutMs: 5000 } } },
    trust: {
      changes: [{
        id: 'hermes-subprocess-hooks', kind: 'third-party-adapter', scope: 'project',
        owner: 'hermes', value: 'subprocess hooks', effect: 'run consented lifecycle hooks for hermes',
      }],
    },
    ...overrides,
  };
}

function tmpConsentFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-consent-'));
  return path.join(dir, 'adapter-consent.json');
}

function fileConsent(file) {
  return {
    recordedHashFor: (name) => recordedHashFor(name, { file }),
    recordConsent: (name, hash) => recordConsent(name, hash, { file }),
    revokeConsent: (name) => revokeConsent(name, { file }),
  };
}

function cfgWith(entries) {
  return { hostAdapters: entries };
}

const neverCalled = (label) => (...args) => { throw new Error(`${label} must not be called (args: ${JSON.stringify(args)})`); };

function capture() {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return {
    text: () => lines.join('\n'),
    lines: () => lines.slice(),
    restore: () => { console.log = orig; },
  };
}

// ── flag gating ──────────────────────────────────────────────────────────

test('flag unset refuses list/trust with exit 2 and zero consent-store calls', async () => {
  const consent = {
    recordedHashFor: neverCalled('recordedHashFor'),
    recordConsent: neverCalled('recordConsent'),
    revokeConsent: neverCalled('revokeConsent'),
  };
  const reader = neverCalled('reader');
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  for (const positionals of [['list'], ['trust', 'hermes'], []]) {
    const cap = capture();
    let code;
    try {
      code = await run({ positionals, env: OFF_ENV, consent, reader, cfg, flags: { yes: true } });
    } finally {
      cap.restore();
    }
    assert.equal(code, 2, `positionals=${JSON.stringify(positionals)}`);
  }
});

// revoke is fail-safe (finding 9): an operator who turns the experimental
// flag OFF must still be able to withdraw a standing consent record, or it
// silently reactivates the next time the flag is turned back on.
test('revoke works even when the experimental flag is off (fail-safe)', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  recordConsent('hermes', 'some-hash', { file });

  const cap = capture();
  let code;
  try {
    code = await run({ positionals: ['revoke', 'hermes'], env: OFF_ENV, consent, cfg: cfgWith([]), flags: {} });
  } finally {
    cap.restore();
  }

  assert.equal(code, 0);
  assert.match(cap.text(), /revoked/);
  assert.equal(recordedHashFor('hermes', { file }), null);
});

// ── trust: happy path ───────────────────────────────────────────────────

test('trust happy path records consent at hashManifest(validateAdapterManifest(raw))', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest();
  const expectedHash = hashManifest(validateAdapterManifest(raw));
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask: async () => true, isTTY: true, flags: {},
    });
  } finally {
    cap.restore();
  }

  assert.equal(code, 0);
  assert.equal(recordedHashFor('hermes', { file }), expectedHash);
  assert.match(cap.text(), /sha256/);
  assert.match(cap.text(), /consent recorded/);
});

test('trust discloses capabilities, lifecycle hooks (full command + timeout), and trust.changes before confirming', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest();
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);
  let asked = false;

  const cap = capture();
  try {
    await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask: async () => { asked = true; return true; }, isTTY: true, flags: {},
    });
  } finally {
    cap.restore();
  }

  assert.ok(asked, 'ask() must be called before recording');
  const text = cap.text();
  assert.match(text, /version:\s+1\.0\.0/);
  assert.match(text, /contract:\s+1/);
  assert.match(text, /host id:\s+hermes/);
  assert.match(text, /canDriveSession/);
  assert.match(text, /canRouteActivities/);
  assert.doesNotMatch(text, /canBePrimary(?!.*false)/); // only TRUE caps are listed
  assert.match(text, /detect: \["hermes","detect"\] \(timeout 5000ms\)/);
  assert.match(text, /hermes: subprocess hooks — run consented lifecycle hooks for hermes/);
});

// ── trust: full-manifest disclosure (finding 4) ─────────────────────────
// ADR-0029 §6 requires consent over the WHOLE manifest, not a curated
// subset. host.legacy.* and host.trust.approvalPolicy are hashed but the
// curated summary never names them by label — they must still surface, via
// the full JSON block.

test('trust discloses the complete validated manifest, including host.legacy and host.trust.approvalPolicy', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest({
    host: validHost({
      trust: { approvalPolicy: 'managed', changes: [] },
      legacy: { guidanceFile: 'hermes-guidance', enableEnv: 'HERMES_ENABLE_FLAG' },
    }),
  });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  try {
    await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask: async () => true, isTTY: true, flags: {},
    });
  } finally {
    cap.restore();
  }

  const text = cap.text();
  assert.match(text, /full manifest \(exactly the content being hashed\):/);
  assert.match(text, /"approvalPolicy":\s*"managed"/);
  assert.match(text, /"guidanceFile":\s*"hermes-guidance"/);
  assert.match(text, /"enableEnv":\s*"HERMES_ENABLE_FLAG"/);
});

// ── trust: control-char/ANSI sanitization (finding 3, BLOCKER) ──────────
// A crafted trust.changes field carrying cursor-movement/erase escapes plus
// newlines must never be able to rewrite the disclosure the operator is
// about to consent to.

test('trust strips ANSI escapes and collapses newlines in trust.changes fields before printing', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  // Built via String.fromCharCode, not a \x1b literal in a regex later —
  // eslint's no-control-regex flags a control char INSIDE a regex pattern,
  // so assertions below check via String#includes, never a regex literal.
  const ESC = String.fromCharCode(0x1b);
  const hostile = `${ESC}[8A${ESC}[Jfake line\ninjected`;
  const raw = validManifest({
    trust: {
      changes: [{
        id: 'hostile-change', kind: 'third-party-adapter', scope: 'project',
        owner: 'hermes', value: 'x', effect: hostile,
      }],
    },
  });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  try {
    await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask: async () => true, isTTY: true, flags: {},
    });
  } finally {
    cap.restore();
  }

  const text = cap.text();
  assert.ok(!text.includes(ESC), 'no raw ESC byte must reach the terminal');
  assert.ok(!text.includes('fake line\ninjected'), 'the curated-summary line must not contain a raw newline');
  assert.match(text, /fake line injected/, 'newline is collapsed to a single space, not silently dropped');
});

// ── C1 residual (0x80-0x9F, e.g. U+009B CSI) ────────────────────────────
// JSON.stringify does NOT escape C1 — only C0 (0x00-0x1F) is escaped by
// construction. A raw C1 byte in a manifest field must not survive into
// EITHER disclosure path: the curated summary (via stripControl) or the
// full-manifest JSON block (via the per-line stripControl pass).

test('a raw C1 control character (U+009B, CSI) is stripped from both the curated summary and the full-manifest JSON block', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const CSI = String.fromCharCode(0x9b);
  const raw = validManifest({
    trust: {
      changes: [{
        id: 'c1-change', kind: 'third-party-adapter', scope: 'project',
        owner: 'hermes', value: 'x', effect: `before${CSI}after`,
      }],
    },
  });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  try {
    await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask: async () => true, isTTY: true, flags: {},
    });
  } finally {
    cap.restore();
  }

  const text = cap.text();
  assert.ok(!text.includes(CSI), 'no raw C1 control character may reach the terminal, in either disclosure path');
  assert.match(text, /beforeafter/, 'the C1 byte is removed outright (it is not \\n/\\t/\\r, so no space is substituted)');
});

// ── disclosure ordering (finding 16, BLOCKER) ───────────────────────────
// The full-manifest JSON block can run many screens long on a large-but-
// legal manifest — whatever prints immediately before the [y/N] prompt is
// what the operator actually reads, so the decision-critical summary
// (capabilities, lifecycle hooks, trust changes, sha256) must come AFTER
// the JSON block, not before it.

test('disclosure prints the full-manifest JSON block first and the decision-critical summary last, immediately before the confirm prompt', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest();
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let lineCountAtAsk = null;
  const ask = async () => { lineCountAtAsk = cap.lines().length; return true; };
  try {
    await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask, isTTY: true, flags: {},
    });
  } finally {
    cap.restore();
  }

  const lines = cap.lines();
  const jsonHeaderIdx = lines.findIndex((l) => l.includes('full manifest (exactly the content being hashed):'));
  assert.ok(jsonHeaderIdx >= 0, 'full-manifest header must be present');
  const jsonBlockIdx = jsonHeaderIdx + 1;
  assert.match(lines[jsonBlockIdx], /"contract": 1/, 'the line right after the header must be the JSON dump itself');

  const capsIdx = lines.findIndex((l) => l.includes('capabilities:'));
  const hookIdx = lines.findIndex((l) => l.includes('detect: '));
  const sha256Idx = lines.findIndex((l) => l.includes('sha256:'));

  assert.ok(capsIdx > jsonBlockIdx, 'capabilities line must come after the full-manifest block');
  assert.ok(hookIdx > jsonBlockIdx, 'lifecycle hook line must come after the full-manifest block');
  assert.ok(sha256Idx > jsonBlockIdx, 'sha256 line must come after the full-manifest block');
  assert.ok(lineCountAtAsk !== null, 'ask() must have been called');
  assert.equal(sha256Idx, lineCountAtAsk - 1, 'sha256 must be the LAST line printed before the confirm prompt fires');
});

// ── trust: refuses an invalid manifest ──────────────────────────────────

test('trust refuses a manifest claiming canBePrimary; reason surfaces, nothing recorded', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest({ host: validHost({ capabilities: { ...validHost().capabilities, canBePrimary: true } }) });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask: neverCalled('ask'), isTTY: true, flags: { yes: true },
    });
  } finally {
    cap.restore();
  }

  assert.equal(code, 1);
  assert.match(cap.text(), /cap-can-be-primary/);
  assert.equal(recordedHashFor('hermes', { file }), null);
});

test('trust refuses a manifest whose host id shadows a built-in host, before any disclosure/confirm/write', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const builtinId = HOST_REGISTRY[0].id;
  const raw = validManifest({ name: builtinId, host: validHost({ id: builtinId }) });
  const cfg = cfgWith([{ name: builtinId, source: 'mem://shadow' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', builtinId], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask: neverCalled('ask'), isTTY: true, flags: { yes: true },
    });
  } finally {
    cap.restore();
  }

  assert.equal(code, 1);
  assert.match(cap.text(), /builtin-shadow/);
  assert.doesNotMatch(cap.text(), /sha256/, 'must refuse before disclosure, never reach the confirm step');
  assert.equal(recordedHashFor(builtinId, { file }), null);
});

test('trust refuses a manifest whose host.id does not match the cfg entry name (confirms admitOne parity)', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  // cfg entry says 'hermes', but the manifest's own host.id says 'not-hermes'.
  const raw = validManifest({ host: validHost({ id: 'not-hermes' }) });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask: neverCalled('ask'), isTTY: true, flags: { yes: true },
    });
  } finally {
    cap.restore();
  }

  assert.equal(code, 1);
  assert.match(cap.text(), /name-mismatch/);
  assert.equal(recordedHashFor('hermes', { file }), null);
});

// ── trust: non-interactive without --yes ────────────────────────────────

test('trust without --yes in a non-interactive session fails 2 before recording', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest();
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask: neverCalled('ask'), isTTY: false, flags: {},
    });
  } finally {
    cap.restore();
  }

  assert.equal(code, 2);
  assert.equal(recordedHashFor('hermes', { file }), null);
});

// ── trust: idempotent at same hash ──────────────────────────────────────

test('trust is idempotent when already trusted at the exact same hash (no rewrite, exit 0)', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest();
  const hash = hashManifest(validateAdapterManifest(raw));
  recordConsent('hermes', hash, { file });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask: neverCalled('ask'), isTTY: true, flags: {},
    });
  } finally {
    cap.restore();
  }

  assert.equal(code, 0);
  assert.match(cap.text(), /already trusted/);
  assert.equal(recordedHashFor('hermes', { file }), hash);
});

// ── trust: stale-hash discloses both hashes ─────────────────────────────

test('trust at a different recorded hash discloses both the stale and current hash before confirming', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest();
  const newHash = hashManifest(validateAdapterManifest(raw));
  recordConsent('hermes', 'stale-hash-abc123', { file });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask: async () => true, isTTY: true, flags: {},
    });
  } finally {
    cap.restore();
  }

  assert.equal(code, 0);
  const text = cap.text();
  assert.match(text, /stale-hash-abc123/);
  assert.match(text, new RegExp(newHash));
  assert.equal(recordedHashFor('hermes', { file }), newHash);
});

// ── trust: --expect-hash pinning (finding 8) ────────────────────────────
// --yes alone consents to "whatever content the remote serves right now" —
// exactly the wrong thing for an unattended (CI) run. A non-file origin
// under --yes must require an explicit --expect-hash pin.

test('--yes against a non-file origin without --expect-hash fails 2 before any disclosure or recording', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest();
  const cfg = cfgWith([{ name: 'hermes', source: 'https://example.invalid/hermes.json' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => ({ raw, origin: 'url' }),
      ask: neverCalled('ask'), isTTY: true, flags: { yes: true },
    });
  } finally {
    cap.restore();
  }

  assert.equal(code, 2);
  assert.doesNotMatch(cap.text(), /full manifest \(exactly the content being hashed\)/, 'must refuse before disclosure');
  assert.equal(recordedHashFor('hermes', { file }), null);
});

test('--yes against a non-file origin WITH a matching --expect-hash records consent', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest();
  const expectedHash = hashManifest(validateAdapterManifest(raw));
  const cfg = cfgWith([{ name: 'hermes', source: 'https://example.invalid/hermes.json' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => ({ raw, origin: 'url' }),
      ask: neverCalled('ask'), isTTY: false, flags: { yes: true, 'expect-hash': expectedHash },
    });
  } finally {
    cap.restore();
  }

  assert.equal(code, 0, cap.text());
  assert.equal(recordedHashFor('hermes', { file }), expectedHash);
});

test('a mismatched --expect-hash fails 1 and records nothing', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest();
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, ask: neverCalled('ask'), isTTY: true,
      flags: { yes: true, 'expect-hash': 'not-the-real-hash' },
    });
  } finally {
    cap.restore();
  }

  assert.equal(code, 1);
  assert.match(cap.text(), /hash mismatch/);
  assert.equal(recordedHashFor('hermes', { file }), null);
});

test('a file-origin --yes trust with no --expect-hash still works (pin is only required for non-file origins)', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest();
  const expectedHash = hashManifest(validateAdapterManifest(raw));
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => ({ raw, origin: 'file' }), // explicit file semantics
      ask: neverCalled('ask'), isTTY: true, flags: { yes: true },
    });
  } finally {
    cap.restore();
  }

  assert.equal(code, 0, cap.text());
  assert.equal(recordedHashFor('hermes', { file }), expectedHash);
});

// finding 18: a bare-raw reader result (no {raw,origin} wrapper) must default
// to origin 'unknown', NOT 'file' — 'file' was fail-open (it let --yes skip
// the --expect-hash pin for a source that was never actually proven local).
test('a bare-raw reader result defaults to origin unknown, so --yes without --expect-hash now fails 2', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const raw = validManifest();
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', 'hermes'], env: ON_ENV, consent, cfg,
      reader: async () => raw, // bare-raw, unwrapped — origin defaults to 'unknown'
      ask: neverCalled('ask'), isTTY: true, flags: { yes: true },
    });
  } finally {
    cap.restore();
  }

  assert.equal(code, 2);
  assert.match(cap.text(), /non-file origin/);
  assert.equal(recordedHashFor('hermes', { file }), null);
});

// ── revoke ───────────────────────────────────────────────────────────────

test('revoke reports true (existed) when consent was recorded', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  recordConsent('hermes', 'some-hash', { file });
  const cap = capture();
  let code;
  try {
    code = await run({ positionals: ['revoke', 'hermes'], env: ON_ENV, consent, cfg: cfgWith([]), flags: {} });
  } finally { cap.restore(); }
  assert.equal(code, 0);
  assert.match(cap.text(), /revoked/);
  assert.equal(recordedHashFor('hermes', { file }), null);
});

test('revoke reports no recorded consent when none existed', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);
  const cap = capture();
  let code;
  try {
    code = await run({ positionals: ['revoke', 'ghost'], env: ON_ENV, consent, cfg: cfgWith([]), flags: {} });
  } finally { cap.restore(); }
  assert.equal(code, 0);
  assert.match(cap.text(), /no recorded consent/);
});

// ── list states ──────────────────────────────────────────────────────────

test('list reports trusted/stale/not-consented/manifest-error per entry', async () => {
  const file = tmpConsentFile();
  const consent = fileConsent(file);

  const trustedRaw = validManifest({ name: 'trusted-one', host: validHost({ id: 'trusted-one' }) });
  const trustedHash = hashManifest(validateAdapterManifest(trustedRaw));
  recordConsent('trusted-one', trustedHash, { file });

  const staleRaw = validManifest({ name: 'stale-one', host: validHost({ id: 'stale-one' }) });
  recordConsent('stale-one', 'not-the-real-hash', { file });

  const notConsentedRaw = validManifest({ name: 'fresh-one', host: validHost({ id: 'fresh-one' }) });

  const cfg = cfgWith([
    { name: 'trusted-one', source: 'mem://trusted-one' },
    { name: 'stale-one', source: 'mem://stale-one' },
    { name: 'fresh-one', source: 'mem://fresh-one' },
    { name: 'broken-one', source: 'mem://broken-one' },
  ]);

  const reader = async (source) => {
    if (source === 'mem://trusted-one') return trustedRaw;
    if (source === 'mem://stale-one') return staleRaw;
    if (source === 'mem://fresh-one') return notConsentedRaw;
    throw new Error('ENOENT: no such file');
  };

  const cap = capture();
  let code;
  try {
    code = await run({ positionals: ['list'], env: ON_ENV, consent, cfg, reader, flags: {} });
  } finally { cap.restore(); }

  assert.equal(code, 0);
  const text = cap.text();
  assert.match(text, /trusted-one[\s\S]*?trusted/);
  assert.match(text, /stale-one[\s\S]*?consent-stale/);
  assert.match(text, /fresh-one[\s\S]*?not consented/);
  assert.match(text, /broken-one[\s\S]*?manifest error/);
});

test('list with no configured adapters is a friendly no-op', async () => {
  const cap = capture();
  let code;
  try {
    code = await run({ positionals: ['list'], env: ON_ENV, consent: fileConsent(tmpConsentFile()), cfg: cfgWith([]), reader: neverCalled('reader'), flags: {} });
  } finally { cap.restore(); }
  assert.equal(code, 0);
  assert.match(cap.text(), /no host adapters configured/);
});

// ── unknown adapter name / unknown subcommand ───────────────────────────

test('trust of an unknown adapter name fails 1', async () => {
  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['trust', 'nope'], env: ON_ENV, cfg: cfgWith([{ name: 'hermes', source: 'mem://hermes' }]),
      consent: fileConsent(tmpConsentFile()), reader: neverCalled('reader'), ask: neverCalled('ask'), flags: { yes: true },
    });
  } finally { cap.restore(); }
  assert.equal(code, 1);
});

test('unknown subcommand fails with usage, exit 2', async () => {
  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['bogus'], env: ON_ENV, cfg: cfgWith([]),
      consent: fileConsent(tmpConsentFile()), reader: neverCalled('reader'), flags: {},
    });
  } finally { cap.restore(); }
  assert.equal(code, 2);
});

// ── conformance subcommand (ADR-0031 P4) ────────────────────────────────
// Uses the same real acme fixture (tests/fixtures/adapters/acme/) the
// black-box admission report and the tiered-harness unit tests exercise —
// real manifest, real admission, a real spawned subprocess for the declared
// detect and execution.run hooks.

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/adapters/acme');
const ACME_MANIFEST_PATH = path.join(FIXTURE_ROOT, 'manifest.json');
const ACME_PRIMARY_INVALID_PATH = path.join(FIXTURE_ROOT, 'invalid', 'can-be-primary.json');

/** Reads the fixture manifest EXACTLY as authored — no command rewriting.
 * checkAdmission (conformance.mjs) now threads a real baseDir into
 * registerAdmittedLifecycle (Wave C, F1), so the fixture's own literal,
 * unrewritten ["node","detect-hook.mjs"] resolves correctly through the real
 * resolver without any test-side rewrite. */
async function acmeReader(source) {
  const text = fs.readFileSync(source, 'utf8');
  return JSON.parse(text);
}

function tmpGrantsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-conformance-cli-'));
  return path.join(dir, 'adapter-grants.json');
}

test('conformance: flag unset refuses with exit 2 and never calls runTiered', async () => {
  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['conformance', 'acme'], env: OFF_ENV, cfg: cfgWith([{ name: 'acme', source: ACME_MANIFEST_PATH }]),
      runTieredConformance: neverCalled('runTieredConformance'), flags: {},
    });
  } finally { cap.restore(); }
  assert.equal(code, 2);
});

test('conformance: usage error (no name) exits 2 without running the harness', async () => {
  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['conformance'], env: ON_ENV, cfg: cfgWith([]),
      runTieredConformance: neverCalled('runTieredConformance'), flags: {},
    });
  } finally { cap.restore(); }
  assert.equal(code, 2);
});

test('conformance: unknown adapter name exits 1 without running the harness', async () => {
  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['conformance', 'nope'], env: ON_ENV, cfg: cfgWith([{ name: 'acme', source: ACME_MANIFEST_PATH }]),
      runTieredConformance: neverCalled('runTieredConformance'), flags: {},
    });
  } finally { cap.restore(); }
  assert.equal(code, 1);
});

test('conformance: happy path against the real acme fixture prints a per-tier table, records into the grant store, and exits 0', async () => {
  const grantsFile = tmpGrantsFile();
  const cfg = cfgWith([{ name: 'acme', source: ACME_MANIFEST_PATH }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['conformance', 'acme'], env: ON_ENV, cfg,
      reader: acmeReader, grantsFile, flags: {},
      // acme's detection.bin will never actually be on a test machine's
      // PATH — orthogonal to what this test proves (the CLI's plumbing:
      // printing, recording, exit codes), so readiness is stubbed the same
      // way the tiered-harness unit tests do.
      runTieredConformance: (opts) => runTieredConformance({ ...opts, haveFn: async () => true }),
    });
  } finally { cap.restore(); }

  assert.equal(code, 0, cap.text());
  const text = cap.text();
  // F6 (Wave C security review): a warning banner discloses the real
  // subprocess hooks about to run, and it prints BEFORE the report header —
  // the operator sees what will spawn before it does.
  assert.match(text, /SELF-TEST \(ADR-0031 §5\)/);
  assert.match(text, /needs no prior 'ak host adapters trust'/);
  assert.match(text, /lifecycle\.detect: \["node","detect-hook\.mjs"\]/);
  assert.match(text, /execution\.run: \["node","run-hook\.mjs"\]/);
  assert.ok(text.indexOf('SELF-TEST') < text.indexOf('host adapter conformance — acme'), 'the disclosure banner must print before the report');

  assert.match(text, /host adapter conformance — acme/);
  assert.match(text, /admission\s+passed/);
  assert.match(text, /activity-routing\s+passed/);
  assert.match(text, /session-driving\s+skipped/);
  assert.match(text, /primary-eligible\s+gated/);
  assert.match(text, /statusline\s+gated/);

  const record = grantsFor('acme', { file: grantsFile });
  assert.equal(record.tiers.admission.status, 'passed');
  assert.equal(record.tiers['activity-routing'].status, 'passed');
});

test('conformance: nothing is recorded when the flag is off, even with a real cfg entry and grantsFile supplied', async () => {
  const grantsFile = tmpGrantsFile();
  const cfg = cfgWith([{ name: 'acme', source: ACME_MANIFEST_PATH }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['conformance', 'acme'], env: OFF_ENV, cfg,
      reader: acmeReader, grantsFile, flags: {},
    });
  } finally { cap.restore(); }

  assert.equal(code, 2);
  assert.equal(grantsFor('acme', { file: grantsFile }), null);
});

test('conformance: a failing admission tier prints failed, exits 1, and records nothing', async () => {
  const grantsFile = tmpGrantsFile();
  const cfg = cfgWith([{ name: 'acme-primary', source: ACME_PRIMARY_INVALID_PATH }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['conformance', 'acme-primary'], env: ON_ENV, cfg,
      reader: async (source) => JSON.parse(fs.readFileSync(source, 'utf8')),
      grantsFile, flags: {},
    });
  } finally { cap.restore(); }

  assert.equal(code, 1, cap.text());
  assert.match(cap.text(), /admission\s+failed/);
  assert.equal(grantsFor('acme-primary', { file: grantsFile }), null);
});

// ── F6: the disclosure banner degrades honestly (no hooks / unreadable) ────

test('conformance: the banner reports "nothing will be spawned" for a manifest declaring no lifecycle/execution hooks', async () => {
  const raw = validManifest({ lifecycle: {} });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes-no-hooks' }]);

  const cap = capture();
  try {
    await run({
      positionals: ['conformance', 'hermes'], env: ON_ENV, cfg,
      reader: async () => raw, grantsFile: tmpGrantsFile(), flags: {},
    });
  } finally { cap.restore(); }

  const text = cap.text();
  assert.match(text, /SELF-TEST \(ADR-0031 §5\)/);
  assert.match(text, /declares no lifecycle\/execution hooks — nothing will be spawned/);
});

test('conformance: the banner falls back to a generic warning when the manifest cannot be pre-disclosed, and the harness still runs and reports the real failure', async () => {
  const grantsFile = tmpGrantsFile();
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes-unreadable' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['conformance', 'hermes'], env: ON_ENV, cfg,
      reader: async () => { throw new Error('boom: source unreadable'); },
      grantsFile, flags: {},
    });
  } finally { cap.restore(); }

  const text = cap.text();
  assert.match(text, /SELF-TEST \(ADR-0031 §5\)/);
  assert.match(text, /could not be pre-disclosed here/);
  assert.match(text, /admission\s+failed/);
  assert.equal(code, 1);
  assert.equal(grantsFor('hermes', { file: grantsFile }), null);
});

// N-1 (Wave C security review): JSON.stringify escapes C0 (0x00-0x1F) but
// leaves C1 (0x80-0x9F, e.g. U+009B CSI) and DEL (0x7F) untouched — a hook
// command carrying one of those bytes must never reach the disclosure line
// raw, the same class F3 already closed for the tier-detail line.
test('conformance: the banner strips a raw C1 byte (U+009B, CSI) out of a hook command before printing it', async () => {
  const CSI = String.fromCharCode(0x9b);
  const raw = validManifest({
    lifecycle: { detect: { hook: { command: ['hermes', `detect${CSI}payload`], timeoutMs: 5000 } } },
  });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes-hostile-hook' }]);

  const cap = capture();
  try {
    await run({
      positionals: ['conformance', 'hermes'], env: ON_ENV, cfg,
      reader: async () => raw, grantsFile: tmpGrantsFile(), flags: {},
    });
  } finally { cap.restore(); }

  const text = cap.text();
  assert.ok(!text.includes(CSI), 'no raw C1 control character may reach the disclosure output');
  assert.match(text, /detectpayload/, 'the C1 byte is removed outright, the surrounding text survives');
});

// ── grant / bless (ADR-0031 P5) ─────────────────────────────────────────
// grant's disclosure now also derives the manifest trust state (F-3), so
// every test that reaches loadAndHash passes an isolated `consent` store —
// never the real default consentStore — to stay hermetic.

test('grant: happy path — capability granted once the gating tier is force-recorded passed at the current hash', async () => {
  const grantsFile = tmpGrantsFile();
  const raw = validManifest();
  const hash = hashManifest(validateAdapterManifest(raw));
  recordTierResult('hermes', 'primary-eligible', { hash, evidence: 'leads a run, receives escalation' }, { file: grantsFile });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['grant', 'hermes', 'canBePrimary'], env: ON_ENV, cfg,
      reader: async () => raw, ask: async () => true, isTTY: true, grantsFile, flags: {},
      consent: fileConsent(tmpConsentFile()),
    });
  } finally { cap.restore(); }

  assert.equal(code, 0, cap.text());
  assert.match(cap.text(), /granted 'canBePrimary'/);
  // F-3: the disclosure prints the actual evidence backing the tier, not
  // just a hash, and the F-7 honesty note that the grant is not yet live.
  assert.match(cap.text(), /tier evidence:\s+leads a run, receives escalation/);
  assert.match(cap.text(), /not yet live/);
  assert.deepEqual(grantedCapabilitiesFor('hermes', hash, { file: grantsFile }), { canBePrimary: true });
});

// N-1 (security re-review): grant must resolve the manifest source EXACTLY
// ONCE. Previously the disclosure's trust-state line called stateFor, which
// ran its own independent loadAndHash — on a mutable remote source a second
// resolve could return different bytes than the first, so the disclosed
// trust state could describe content that was never the granted content.
// This reader returns different content on any call after the first; if
// grant ever resolved twice, the trust-state line would be computed against
// `secondRaw` while the granted hash is `firstRaw`'s — a display-integrity
// bug on the highest-privilege command.
test('grant: resolves the manifest exactly once, and the disclosed trust state describes the ACTUAL granted hash even when a second resolve would differ', async () => {
  const grantsFile = tmpGrantsFile();
  const firstRaw = validManifest();
  const secondRaw = validManifest({ version: '9.9.9' }); // different content/hash
  const firstHash = hashManifest(validateAdapterManifest(firstRaw));
  recordTierResult('hermes', 'primary-eligible', { hash: firstHash, evidence: 'leads a run' }, { file: grantsFile });

  const consentFile = tmpConsentFile();
  recordConsent('hermes', firstHash, { file: consentFile }); // consent pinned to the FIRST hash

  let calls = 0;
  const reader = async () => { calls += 1; return calls === 1 ? firstRaw : secondRaw; };
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['grant', 'hermes', 'canBePrimary'], env: ON_ENV, cfg,
      reader, ask: async () => true, isTTY: true, grantsFile, flags: {},
      consent: fileConsent(consentFile),
    });
  } finally { cap.restore(); }

  assert.equal(code, 0, cap.text());
  assert.equal(calls, 1, 'the manifest source must be resolved exactly once, not once for the grant and again for the trust-state line');
  // If grant had resolved twice, the trust state would be computed against
  // secondRaw's hash (which the consent store never recorded) and show
  // 'not consented' or 'consent-stale' instead of 'trusted'.
  assert.match(cap.text(), /manifest trust state: trusted/);
  assert.match(cap.text(), new RegExp(`manifest hash: ${firstHash}`));
  assert.deepEqual(grantedCapabilitiesFor('hermes', firstHash, { file: grantsFile }), { canBePrimary: true });
});

test('grant: `bless` is an accepted alias for `grant`', async () => {
  const grantsFile = tmpGrantsFile();
  const raw = validManifest();
  const hash = hashManifest(validateAdapterManifest(raw));
  recordTierResult('hermes', 'statusline', { hash, evidence: 'footer renders' }, { file: grantsFile });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['bless', 'hermes', 'commandStatusline'], env: ON_ENV, cfg,
      reader: async () => raw, ask: async () => true, isTTY: true, grantsFile, flags: {},
      consent: fileConsent(tmpConsentFile()),
    });
  } finally { cap.restore(); }

  assert.equal(code, 0, cap.text());
  assert.deepEqual(grantedCapabilitiesFor('hermes', hash, { file: grantsFile }), { commandStatusline: true });
});

test('grant: REFUSED when the gating tier is not recorded passed — exit 1, nothing granted, names the tier', async () => {
  const grantsFile = tmpGrantsFile();
  const raw = validManifest();
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['grant', 'hermes', 'canBePrimary'], env: ON_ENV, cfg,
      reader: async () => raw, ask: neverCalled('ask'), isTTY: true, grantsFile, flags: { yes: true },
      consent: fileConsent(tmpConsentFile()),
    });
  } finally { cap.restore(); }

  assert.equal(code, 1);
  assert.match(cap.text(), /primary-eligible/);
  const hash = hashManifest(validateAdapterManifest(raw));
  assert.deepEqual(grantedCapabilitiesFor('hermes', hash, { file: grantsFile }), {});
});

test("grant: 'aqeProvider' is rejected as never ak-grantable (ADR-0031 §4), before any manifest read", async () => {
  const grantsFile = tmpGrantsFile();
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['grant', 'hermes', 'aqeProvider'], env: ON_ENV, cfg,
      reader: neverCalled('reader'), ask: neverCalled('ask'), isTTY: true, grantsFile, flags: { yes: true },
    });
  } finally { cap.restore(); }

  assert.equal(code, 1);
  assert.match(cap.text(), /upstream-owned/);
  assert.match(cap.text(), /ADR-0031 §4/);
});

test('grant: any other non-TIER_GRANTS capability is rejected, before any manifest read', async () => {
  const grantsFile = tmpGrantsFile();
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['grant', 'hermes', 'transcripts'], env: ON_ENV, cfg,
      reader: neverCalled('reader'), ask: neverCalled('ask'), isTTY: true, grantsFile, flags: { yes: true },
    });
  } finally { cap.restore(); }

  assert.equal(code, 1);
  assert.match(cap.text(), /not a grantable capability/);
});

test('grant: refuses when the manifest changed since the tier was recorded passed (hash mismatch)', async () => {
  const grantsFile = tmpGrantsFile();
  const originalRaw = validManifest();
  const originalHash = hashManifest(validateAdapterManifest(originalRaw));
  recordTierResult('hermes', 'primary-eligible', { hash: originalHash, evidence: 'ev' }, { file: grantsFile });

  const editedRaw = validManifest({ version: '1.0.1' }); // edited since the tier passed -> new hash
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['grant', 'hermes', 'canBePrimary'], env: ON_ENV, cfg,
      reader: async () => editedRaw, ask: neverCalled('ask'), isTTY: true, grantsFile, flags: { yes: true },
      consent: fileConsent(tmpConsentFile()),
    });
  } finally { cap.restore(); }

  assert.equal(code, 1);
  assert.match(cap.text(), /no passed 'primary-eligible' tier recorded at hash/);
  const editedHash = hashManifest(validateAdapterManifest(editedRaw));
  assert.deepEqual(grantedCapabilitiesFor('hermes', editedHash, { file: grantsFile }), {});
});

test('grant: non-interactive without --yes fails 2 before writing, even with a passed tier available', async () => {
  const grantsFile = tmpGrantsFile();
  const raw = validManifest();
  const hash = hashManifest(validateAdapterManifest(raw));
  recordTierResult('hermes', 'statusline', { hash, evidence: 'footer renders' }, { file: grantsFile });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['grant', 'hermes', 'commandStatusline'], env: ON_ENV, cfg,
      reader: async () => raw, ask: neverCalled('ask'), isTTY: false, grantsFile, flags: {},
      consent: fileConsent(tmpConsentFile()),
    });
  } finally { cap.restore(); }

  assert.equal(code, 2);
  assert.deepEqual(grantedCapabilitiesFor('hermes', hash, { file: grantsFile }), {});
});

test('grant: a declined interactive confirmation leaves the grant unchanged, exit 0', async () => {
  const grantsFile = tmpGrantsFile();
  const raw = validManifest();
  const hash = hashManifest(validateAdapterManifest(raw));
  recordTierResult('hermes', 'statusline', { hash, evidence: 'footer renders' }, { file: grantsFile });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['grant', 'hermes', 'commandStatusline'], env: ON_ENV, cfg,
      reader: async () => raw, ask: async () => false, isTTY: true, grantsFile, flags: {},
      consent: fileConsent(tmpConsentFile()),
    });
  } finally { cap.restore(); }

  assert.equal(code, 0);
  assert.deepEqual(grantedCapabilitiesFor('hermes', hash, { file: grantsFile }), {});
});

test('grant: ignores an exercise-shaped extra option — a capability is never conferred by a caller-supplied exercise result', async () => {
  const grantsFile = tmpGrantsFile();
  const raw = validManifest();
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['grant', 'hermes', 'canBePrimary'], env: ON_ENV, cfg,
      reader: async () => raw, ask: neverCalled('ask'), isTTY: true, grantsFile, flags: { yes: true },
      consent: fileConsent(tmpConsentFile()),
      // No such input exists on run()'s contract; if it were ever wired
      // through, this would be exactly the security-review-forbidden shape
      // (a caller-supplied exercise result standing in as both the pass and
      // its own evidence). It must be silently inert.
      exercise: async () => ({ status: 'passed' }),
    });
  } finally { cap.restore(); }

  assert.equal(code, 1, 'no passed tier was ever actually recorded, so the grant must still be refused');
});

// ── gate (ADR-0031 P7) ───────────────────────────────────────────────────

test('gate: records a valid <repo>#NNN ref at the current manifest hash', async () => {
  const grantsFile = tmpGrantsFile();
  const raw = validManifest();
  const hash = hashManifest(validateAdapterManifest(raw));
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['gate', 'hermes', 'primary-eligible', 'ruvnet/ruflo#2962'], env: ON_ENV, cfg,
      reader: async () => raw, grantsFile, flags: {},
    });
  } finally { cap.restore(); }

  assert.equal(code, 0, cap.text());
  assert.match(cap.text(), /gated on ruvnet\/ruflo#2962/);
  const record = grantsFor('hermes', { file: grantsFile, currentHash: hash });
  assert.equal(record.tiers['primary-eligible'].status, 'gated');
  assert.equal(record.tiers['primary-eligible'].gatedBy, 'ruvnet/ruflo#2962');
});

test('gate: rejects a malformed ref — recordTierGate throws, surfaced honestly, exit 1, nothing recorded', async () => {
  const grantsFile = tmpGrantsFile();
  const raw = validManifest();
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['gate', 'hermes', 'primary-eligible', 'not-a-valid-ref'], env: ON_ENV, cfg,
      reader: async () => raw, grantsFile, flags: {},
    });
  } finally { cap.restore(); }

  assert.equal(code, 1);
  assert.match(cap.text(), /gate refused/);
  assert.equal(grantsFor('hermes', { file: grantsFile }), null);
});

test('gate: rejects a tier not in CONFORMANCE_TIERS before ever touching the manifest', async () => {
  const grantsFile = tmpGrantsFile();
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['gate', 'hermes', 'bogus-tier', 'agentic-qe#563'], env: ON_ENV, cfg,
      reader: neverCalled('reader'), grantsFile, flags: {},
    });
  } finally { cap.restore(); }

  assert.equal(code, 1);
  assert.match(cap.text(), /not a valid conformance tier/);
});

// ── status (ADR-0031 P7 display) ────────────────────────────────────────

test('status: shows passed tiers, gated tiers, and granted capabilities, then marks it all STALE after a manifest edit', async () => {
  const grantsFile = tmpGrantsFile();
  const raw = validManifest();
  const hash = hashManifest(validateAdapterManifest(raw));
  recordTierResult('hermes', 'admission', { hash, evidence: 'admits' }, { file: grantsFile });
  recordTierResult('hermes', 'statusline', { hash, evidence: 'footer renders' }, { file: grantsFile });
  grantCapability('hermes', 'commandStatusline', { hash }, { file: grantsFile });
  recordTierGate('hermes', 'primary-eligible', { hash, gatedBy: 'ruvnet/ruflo#2962' }, { file: grantsFile });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);

  let cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['status', 'hermes'], env: ON_ENV, cfg,
      reader: async () => raw, grantsFile, flags: {},
    });
  } finally { cap.restore(); }

  assert.equal(code, 0, cap.text());
  let text = cap.text();
  assert.match(text, /passed tiers:/);
  assert.match(text, /admission/);
  assert.match(text, /statusline/);
  assert.match(text, /gated tiers \(waiting on upstream\):/);
  assert.match(text, /primary-eligible -> ruvnet\/ruflo#2962/);
  assert.match(text, /granted capabilities: commandStatusline/);
  assert.doesNotMatch(text, /STALE/);

  // Edit the manifest — the hash changes, so every prior tier result and
  // granted capability must render as void, not silently vanish.
  const editedRaw = validManifest({ version: '9.9.9' });
  cap = capture();
  try {
    code = await run({
      positionals: ['status', 'hermes'], env: ON_ENV, cfg,
      reader: async () => editedRaw, grantsFile, flags: {},
    });
  } finally { cap.restore(); }

  assert.equal(code, 0, cap.text());
  text = cap.text();
  assert.match(text, /STALE/);
  assert.match(text, /gated tiers: \(none\)/, 'a stale record voids gated-tier visibility too');
  assert.match(text, /granted capabilities: \(none\)/, 'a stale record voids granted capabilities');
});

test('status: with no <name> summarizes every configured adapter', async () => {
  const grantsFile = tmpGrantsFile();
  const rawHermes = validManifest({ name: 'hermes', host: validHost({ id: 'hermes' }) });
  const rawAtlas = validManifest({ name: 'atlas', host: validHost({ id: 'atlas' }) });
  const cfg = cfgWith([
    { name: 'hermes', source: 'mem://hermes' },
    { name: 'atlas', source: 'mem://atlas' },
  ]);
  const reader = async (source) => (source === 'mem://hermes' ? rawHermes : rawAtlas);

  const cap = capture();
  let code;
  try {
    code = await run({ positionals: ['status'], env: ON_ENV, cfg, reader, grantsFile, flags: {} });
  } finally { cap.restore(); }

  assert.equal(code, 0);
  const text = cap.text();
  assert.match(text, /host adapter status — hermes/);
  assert.match(text, /host adapter status — atlas/);
});

test('status: an unknown adapter name fails 1', async () => {
  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['status', 'nope'], env: ON_ENV, cfg: cfgWith([{ name: 'hermes', source: 'mem://hermes' }]),
      reader: neverCalled('reader'), grantsFile: tmpGrantsFile(), flags: {},
    });
  } finally { cap.restore(); }
  assert.equal(code, 1);
});

// ── flag-off for grant/gate/status: exit 2, nothing written ─────────────

test('grant/bless/gate/status all refuse with exit 2 when the flag is off, and write nothing', async () => {
  const grantsFile = tmpGrantsFile();
  const raw = validManifest();
  const hash = hashManifest(validateAdapterManifest(raw));
  recordTierResult('hermes', 'primary-eligible', { hash, evidence: 'ev' }, { file: grantsFile });
  const cfg = cfgWith([{ name: 'hermes', source: 'mem://hermes' }]);
  const reader = neverCalled('reader');

  for (const positionals of [
    ['grant', 'hermes', 'canBePrimary'],
    ['bless', 'hermes', 'canBePrimary'],
    ['gate', 'hermes', 'primary-eligible', 'agentic-qe#563'],
    ['status', 'hermes'],
    ['status'],
  ]) {
    const cap = capture();
    let code;
    try {
      code = await run({ positionals, env: OFF_ENV, cfg, reader, grantsFile, flags: { yes: true } });
    } finally { cap.restore(); }
    assert.equal(code, 2, `positionals=${JSON.stringify(positionals)}`);
  }

  assert.deepEqual(grantedCapabilitiesFor('hermes', hash, { file: grantsFile }), {});
});

// ── revoke-grant ─────────────────────────────────────────────────────────

test('revoke-grant works even when the experimental flag is off (fail-safe), and only touches the grants store', async () => {
  const grantsFile = tmpGrantsFile();
  const raw = validManifest();
  const hash = hashManifest(validateAdapterManifest(raw));
  recordTierResult('hermes', 'admission', { hash, evidence: 'ev' }, { file: grantsFile });

  const file = tmpConsentFile();
  const consent = fileConsent(file);
  recordConsent('hermes', hash, { file });

  const cap = capture();
  let code;
  try {
    code = await run({
      positionals: ['revoke-grant', 'hermes'], env: OFF_ENV, cfg: cfgWith([]), consent, grantsFile, flags: {},
    });
  } finally { cap.restore(); }

  assert.equal(code, 0);
  assert.match(cap.text(), /revoked all conformance evidence and grants/);
  assert.equal(grantsFor('hermes', { file: grantsFile }), null);
  // revoke-grant must never touch the separate consent (trust) store.
  assert.equal(recordedHashFor('hermes', { file }), hash);
});

test('revoke-grant reports no recorded grants when none existed', async () => {
  const grantsFile = tmpGrantsFile();
  const cap = capture();
  let code;
  try {
    code = await run({ positionals: ['revoke-grant', 'ghost'], env: ON_ENV, cfg: cfgWith([]), grantsFile, flags: {} });
  } finally { cap.restore(); }
  assert.equal(code, 0);
  assert.match(cap.text(), /no recorded grants/);
});

// ── no exercise/callback surface anywhere in the new commands ───────────

test('the grant/gate/status implementation never destructures or forwards an exercise/callback parameter', () => {
  const grantsSrcPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/commands/x/host-adapters-grants.mjs');
  const hostAdaptersSrcPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/commands/x/host-adapters.mjs');
  const grantsSrc = fs.readFileSync(grantsSrcPath, 'utf8');
  const hostAdaptersSrc = fs.readFileSync(hostAdaptersSrcPath, 'utf8');
  // Real code destructuring/forwarding a parameter reads as `exercise,`,
  // `exercise:`, or `exercise }` — distinct from this constraint's own prose
  // ("exercising a path", "'exercise'/callback option"), which never follows
  // the word with one of those three characters.
  const PARAM_SHAPE = /\bexercise\s*[,:}]/;
  assert.doesNotMatch(grantsSrc, PARAM_SHAPE, 'host-adapters-grants.mjs must never destructure/forward an exercise parameter');
  assert.doesNotMatch(hostAdaptersSrc, PARAM_SHAPE, 'host-adapters.mjs must never destructure/forward an exercise parameter into grant/gate');
});
