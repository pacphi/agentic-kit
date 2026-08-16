import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_IDS, adapterFor, drivingHost, hostTierLabel, hostAsymmetryNote } from '../../src/lib/hosts.mjs';
import { hostAuthState } from '../../src/lib/providers.mjs';
import { managedHostIds } from '../../src/lib/adapters/registries.mjs';
import { applyAdmitted, resetAdmitted, effectivePrimaryHostIds } from '../../src/lib/adapters/admitted.mjs';

// ── HOST_ADAPTERS descriptors ────────────────────────────────────────────────
// HOST_IDS is HOST_ADAPTERS' key order (hosts.mjs filters HOST_REGISTRY by
// canDriveSession and preserves registry order) — this proves that mirror,
// not the exact built-in set (adapter-registries.test.mjs pins the full
// HOST_REGISTRY contents deep-equal; that's where the shipped-set literal lives).
test('HOST_ADAPTERS keys mirror the registry-derived managed host ids, in order', () => {
  assert.deepEqual(HOST_IDS, managedHostIds());
});

test('claude adapter targets CLAUDE.md/json and supports a statusline', () => {
  const a = adapterFor('claude');
  assert.equal(a.guidanceFile, 'claude');
  assert.equal(a.configFormat, 'json');
  assert.equal(a.aqeProvider, 'claude-code');
});

test('codex adapter targets AGENTS.md/toml and has NO command-backed statusline', () => {
  const a = adapterFor('codex');
  assert.equal(a.guidanceFile, 'agents');
  assert.equal(a.configFormat, 'toml');
  assert.deepEqual(a.statusline, { mode: 'builtin', scope: 'user', customCommand: false, multiline: false });
  assert.equal(a.aqeProvider, 'codex');
});

test('opencode adapter targets its own AGENTS.md/json, no statusline, no aqe provider, no session env markers', () => {
  const a = adapterFor('opencode');
  assert.equal(a.guidanceFile, 'agents-opencode');
  assert.equal(a.configFormat, 'json');
  assert.equal(a.aqeProvider, null);
  assert.deepEqual(a.envMarkers, []);
});

test('adapterFor returns null for an unknown host', () => {
  assert.equal(adapterFor('zz-not-a-registered-host'), null);
});

// ── drivingHost detection (env-only, deterministic) ──────────────────────────
test('drivingHost honors an explicit AK_DRIVING_HOST override', () => {
  assert.equal(drivingHost({ AK_DRIVING_HOST: 'codex', CLAUDECODE: '1' }), 'codex');
});

test('drivingHost ignores an invalid override and falls through', () => {
  assert.equal(drivingHost({ AK_DRIVING_HOST: 'bogus', CLAUDECODE: '1' }), 'claude');
});

test('drivingHost detects claude from CLAUDECODE marker', () => {
  assert.equal(drivingHost({ CLAUDECODE: '1' }), 'claude');
});

test('drivingHost detects codex from a CODEX_* marker', () => {
  assert.equal(drivingHost({ CODEX_SANDBOX: 'workspace-write' }), 'codex');
});

test('drivingHost falls back to the configured primary host', () => {
  assert.equal(drivingHost({}, { routing: { primaryHost: 'codex' } }), 'codex');
});

test('drivingHost rejects a non-primary-capable host from hand-edited config', () => {
  assert.equal(drivingHost({}, { routing: { primaryHost: 'opencode' } }), 'claude');
});

test('drivingHost defaults to claude with no signal', () => {
  assert.equal(drivingHost({}), 'claude');
});

// ── D2 keystone (ADR-0031 §1), F-3-hardened: drivingHost's ELIGIBILITY check
// reads the EFFECTIVE (grant-overlaid) registry, not HOST_REGISTRY directly —
// that primitive is live even for an admitted external host. But eligibility
// alone is not enough to RETURN the host: HOST_ADAPTERS (this module's own
// session-driving descriptors — guidanceFile, statusline, envMarkers) stays
// built-in-only, so an admitted external host — however eligible, however
// granted — has nothing here to resolve adapterFor() against. drivingHost()
// must fall back to 'claude' rather than return an id a caller's
// `adapterFor(drivingHost(...)).guidanceFile` would crash on.
test('drivingHost recognizes a granted external host as eligible, but still falls back to claude (no HOST_ADAPTERS descriptor to resolve it)', (t) => {
  t.after(() => resetAdmitted());
  applyAdmitted([{
    entry: {
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
    },
  }], { grantsByName: { hermes: { canBePrimary: true } } });
  assert.ok(effectivePrimaryHostIds().includes('hermes'), 'sanity: the eligibility primitive DOES see the grant');
  assert.equal(adapterFor('hermes'), null, 'sanity: this module has no session-driving descriptor for it');
  assert.equal(drivingHost({}, { routing: { primaryHost: 'hermes' } }), 'claude',
    'eligible-but-unresolvable must never be returned — falls back to claude, never crashes a caller downstream');
});

test('drivingHost also falls back to claude for the same external host before it is granted canBePrimary', (t) => {
  t.after(() => resetAdmitted());
  applyAdmitted([{
    entry: {
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
    },
  }]); // no grantsByName
  assert.equal(drivingHost({}, { routing: { primaryHost: 'hermes' } }), 'claude');
});

// ── hostAuthState (billing axis) ─────────────────────────────────────────────
test('hostAuthState reports api-key/metered when the key env is set (codex)', () => {
  const a = hostAuthState('codex', { env: { OPENAI_API_KEY: 'sk-x' }, present: true });
  assert.equal(a.mode, 'api-key');
  assert.equal(a.billing, 'metered');
  assert.equal(a.source, 'OPENAI_API_KEY');
});

test('hostAuthState reports api-key/metered when the key env is set (claude)', () => {
  const a = hostAuthState('claude', { env: { ANTHROPIC_API_KEY: 'sk-x' }, present: true });
  assert.equal(a.mode, 'api-key');
  assert.equal(a.billing, 'metered');
});

test('hostAuthState infers oauth/subscription for a present claude with no key', () => {
  const a = hostAuthState('claude', { env: {}, present: true });
  assert.equal(a.mode, 'oauth');
  assert.equal(a.billing, 'subscription');
});

test('hostAuthState reports none for an absent claude with no key', () => {
  // home must point at an EMPTY dir: on a real machine with file-based claude
  // credentials (~/.claude/.credentials.json present, e.g. Linux installs), the
  // login-file probe legitimately wins and this test flaked 'oauth'.
  const a = hostAuthState('claude', { env: {}, present: false, home: fs.mkdtempSync(path.join(os.tmpdir(), 'ak-nohome-')) });
  assert.equal(a.mode, 'none');
});

test('hostAuthState returns unknown for an unrecognized host', () => {
  const a = hostAuthState('zz-not-a-registered-host', { env: {}, present: true });
  assert.equal(a.mode, 'unknown');
});

// ── hostTierLabel / hostAsymmetryNote (D-2, F-25/F-26) ───────────────────────
// Pins for the three built-in hosts — the derivation must reproduce (or
// deliberately improve on, per the case-by-case call below) what x/host.mjs's
// status() prints today. Nothing in the suite pinned the OLD literal text
// ('· routing host', '· routing host (ak run; never primary/AQE)') before
// this change, so these values are the new baseline going forward.
test('hostTierLabel: claude (canBePrimary) reads "drives sessions · can lead"', () => {
  assert.equal(hostTierLabel('claude'), 'drives sessions · can lead');
});

test('hostTierLabel: codex (canBePrimary) reads "drives sessions · can lead"', () => {
  assert.equal(hostTierLabel('codex'), 'drives sessions · can lead');
});

test('hostTierLabel: opencode (routing-only, built-in, no aqeProvider) reads "routing only · supervised · not AQE"', () => {
  assert.equal(hostTierLabel('opencode'), 'routing only · supervised · not AQE');
});

test('hostTierLabel returns empty for an unknown host id', () => {
  assert.equal(hostTierLabel('zz-not-a-registered-host'), '');
});

test('hostTierLabel: a synthetic canDriveSession-only host (no primary, no routing) reads "drives sessions"', () => {
  const synthetic = {
    id: 'synth-drive-only',
    capabilities: { canDriveSession: true, canBePrimary: false, canRouteActivities: false },
    legacy: {},
  };
  assert.equal(hostTierLabel(synthetic), 'drives sessions');
});

test('hostTierLabel: a synthetic non-built-in routing-only host reads "routing only · external adapter · not AQE"', () => {
  const synthetic = {
    id: 'synth-external',
    capabilities: { canDriveSession: true, canBePrimary: false, canRouteActivities: true },
    legacy: {},
    trust: { changes: [] },
  };
  // Not in HOST_REGISTRY (the default `builtins`), so it derives as external —
  // proving the tier follows capabilities + registry membership, not an id.
  assert.equal(hostTierLabel(synthetic), 'routing only · external adapter · not AQE');
});

test('hostTierLabel: a host with no session-driving capability at all yields no tier', () => {
  assert.equal(hostTierLabel({ id: 'nd', capabilities: { canDriveSession: false } }), '');
});

test('hostAsymmetryNote: claude has nothing asymmetric to state', () => {
  assert.equal(hostAsymmetryNote('claude'), '');
});

test('hostAsymmetryNote: codex states the MCP bridge grant, read off its own trust manifest', () => {
  assert.equal(
    hostAsymmetryNote('codex'),
    'expose Codex to Claude Code as mcp__codex__codex in this project',
  );
});

test('hostAsymmetryNote: opencode states its consent boundary and the absent ruflo backend flag', () => {
  assert.equal(
    hostAsymmetryNote('opencode'),
    'consent boundary — a run can block on a permission event (never auto-approved); no ruflo backend env flag',
  );
});
