// the providers section's hostManagementRows() stops
// calling have(h.bin) for every non-enabled host — providers.mjs's
// detectHosts() (via collectIntegrationFacts, already backed by the
// evidence cache) already answers the exact same "is this host's bin on PATH"
// question once per collect(), for every host regardless of enablement, so
// reusing integrationFacts.hosts[h.id].present removes a duplicate probe of
// the identical fact rather than adding a second evidence kind for it.
//
// have() is not injectable here, so PATH is broken to make a REAL probe
// deterministically return false/absent — proving which path ran: reusing
// integrationFacts (which may say `present: true` despite the broken PATH)
// vs falling back to a real have() call (which can only ever see false here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import providersStatusSection from '../../src/commands/status/sections/providers-status.mjs';

const cfg = () => ({
  integrations: { hosts: { claude: true, codex: false, opencode: false } },
  providers: {},
});

function withBrokenPath(fn) {
  const prevPath = process.env.PATH;
  process.env.PATH = path.join(process.env.TMPDIR ?? '/tmp', 'ak-providers-status-no-such-bin');
  try {
    return fn();
  } finally {
    process.env.PATH = prevPath;
  }
}

test('reuses integrationFacts.hosts[id].present instead of a fresh have() probe', async () => {
  await withBrokenPath(async () => {
    const integrationFacts = {
      hosts: {
        claude: { present: true }, codex: { present: true }, opencode: { present: false },
      },
    };
    const rows = await providersStatusSection.collect({ cfg: cfg(), cwd: process.cwd(), integrationFacts });
    const codexRow = rows.find((r) => r.message.startsWith('codex:'));
    const opencodeRow = rows.find((r) => r.message.startsWith('opencode:'));
    assert.match(codexRow.message, /Found, not managed/,
      'codex reused integrationFacts.present:true despite the broken PATH a real have() would see');
    assert.match(opencodeRow.message, /Not installed/,
      'opencode reused integrationFacts.present:false, also without a real probe');
  });
});

test('falls back to a real have() probe when no integrationFacts is passed (a direct caller, not status.mjs)', async () => {
  await withBrokenPath(async () => {
    const rows = await providersStatusSection.collect({ cfg: cfg(), cwd: process.cwd() });
    const codexRow = rows.find((r) => r.message.startsWith('codex:'));
    assert.match(codexRow.message, /Not installed/,
      'with no integrationFacts, a real (broken-PATH) have() probe runs and finds nothing');
  });
});
