// One vocabulary for whether ak manages a host (ADR-0053, 2026-09-26 amendment).
// "Managed" is persisted intent in kit.json, never a health verdict; every
// surface (status rows, ak host status, ak about, the dashboard) renders these
// exact words, so they are pinned here once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_MANAGEMENT_LABELS, hostManagement, enabledHostIds, hostEnableCommand,
} from '../../src/lib/host-management.mjs';

test('three management states read the same words everywhere', () => {
  assert.deepEqual(hostManagement({ enabled: true, present: true }), { state: 'managed', label: 'Managed by ak' });
  assert.deepEqual(hostManagement({ enabled: true, present: false }), { state: 'managed', label: 'Managed by ak' },
    'an enabled host that is missing is still managed: sync installs it');
  assert.deepEqual(hostManagement({ enabled: false, present: true }), { state: 'found', label: 'Found, not managed' });
  assert.deepEqual(hostManagement({ enabled: false, present: false }), { state: 'not-installed', label: 'Not installed' });
});

test('unestablished presence on an unmanaged host claims neither found nor absent', () => {
  for (const present of [undefined, null, 'unknown']) {
    assert.deepEqual(hostManagement({ enabled: false, present }), { state: 'unassessed', label: 'Not managed' });
  }
  assert.equal(HOST_MANAGEMENT_LABELS.unassessed, 'Not managed');
});

test('enabled means exactly what pick --host reads as the current set', () => {
  assert.deepEqual(enabledHostIds({ integrations: { hosts: { claude: true, codex: false, opencode: true } } }), ['claude', 'opencode']);
  assert.deepEqual(enabledHostIds({}), []);
});

test('an id the host registry does not know is not an enabled host', () => {
  const cfg = { integrations: { hosts: { claude: true, hermes: true } } };
  assert.deepEqual(enabledHostIds(cfg), ['claude']);
});

test('the enable hint is the complete host list, so running it never disables another host', () => {
  const cfg = (hosts) => ({ integrations: { hosts } });
  assert.equal(hostEnableCommand(cfg({ claude: true, codex: false, opencode: false }), 'codex'), 'ak host pick --host claude,codex');
  // The old hard-coded "--host claude,opencode" hint would have disabled codex here.
  assert.equal(hostEnableCommand(cfg({ claude: true, codex: true, opencode: false }), 'opencode'), 'ak host pick --host claude,codex,opencode');
  assert.equal(hostEnableCommand(cfg({ claude: false, codex: true, opencode: false }), 'claude'), 'ak host pick --host claude,codex');
  // A key for an id the host registry does not know is not a host: pick rejects it, so the hint omits it.
  assert.equal(hostEnableCommand(cfg({ claude: true, gizmo: true }), 'codex'), 'ak host pick --host claude,codex');
  assert.equal(hostEnableCommand(cfg({}), 'codex'), 'ak host pick --host codex');
  assert.equal(hostEnableCommand(cfg({ claude: true, codex: true }), 'codex'), 'ak host pick --host claude,codex', 'no duplicate for an enabled host');
});
