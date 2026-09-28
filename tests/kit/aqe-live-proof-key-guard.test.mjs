// The agentic-qe#628 live proof (tests/live/aqe-external-provider-transport.test.mjs)
// serves its provider from a local hook and inherits its environment. A real
// provider key there could let AQE reach a paid provider instead, so the proof
// refuses to start while any *_API_KEY is set, before it runs AQE at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.mjs';

const LIVE = fileURLToPath(new URL('../live/aqe-external-provider-transport.test.mjs', import.meta.url));

test('the #628 live proof refuses to run with a provider API key in its environment, before running AQE', (t) => {
  const dir = tempDir('ak-live-key-guard', t);
  const result = spawnSync(process.execPath, ['--test', LIVE], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(dir, 'home'),
      XDG_CONFIG_HOME: path.join(dir, 'xdg'),
      XDG_STATE_HOME: path.join(dir, 'state'),
      TMPDIR: dir,
      NO_COLOR: '1',
      EXAMPLE_PROVIDER_API_KEY: 'secret-value-never-printed',
      AQE_BIN: path.join(dir, 'no-aqe-here'),
    },
  });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, out);
  assert.match(out, /refusing to run/);
  assert.match(out, /EXAMPLE_PROVIDER_API_KEY/);
  assert.doesNotMatch(out, /secret-value-never-printed/, 'names the key, never its value');
  assert.doesNotMatch(out, /AQE is required/, 'the guard runs before AQE is looked for');
});
