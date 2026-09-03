import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildSkillMaintenancePlan } from '../../src/lib/skill-maintenance-plan.mjs';

const measuredDigest = (value) => ({
  status: 'measured', value, reason: null, asOf: 1, partial: false,
});

function catalog(project) {
  const projectSkill = path.join(project, '.agents', 'skills', 'shared', 'SKILL.md');
  const modifiedSkill = path.join(project, '.agents', 'skills', 'modified', 'SKILL.md');
  return {
    complete: true,
    items: [
      { kind: 'skill', name: 'shared', capabilityName: 'shared', presence: [
        { host: 'codex', scope: 'project', project, sourceFile: projectSkill, digest: measuredDigest('same') },
        { host: 'codex', scope: 'user', sourceFile: '/user/shared/SKILL.md', digest: measuredDigest('same') },
      ] },
      { kind: 'skill', name: 'modified', capabilityName: 'modified', presence: [
        { host: 'codex', scope: 'project', project, sourceFile: modifiedSkill, digest: measuredDigest('changed') },
      ] },
    ],
    projects: [{
      project, complete: true, gaps: [],
      contextInclusion: { status: 'unknown', reason: 'host-owned' },
    }],
  };
}

const gitRun = (_binary, args) => {
  if (args.includes('rev-parse')) return { status: 0, stdout: 'true\n' };
  if (args.includes('ls-files')) return { status: 0, stdout: 'tracked\n' };
  return { status: 0, stdout: '' };
};

test('read-only plan distinguishes exact upstream, modified and receipt-proven cleanup', () => {
  const project = path.resolve('/repo');
  const input = catalog(project);
  const modifiedPath = path.join(project, '.agents', 'skills', 'modified', 'SKILL.md');
  const plan = buildSkillMaintenancePlan({
    catalog: input, project, run: gitRun, now: () => 100,
    receipts: [{ path: modifiedPath, digest: 'changed', desired: false, sourceRef: 'kit' }],
  });
  const shared = plan.artifacts.find((artifact) => artifact.name === 'shared');
  const modified = plan.artifacts.find((artifact) => artifact.name === 'modified');
  assert.equal(shared.classification, 'exact-known-upstream-revision');
  assert.equal(shared.safeToPrune, false, 'digest equality without ownership is not delete authority');
  assert.equal(modified.classification, 'receipt-owned-unchanged');
  assert.equal(modified.safeToPrune, true);
  assert.deepEqual(plan.affectedPaths, [modifiedPath]);
  assert.equal(plan.mode, 'read-only');
  assert.equal(plan.projection.currentProjectSkillPaths, 2);
  assert.equal(plan.projection.projectedProjectSkillPaths, 1);
  assert.equal(plan.contextInclusion.status, 'unknown');
});

test('plan digest is content-derived and drifted receipts preserve files', () => {
  const project = path.resolve('/repo');
  const modifiedPath = path.join(project, '.agents', 'skills', 'modified', 'SKILL.md');
  const first = buildSkillMaintenancePlan({
    catalog: catalog(project), project, run: gitRun, now: () => 100,
    receipts: [{ path: modifiedPath, digest: 'old', desired: false }],
  });
  const second = buildSkillMaintenancePlan({
    catalog: catalog(project), project, run: gitRun, now: () => 200,
    receipts: [{ path: modifiedPath, digest: 'old', desired: false }],
  });
  assert.equal(first.planDigest, second.planDigest);
  assert.notEqual(first.generatedAt, second.generatedAt);
  const modified = first.artifacts.find((artifact) => artifact.name === 'modified');
  assert.equal(modified.classification, 'receipt-drifted-or-modified');
  assert.equal(modified.recommendation, 'preserve-and-review');
  assert.deepEqual(first.affectedPaths, []);
});

test('one physical project skill is classified once across multiple capable hosts', () => {
  const project = path.resolve('/repo');
  const input = catalog(project);
  const occurrence = input.items[0].presence[0];
  input.items[0].presence.push({ ...occurrence, host: 'opencode' });
  const plan = buildSkillMaintenancePlan({ catalog: input, project, run: gitRun });
  const shared = plan.artifacts.find((artifact) => artifact.name === 'shared');
  assert.deepEqual(shared.hosts, ['codex', 'opencode']);
  assert.equal(plan.artifacts.filter((artifact) => artifact.name === 'shared').length, 1);
});

test('receipt candidate is preserved when catalog or project evidence is partial', () => {
  const project = path.resolve('/repo');
  const modifiedPath = path.join(project, '.agents', 'skills', 'modified', 'SKILL.md');
  for (const mutate of [
    (input) => { input.complete = false; },
    (input) => { input.projects[0].complete = false; input.projects[0].gaps = [{ surface: 'project-skills' }]; },
    (input) => { input.items[1].presence[0].digest.partial = true; },
  ]) {
    const input = catalog(project);
    mutate(input);
    const plan = buildSkillMaintenancePlan({
      catalog: input, project, run: gitRun,
      receipts: [{ path: modifiedPath, digest: 'changed', desired: false }],
    });
    const modified = plan.artifacts.find((artifact) => artifact.name === 'modified');
    assert.equal(modified.safeToPrune, false);
    assert.ok(
      ['receipt-owned-evidence-incomplete', 'unmeasured-artifact'].includes(modified.classification),
      `unexpected preservation class: ${modified.classification}`,
    );
    assert.equal(modified.recommendation, 'preserve-and-review');
    assert.deepEqual(plan.affectedPaths, []);
  }
});

test('receipt candidate is preserved when git evidence is dirty or incomplete', () => {
  const project = path.resolve('/repo');
  const modifiedPath = path.join(project, '.agents', 'skills', 'modified', 'SKILL.md');
  const cases = [
    (_binary, args) => {
      if (args.includes('rev-parse')) return { status: 0, stdout: 'true\n' };
      if (args.includes('ls-files')) return { status: 0, stdout: '' };
      return { status: 0, stdout: `?? ${path.relative(project, modifiedPath)}\0` };
    },
    (_binary, args) => {
      if (args.includes('rev-parse')) return { status: 0, stdout: 'true\n' };
      return { status: 1, stdout: '' };
    },
    () => ({ status: 1, stdout: '' }),
  ];
  for (const run of cases) {
    const plan = buildSkillMaintenancePlan({
      catalog: catalog(project), project, run,
      receipts: [{ path: modifiedPath, digest: 'changed', desired: false }],
    });
    const modified = plan.artifacts.find((artifact) => artifact.name === 'modified');
    assert.equal(modified.safeToPrune, false);
    assert.equal(modified.recommendation, 'preserve-and-review');
    assert.deepEqual(plan.affectedPaths, []);
  }
});
