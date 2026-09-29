import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as presentation from '../../src/lib/session-surface.mjs';
import { discoverProjectSources } from '../../src/lib/footprint/project-sources.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('shared presentation keeps legacy desktop mode unknown and rejects raw provider claims', () => {
  assert.equal(typeof presentation.sessionPresentation, 'function');
  const legacy = presentation.sessionPresentation({ origin: 'codex-desktop' });
  assert.equal(legacy.surface, 'unknown');
  assert.equal(legacy.label, 'Unknown');
  assert.match(legacy.note, /ChatGPT desktop app.*mode.*not recorded/i);
  assert.equal(presentation.sessionPresentation({ surface: 'claude-desktop', thirdPartyProvider: 'amazon-bedrock' }).provider, 'Unknown');
  assert.equal(presentation.sessionPresentation({ surface: 'claude-desktop', thirdPartyProvider: 'amazon-bedrock', thirdPartyProviderBasis: 'assistant-model-id' }).provider, 'Amazon Bedrock');
});

test('project discovery preserves separate surfaces and bounded raw disagreements through JSON', (t) => {
  const root = tempDir('ak-session-presentation-', t);
  const claude = path.join(root, 'claude'); fs.mkdirSync(claude);
  for (const [i, entrypoint] of ['cli', 'sdk-cli', 'future-a', 'future-b'].entries()) {
    fs.writeFileSync(path.join(claude, `${i}.jsonl`), JSON.stringify({ type: 'user', sessionId: `id-${i}`, cwd: root, entrypoint }));
  }
  const census = discoverProjectSources({ claudeRoot: claude, codexRoot: path.join(root, 'absent'), opencodeDbFile: path.join(root, 'absent.db') });
  const row = JSON.parse(JSON.stringify(census.projects[0]));
  assert.equal(row.sessions, 4);
  assert.ok(Array.isArray(row.sessionSurfaces));
  assert.deepEqual(row.sessionSurfaces.map((entry) => entry.surface).sort(), ['claude-code-cli', 'claude-noninteractive', 'other-claude']);
  const other = row.sessionSurfaces.find((entry) => entry.surface === 'other-claude');
  assert.deepEqual(other.rawEvidence.entrypoint, ['future-a', 'future-b']);
  assert.equal(other.sessions, 2);
  assert.equal(other.countBasis, 'declared-session-ids');
  assert.equal(other.initiator, 'unknown');
});
test('aggregation preserves declared attributes and separates supported provider observations', async () => {
  const { mergeSessionSurfaces } = await import('../../src/lib/footprint/session-surfaces.mjs');
  const common = { host: 'claude', surface: 'claude-desktop', initiator: 'person', sessions: 1,
    countBasis: 'declared-session-ids', attributes: ['on 3P'] };
  const rows = mergeSessionSurfaces([{ ...common, thirdPartyProvider: 'amazon-bedrock', thirdPartyProviderBasis: 'assistant-model-id' }, common]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].attributes, ['on 3P']);
  assert.equal(rows.filter((row) => row.thirdPartyProvider === 'amazon-bedrock').length, 1);
});
test('bounded raw disagreements preserve an explicit incomplete flag, with order-independent values', async () => {
  const { mergeSessionSurfaces } = await import('../../src/lib/footprint/session-surfaces.mjs');
  const entries = Array.from({ length: 20 }, (_, i) => ({ host: 'codex', surface: 'other-openai', initiator: 'unknown',
    sessions: 1, countBasis: 'transcript-files', rawEvidence: { originator: `future-${i}` } }));
  const forward = mergeSessionSurfaces(entries), reverse = mergeSessionSurfaces(entries.toReversed());
  assert.deepEqual(forward, reverse);
  assert.equal(forward[0].rawEvidenceComplete, false);
  assert.equal(forward[0].rawEvidence.originator.length, 16);
  assert.equal(forward[0].sessions, 20);
});
test('all import count fields survive collection and the summary; absent legacy fields stay unknown', async () => {
  const { collectProjects } = await import('../../src/lib/footprint/projects.mjs');
  const { systemSummaryPayload } = await import('../../src/lib/dashboard/system-summary.mjs');
  const { censusDisclosure } = await import('../../src/lib/census-presentation.mjs');
  const projects = collectProjects({ sources: { projects: [], importedExcluded: 4, importedMixed: 2,
    importedUnresolved: 3, everSeen: 0, onDisk: 0, gitRepos: 0, complete: false }, loc: false });
  const summary = systemSummaryPayload({ projects }).projects;
  assert.equal(summary.importedExcluded, 4); assert.equal(summary.importedMixed, 2); assert.equal(summary.importedUnresolved, 3);
  assert.match(censusDisclosure({}), /Unknown number of confirmed pure imported copies/);
  assert.doesNotMatch(censusDisclosure({}), /0 confirmed/);
});
test('surface aggregation tolerates malformed attributes and orders provider groups deterministically', async () => {
  const { mergeSessionSurfaces } = await import('../../src/lib/footprint/session-surfaces.mjs');
  const base = { host: 'claude', surface: 'claude-desktop', sessions: 1, attributes: 'untrusted' };
  assert.doesNotThrow(() => mergeSessionSurfaces([base]));
  const entries = [{ ...base, attributes: [], thirdPartyProvider: 'amazon-bedrock', thirdPartyProviderBasis: 'assistant-model-id' }, { ...base, attributes: [] }];
  assert.deepEqual(mergeSessionSurfaces(entries), mergeSessionSurfaces(entries.toReversed()));
});
