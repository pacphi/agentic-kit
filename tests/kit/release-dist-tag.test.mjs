import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { distTag } from '../../scripts/release-dist-tag.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const WORKFLOW = fs.readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const SCRIPT = new URL('../../scripts/release-dist-tag.mjs', import.meta.url).pathname;

test('betas publish on the beta tag and never on next or latest', () => {
  for (const version of ['4.0.0-beta.1', '4.0.0-beta.4', '4.1.0-beta.2', '5.0.0-beta']) {
    assert.equal(distTag(version), 'beta', version);
  }
});

test('alphas and release candidates stay on next', () => {
  for (const version of ['4.0.0-alpha.61', '4.0.0-rc.1', '4.1.0-alpha.1', '4.0.0-betamax.1', '4.0.0-next.3']) {
    assert.equal(distTag(version), 'next', version);
  }
});

test('stable releases go to latest, with or without build metadata', () => {
  assert.equal(distTag('4.0.0'), 'latest');
  assert.equal(distTag('4.1.2+build.5'), 'latest');
});

test('rejects anything that is not a semantic version', () => {
  for (const bad of ['', '4.0', 'v4.0.0', '4.0.0-', '4.0.0-beta..1', 'latest', undefined, null, 4]) {
    assert.throws(() => distTag(bad), /not a semantic version/, String(bad));
  }
});

test('the command line prints only the tag', () => {
  const env = spawnEnv(tempDir('ak-release-tag-home'));
  assert.equal(execFileSync(process.execPath, [SCRIPT, '4.0.0-beta.1'], { encoding: 'utf8', env }), 'beta\n');
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'nope'], { stdio: 'pipe', env }), /not a semantic version/);
});

test('the release workflow takes its tag from the script', () => {
  assert.match(WORKFLOW, /scripts\/release-dist-tag\.mjs/);
  assert.doesNotMatch(WORKFLOW, /--tag next/, 'the tag must not be hard-coded to next');
});

test('a manual run can only dry-run: no registry publish and no GitHub Release', () => {
  assert.match(WORKFLOW, /workflow_dispatch:/);
  assert.match(WORKFLOW, /--dry-run/);
  const releaseJob = WORKFLOW.slice(WORKFLOW.indexOf('github-release:'));
  assert.match(releaseJob, /if: github\.event_name == 'push'/);
  const guard = WORKFLOW.slice(WORKFLOW.indexOf('Tag ↔ package.json version guard'), WORKFLOW.indexOf('Publish to npm registry'));
  assert.match(guard, /if: github\.event_name == 'push'/);
});
