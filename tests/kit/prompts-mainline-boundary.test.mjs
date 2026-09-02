import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPage } from '../../src/lib/dashboard/page.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');

function runUsage(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-prompts-boundary-'));
  try {
    return spawnSync(process.execPath, [BIN, 'usage', ...args], {
      cwd: home,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        NO_COLOR: '1',
      },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('Prompts dashboard keeps deterministic telemetry without a coaching surface', () => {
  const html = renderPage({ name: 'agentic-kit', version: 'test' });

  assert.match(html, /id="usage-tab-prompts"[^>]*data-view="prompts"/,
    'the Prompts view remains available');
  for (const id of ['u-pr-kpis', 'u-pr-provenance', 'u-pr-steer', 'u-pr-taps', 'u-pr-patterns', 'u-pr-hosts']) {
    assert.match(html, new RegExp(`id="${id}"`), `the deterministic ${id} panel remains available`);
  }
  assert.doesNotMatch(html, /id="u-pr-coaching(?:-note)?"/,
    'main must not render the archived coaching panel');
  assert.doesNotMatch(html, /id="u-pr-posture"/,
    'main must not offer the archived prompt-sample visibility control');
});

test('ak usage prompts --json publishes deterministic telemetry only', () => {
  const result = runUsage(['prompts', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  assert.ok(Object.hasOwn(payload, 'patterns'), 'fingerprint-derived patterns remain published');
  assert.equal(Object.hasOwn(payload, 'coaching'), false,
    'the archived coaching projection must not be published on main');
  assert.equal(Object.hasOwn(payload, 'enrichment'), false,
    'the archived layer-3 projection must not be published on main');
});

test('retired coaching and layer-3 prompt flags are rejected', () => {
  for (const args of [
    ['prompts', '--enrich'],
    ['prompts', '--draft', 'card-id'],
    ['prompts', '--dismiss', 'card-id'],
  ]) {
    const result = runUsage(args);
    assert.equal(result.status, 2, `${args.join(' ')} must be rejected\n${result.stdout}\n${result.stderr}`);
  }
});
