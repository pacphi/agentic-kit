// ADR-0048 preferences store dedup (fix(dashboard): stop writing Maintenance
// preferences on every poll tick). Covers the belt-and-suspenders server-side
// guard in createPreferencesStore's savePreferences: a partial that resolves
// to the same stored preferences must not touch the write seam.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createPreferencesStore } from '../../src/lib/maintenance/management/preferences.mjs';

function fixtureRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-mnt-preferences-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Real fs, with writeFileSync (writePrivateFileAtomic's actual write seam)
 *  wrapped to count calls without changing its behavior. */
function countingFsImpl() {
  let writes = 0;
  return {
    impl: new Proxy(fs, {
      get(target, prop) {
        if (prop === 'writeFileSync') {
          return (...args) => { writes += 1; return target.writeFileSync(...args); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    get writes() { return writes; },
  };
}

test('savePreferences with an unchanged lastView does not touch the write seam', (t) => {
  const root = fixtureRoot(t);
  const spy = countingFsImpl();
  const store = createPreferencesStore({ root, fsImpl: spy.impl });

  const first = store.savePreferences({ lastView: { scope: 'user', view: 'updates', sort: 'name', facets: { kind: ['skill'] }, search: 'x' } });
  assert.equal(spy.writes, 1, 'a genuinely new lastView writes once');

  const writesAfterFirst = spy.writes;
  const second = store.savePreferences({ lastView: { scope: 'user', view: 'updates', sort: 'name', facets: { kind: ['skill'] }, search: 'x' } });
  assert.equal(spy.writes, writesAfterFirst, 'an identical lastView does not write again');
  assert.deepEqual(second, first);
});

test('savePreferences with a genuinely different lastView writes once', (t) => {
  const root = fixtureRoot(t);
  const spy = countingFsImpl();
  const store = createPreferencesStore({ root, fsImpl: spy.impl });

  store.savePreferences({ lastView: { scope: 'user', view: 'updates', sort: 'name' } });
  const writesAfterFirst = spy.writes;
  const next = store.savePreferences({ lastView: { scope: 'user', view: 'updates', sort: 'recently-changed' } });
  assert.equal(spy.writes, writesAfterFirst + 1, 'a changed lastView field writes again');
  assert.equal(next.lastView.sort, 'recently-changed');
});

test('setPreferredShell with an unchanged shell for an environment does not write; a changed one does', (t) => {
  const root = fixtureRoot(t);
  const spy = countingFsImpl();
  const store = createPreferencesStore({ root, fsImpl: spy.impl });

  store.setPreferredShell('env-a', 'zsh');
  const writesAfterFirst = spy.writes;
  store.setPreferredShell('env-a', 'zsh');
  assert.equal(spy.writes, writesAfterFirst, 'an unchanged shell does not write again');

  store.setPreferredShell('env-a', 'bash');
  assert.equal(spy.writes, writesAfterFirst + 1, 'a changed shell writes again');
});
