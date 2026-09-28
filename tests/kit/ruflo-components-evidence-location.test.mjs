import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandboxHome, assertSandboxed } from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-ruflo-components-evidence-location');
const paths = await import('../../src/lib/paths.mjs');
const apply = await import('../../src/lib/ruflo-components/apply.mjs');
assertSandboxed(paths, HOME);

test('rufloComponentsEvidenceFile relocates under the shared evidence/ruflo-component directory', () => {
  const file = apply.rufloComponentsEvidenceFile();
  assert.ok(file.endsWith(path.join('evidence', 'ruflo-component', 'machine.json')),
    `expected the shared evidence layout, got: ${file}`);
  assert.notEqual(path.basename(file), 'ruflo-components-evidence.json');
});
