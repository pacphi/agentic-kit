import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JS } from '../../src/lib/dashboard/client.mjs';
import { renderPage } from '../../src/lib/dashboard/page.mjs';
import { CSS } from '../../src/lib/dashboard/styles.mjs';

const PAGE = renderPage({ name: 'agentic-kit', version: 'test' });

test('usage dashboard includes a visible host-neutral telemetry coverage surface', () => {
  assert.match(PAGE, /id="u-telemetry-grid"/);
  assert.match(PAGE, />telemetry coverage</);
  assert.match(JS, /function renderTelemetryCoverage/);
  assert.match(JS, /coverage not reported by this API/);
  assert.match(JS, /label:"Codex transcript"/);
  assert.match(JS, /coverage unavailable/);
  assert.match(JS, /data-state=/);
  assert.match(CSS, /\.telemetry-card/);
});

test('usage dashboard keeps unsupported and unavailable capability states distinct', () => {
  assert.match(JS, /String\(capabilities\[item\[0\]\]\|\|"unavailable"\)/);
  assert.match(JS, /data-state=/);
  assert.match(JS, /source\.diagnostics&&source\.diagnostics\.common/);
  assert.match(JS, /source\.capabilities\|\|\{\}/);
});
