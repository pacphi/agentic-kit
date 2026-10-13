// Opt-in conformance for agentic-qe#754 ("RVF pattern index never binds when an
// embedder endpoint is configured"), fixed in agentic-qe 3.14.5. It runs ak's own
// pattern-index probe (src/lib/aqe-pattern-index-probe.mjs) against a real
// installed agentic-qe and a real embedding endpoint: the probe learns one
// pattern through the shipped `aqe` command and must get it back as a vector
// match. The control points the same probe at an endpoint nothing listens on and
// requires a failure, so a pass cannot come from a probe that always passes.
//
//   AK_AQE_PATTERN_INDEX_LIVE=1 AK_AQE_PACKAGE_ROOT=/abs/path/to/node_modules/agentic-qe \
//     AK_AQE_EMBEDDER_ENDPOINT=http://127.0.0.1:11434 \
//     node scripts/run-tests.mjs exec -- --test tests/live/aqe-pattern-index-conformance.test.mjs
//
// The probe works in a disposable project with a private HOME; this test installs
// nothing and touches no real project.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { probeAqePatternIndex } from '../../src/lib/aqe-pattern-index-probe.mjs';

const ENABLED = process.env.AK_AQE_PATTERN_INDEX_LIVE === '1';
const packageRoot = process.env.AK_AQE_PACKAGE_ROOT;
const endpoint = process.env.AK_AQE_EMBEDDER_ENDPOINT;
const skip = ENABLED ? false : 'set AK_AQE_PATTERN_INDEX_LIVE=1, AK_AQE_PACKAGE_ROOT and AK_AQE_EMBEDDER_ENDPOINT to run the live pattern-index conformance';

function configured() {
  assert.ok(packageRoot && path.isAbsolute(packageRoot), 'AK_AQE_PACKAGE_ROOT must name an installed agentic-qe by absolute path');
  assert.ok(endpoint, 'AK_AQE_EMBEDDER_ENDPOINT must name a reachable embedding endpoint');
}

test('the shipped agentic-qe binds its pattern index to a configured embedder', { skip, timeout: 120_000 }, async () => {
  configured();
  const result = await probeAqePatternIndex({ packageRoot, env: { AQE_EMBEDDER_ENDPOINT: endpoint } });
  assert.deepEqual(result, { status: 'passed' });
});

test('control: the same probe fails when the endpoint does not answer', { skip, timeout: 120_000 }, async () => {
  configured();
  const result = await probeAqePatternIndex({ packageRoot, env: { AQE_EMBEDDER_ENDPOINT: 'http://127.0.0.1:9' } });
  assert.equal(result.status, 'failed', JSON.stringify(result));
});
