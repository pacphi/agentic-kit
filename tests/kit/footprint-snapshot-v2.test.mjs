import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readSnapshot, SNAPSHOT_SCHEMA_VERSION, writeSnapshot,
} from '../../src/lib/footprint/snapshot.mjs';

test('catalog scope correction invalidates v1 and v2 footprint snapshots instead of guessing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-footprint-snapshot-v3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'snapshot.json');

  assert.equal(SNAPSHOT_SCHEMA_VERSION, 3);
  for (const schemaVersion of [1, 2]) {
    fs.writeFileSync(file, `${JSON.stringify({ schemaVersion, asOf: 10, sections: { catalog: {} } })}\n`);
    const old = readSnapshot({ file });
    assert.equal(old.present, false);
    assert.match(old.reason, new RegExp(`schema ${schemaVersion} is not readable`));
  }

  const written = writeSnapshot({ catalog: { asOf: 20, complete: true } }, { file, now: 21, asOf: 20 });
  assert.equal(written.ok, true);
  const current = readSnapshot({ file });
  assert.equal(current.present, true);
  assert.equal(current.schemaVersion, 3);
  assert.equal(current.sections.catalog.asOf, 20);
});
