import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySessionSurface, sessionSurfaceLabel } from '../../src/lib/session-surface.mjs';
import { transcriptSessionOrigin } from '../../src/lib/footprint/session-origin.mjs';

const claudeCases = [
  ['cli', 'claude-code-cli', 'person'], ['claude-vscode', 'claude-code-vscode', 'person'],
  ['claude-desktop', 'claude-desktop', 'person'], ['claude-desktop-3p', 'claude-desktop', 'person'],
  ['local-agent', 'cowork', 'person'], ['local_agent', 'cowork', 'person'],
  ['remote_cowork', 'cowork', 'person'], ['remote', 'cloud-session', 'person'],
  ['remote_desktop', 'cloud-session', 'person'], ['remote_mobile', 'cloud-session', 'person'],
  ['remote_projects', 'cloud-session', 'person'], ['remote_trigger', 'cloud-session', 'automation'],
  ['remote_cowork_trigger', 'cloud-session', 'automation'],
  ['sdk-py', 'claude-agent-sdk', 'automation'], ['sdk-ts', 'claude-agent-sdk', 'automation'],
  ['sdk-cli', 'claude-noninteractive', 'automation'],
  ['claude-code-github-action', 'github-actions', 'automation'],
  ['claude_in_slack', 'claude-tag', 'person'], ['claude-in-slack', 'claude-tag', 'person'],
  ['claude-in-teams', 'claude-tag', 'person'],
  ['mcp', 'other-claude', 'automation'], ['ssh-remote', 'other-claude', 'person'],
  ['bench', 'other-claude', 'unknown'],
];

test('maps every ADR-0060 Claude raw value to one surface and initiator', () => {
  for (const [entrypoint, surface, initiator] of claudeCases) {
    const actual = classifySessionSurface({ host: 'claude', entrypoint });
    assert.equal(actual.surface, surface, entrypoint);
    assert.equal(actual.initiator, initiator, entrypoint);
    assert.equal(actual.label, sessionSurfaceLabel(surface), entrypoint);
    assert.deepEqual(actual.rawEvidence, { entrypoint }, entrypoint);
  }
});

test('maps every ADR-0060 OpenAI originator, including source-dependent MCP', () => {
  const cases = [
    ['Codex Desktop', undefined, 'chatgpt-desktop-codex', 'person'],
    ['codex_work_desktop', undefined, 'chatgpt-desktop-work', 'person'],
    ['codex-tui', undefined, 'codex-cli', 'person'],
    ['codex_exec', 'exec', 'codex-cli-exec', 'automation'],
    ['codex_vscode', 'vscode', 'codex-ide', 'person'],
    ['codex_sdk_ts', undefined, 'codex-sdk', 'automation'],
    ['codex_python_sdk', undefined, 'codex-sdk', 'automation'],
    ['codex_cli_rs', 'mcp', 'codex-mcp', 'agent'],
    ['codex_work_web', undefined, 'chatgpt-work-cloud', 'person'],
    ['codex_work_mobile', undefined, 'chatgpt-work-cloud', 'person'],
    ['codex_work_cca', undefined, 'chatgpt-work-cloud', 'person'],
    ['chatgpt_cca', undefined, 'chatgpt-work-cloud', 'person'],
    ['future-client', 'vscode', 'other-openai', 'unknown'],
  ];
  for (const [originator, source, surface, initiator] of cases) {
    const actual = classifySessionSurface({ host: 'codex', originator, source });
    assert.equal(actual.surface, surface, originator);
    assert.equal(actual.initiator, initiator, originator);
    assert.equal(actual.label, sessionSurfaceLabel(surface), originator);
    assert.deepEqual(actual.rawEvidence, originator === 'future-client' ? { source } : source
      ? { originator, source } : { originator }, originator);
  }
});

test('keeps initiator orthogonal to surface and import state', () => {
  assert.equal(classifySessionSurface({ host: 'claude', entrypoint: 'cli', sessionKind: 'bg' }).initiator, 'automation');
  assert.equal(classifySessionSurface({ host: 'codex', originator: 'Codex Desktop', threadSource: 'guardian_review' }).initiator, 'agent');
  assert.equal(classifySessionSurface({ host: 'codex', originator: 'Codex Desktop', threadSource: 'subagent' }).initiator, 'agent');
  assert.equal(classifySessionSurface({ host: 'codex', originator: 'Codex Desktop', threadSource: 'chatgpt_handoff' }).initiator, 'person');
  assert.equal(classifySessionSurface({ host: 'codex', originator: 'Codex Desktop', threadSource: 'automation' }).initiator, 'automation');
  assert.equal(classifySessionSurface({ host: 'codex', originator: 'Codex Desktop', importedCopy: true }).initiator, 'imported-copy');
  assert.equal(classifySessionSurface({ host: 'codex', originator: 'codex_exec', threadSource: 'user' }).initiator, 'automation');
  for (const threadSource of ['user', 'chatgpt_handoff']) {
    assert.equal(classifySessionSurface({ host: 'codex', originator: 'codex_cli_rs', source: 'mcp', threadSource }).initiator, 'agent');
    for (const originator of ['codex_sdk_ts', 'codex_python_sdk']) {
      assert.equal(classifySessionSurface({ host: 'codex', originator, threadSource }).initiator, 'automation');
    }
  }
  assert.equal(classifySessionSurface({ host: 'codex', originator: 'codex_sdk_ts', threadSource: 'guardian_review' }).initiator, 'agent');
});

test('unknown declarations remain bounded and do not become product claims', () => {
  assert.deepEqual(classifySessionSurface({ host: 'claude' }), {
    surface: 'unknown', initiator: 'unknown', label: 'Unknown', rawEvidence: {}, attributes: [], thirdPartyProvider: null,
  });
  const ambiguous = classifySessionSurface({ host: 'codex', source: 'vscode' });
  assert.equal(ambiguous.surface, 'unknown');
  assert.equal(ambiguous.label, 'Unknown');
  assert.deepEqual(ambiguous.rawEvidence, { source: 'vscode' });
  const prompt = 'private prompt '.repeat(100);
  const unknown = classifySessionSurface({ host: 'claude', entrypoint: prompt });
  assert.equal(unknown.surface, 'unknown');
  assert.deepEqual(unknown.rawEvidence, {});
  assert.ok(!JSON.stringify(unknown).includes('private prompt'));
  assert.deepEqual(classifySessionSurface({ host: 'codex', originator: 'user prompt' }).rawEvidence, {});
  for (const field of ['entrypoint', 'originator', 'source', 'threadSource', 'sessionKind']) {
    const value = 'privateSingleTokenCanary';
    const candidate = classifySessionSurface({ host: field === 'entrypoint' || field === 'sessionKind' ? 'claude' : 'codex',
      [field]: value });
    assert.ok(!JSON.stringify(candidate).includes(value), field);
  }
  assert.equal(sessionSurfaceLabel('__proto__'), 'Unknown');
});

test('records observed attributes and keeps third-party provider separate', () => {
  const thirdParty = classifySessionSurface({ host: 'claude', entrypoint: 'claude-desktop-3p' });
  assert.deepEqual(thirdParty.attributes, ['on 3P']);
  assert.equal(thirdParty.thirdPartyProvider, null);
  const remote = classifySessionSurface({ host: 'claude', entrypoint: 'remote_desktop' });
  assert.equal(remote.surface, 'cloud-session');
  assert.deepEqual(remote.attributes, ['started from Claude Desktop']);
});

test('footprint adapter keeps legacy origin/evidence and latches first declaration', () => {
  const lines = (...rows) => rows.map((row) => JSON.stringify(row));
  const codex = transcriptSessionOrigin(lines(
    { type: 'session_meta', payload: { originator: 'codex-tui', source: 'vscode', thread_source: 'user' } },
    { type: 'session_meta', payload: { originator: 'Codex Desktop' } },
  ), 'codex');
  assert.equal(codex.origin, 'unknown');
  assert.equal(codex.evidence, 'desktop-origin-not-declared');
  assert.equal(codex.surface, 'codex-cli');
  assert.equal(codex.initiator, 'person');
  assert.deepEqual(codex.rawEvidence, { originator: 'codex-tui', source: 'vscode', threadSource: 'user' });
  const claude = transcriptSessionOrigin(lines({ entrypoint: 'claude-desktop' }, { entrypoint: 'cli' }), 'claude');
  assert.deepEqual([claude.origin, claude.evidence, claude.surface],
    ['claude-desktop', 'entrypoint:claude-desktop', 'claude-desktop']);
  assert.equal(transcriptSessionOrigin(lines({ entrypoint: 'remote_desktop' }), 'claude').origin, 'unknown');
});
