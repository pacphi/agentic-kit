import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run as runAuditCommand } from '../../src/commands/audit.mjs';
import {
  buildContextAudit,
  modelWindowFromDiscovery,
} from '../../src/lib/context-audit.mjs';
import {
  boundedSkillMetadata,
  inspectManagedGuidance,
  inspectMcpConfig,
} from '../../src/lib/context-audit-sources.mjs';

const guidance = {
  status: 'complete',
  target: 'agents-user',
  bytes: 1_684,
  conservativeTokens: 562,
  budget: { maxBytes: 2_200, maxConservativeTokens: 734 },
  withinBudget: true,
  included: [{ slug: 'ruflo-dual-mode-reference', bytes: 1_684 }],
  omitted: [],
  unknown: [],
  installations: [{
    scope: 'machine', status: 'complete', state: 'canonical-managed',
    managedBlocks: 1, expectedBlocks: 1, duplicateBlocks: 0, staleBlocks: 0,
    missingBlocks: 0, file: '/secret/AGENTS.md', raw: 'SECRET GUIDANCE',
  }],
};

const windows = {
  status: 'complete',
  model: 'gpt-test',
  advertised: { tokens: 872_000, provenance: 'host-configured', source: 'codex-cache' },
  host: { tokens: 272_000, provenance: 'host-configured', source: 'codex-cache' },
  effective: { tokens: 258_400, provenance: 'host-configured', source: 'codex-cache' },
  autoCompact: { tokens: 240_000, provenance: 'host-configured', source: 'codex-cache' },
};

const hookAudit = {
  reports: {
    codex: {
      coverage: { status: 'complete' },
      summary: { sources: 2, invalidSources: 0, hookOccurrences: 3 },
      records: [
        { event: 'Stop', source: { file: '/private/stop.json' }, command: { normalized: 'secret command' } },
        { event: 'PostToolUse' },
        { event: 'Stop' },
      ],
    },
    external: {
      coverage: { status: 'partial' },
      summary: { sources: 0, invalidSources: 0, hookOccurrences: 0 },
      records: [],
    },
  },
};

function evidence() {
  return {
    guidance: {
      codex: guidance,
      external: { status: 'unsupported', reason: 'external-contract-v1-no-native-guidance' },
    },
    windows: {
      codex: windows,
      external: { status: 'unsupported', reason: 'external-contract-v1-no-context-observability' },
    },
    skills: {
      codex: { status: 'partial', count: 80, metadataBytes: null, omitted: 0, reason: 'host-rendered-metadata-not-recorded' },
      external: { status: 'unsupported', count: null, metadataBytes: null, omitted: 0, reason: 'external-contract-v1-no-skill-observability' },
    },
    mcp: {
      codex: { status: 'partial', registrations: 2, configBytes: 420, schemaBytes: null, reason: 'tool-schemas-not-recorded' },
      external: { status: 'unsupported', registrations: null, configBytes: null, schemaBytes: null, reason: 'external-contract-v1-no-mcp-observability' },
    },
    hookAudit,
  };
}

test('pure context audit preserves window fact distinctions and evaluates compatible startup units', () => {
  const report = buildContextAudit({ hosts: ['codex', 'external'], evidence: evidence() });
  const codex = report.reports.codex;

  assert.equal(report.mode, 'read-only');
  assert.equal(codex.guidance.bytes, 1_684);
  assert.deepEqual(codex.guidance.estimatedTokens, {
    tokens: 562, unit: 'estimated-tokens', method: 'utf8-bytes-div-3-ceil',
  });
  assert.deepEqual(codex.guidance.installations, [{
    scope: 'machine', status: 'complete', state: 'canonical-managed',
    managedBlocks: 1, expectedBlocks: 1, duplicateBlocks: 0, staleBlocks: 0,
    missingBlocks: 0, upstreamOwned: [],
  }]);
  assert.equal(codex.modelWindow.advertised.tokens, 872_000);
  assert.equal(codex.modelWindow.host.tokens, 272_000);
  assert.equal(codex.modelWindow.effective.tokens, 258_400);
  assert.equal(codex.modelWindow.autoCompact.tokens, 240_000);
  assert.equal(codex.modelWindow.ceiling.tokens, 240_000, 'lowest fresh trusted guard wins');
  assert.equal(codex.startup.state, 'evaluated');
  assert.equal(codex.startup.basis, 'estimated-startup-vs-token-window');
  assert.equal(codex.hooks.stopOccurrences, 2);

  const external = report.reports.external;
  assert.equal(external.hooks.status, 'unsupported');
  assert.equal(external.hooks.reason, 'external-contract-v1-no-hook-runtime-observability');
  assert.equal(external.sourceHealth.overall, 'unsupported');
  assert.equal(external.startup.state, 'unknown');
  assert.equal(external.guidance.bytes, null, 'unsupported is not rewritten as zero');

  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /private\/stop\.json|secret command/);
});

test('startup verdict stays unknown when guidance accounting is incomplete', () => {
  const input = evidence();
  input.guidance.codex = {
    ...guidance,
    status: 'partial',
    unknown: [{ slug: 'missing', reason: 'missing-template' }],
  };
  const report = buildContextAudit({ hosts: ['codex'], evidence: input });
  assert.equal(report.reports.codex.startup.state, 'unknown');
  assert.equal(report.reports.codex.startup.reason, 'startup-contribution-incomplete');
});

test('model discovery projection does not conflate advertised, host, effective, and compact limits', () => {
  const discovered = modelWindowFromDiscovery('codex', {
    status: 'complete',
    source: { id: 'codex-cache', status: 'complete', file: '/secret/cache.json' },
    models: [{
      key: { modelId: 'gpt-test' }, states: { effective: true },
      variant: {
        maximumContextWindow: 872_000,
        contextWindow: 272_000,
        effectiveContextWindow: 258_400,
        autoCompactTokenLimit: 240_000,
      },
    }],
  });

  assert.deepEqual(discovered, windows);
  assert.doesNotMatch(JSON.stringify(discovered), /secret/);
});

test('skill metadata census is bounded, symlink-safe, and returns counts without contents or paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-context-skills-'));
  try {
    fs.mkdirSync(path.join(root, 'one'), { recursive: true });
    fs.mkdirSync(path.join(root, 'two'), { recursive: true });
    fs.mkdirSync(path.join(root, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(root, 'one', 'SKILL.md'), 'SECRET ONE');
    fs.writeFileSync(path.join(root, 'two', 'SKILL.md'), 'SECRET TWO');
    fs.writeFileSync(path.join(root, 'nested', 'deeper', 'SKILL.md'), 'SECRET DEEP');
    fs.symlinkSync(path.join(root, 'one'), path.join(root, 'linked'));

    const report = boundedSkillMetadata({ roots: [root], maxEntries: 16, maxDepth: 3 });
    assert.deepEqual(report, {
      status: 'partial', count: 3, metadataBytes: null, omitted: 0,
      reason: 'host-rendered-metadata-not-recorded',
    });
    assert.doesNotMatch(JSON.stringify(report), /SECRET|ak-context-skills/);

    const capped = boundedSkillMetadata({ roots: [root], maxEntries: 1, maxDepth: 3 });
    assert.equal(capped.status, 'partial');
    assert.equal(capped.omitted, 1);
    assert.equal(capped.reason, 'skill-census-entry-cap');

    const depthCapped = boundedSkillMetadata({ roots: [root], maxEntries: 16, maxDepth: 1 });
    assert.equal(depthCapped.count, 2);
    assert.equal(depthCapped.omitted, 1);
    assert.equal(depthCapped.reason, 'skill-census-depth-cap');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP config inspection reports only bounded counts/bytes and never names, commands, or secrets', () => {
  const claudeRaw = JSON.stringify({
    mcpServers: {
      privateServer: { command: 'SECRET_COMMAND', env: { TOKEN: 'SECRET_TOKEN' } },
      second: { command: 'node' },
    },
  });
  const claude = inspectMcpConfig('claude', claudeRaw);
  assert.deepEqual(claude, {
    status: 'partial', registrations: 2, configBytes: Buffer.byteLength(claudeRaw),
    schemaBytes: null, reason: 'tool-schemas-not-recorded',
  });
  assert.doesNotMatch(JSON.stringify(claude), /privateServer|SECRET|node/);

  const codexRaw = '[mcp_servers.ruflo]\ncommand = "SECRET"\n\n[mcp_servers.aqe]\ncommand = "SECRET"\n';
  assert.equal(inspectMcpConfig('codex', codexRaw).registrations, 2);
  assert.equal(inspectMcpConfig('external', '').status, 'unsupported');
  assert.equal(inspectMcpConfig('opencode', '{not-json').status, 'unavailable');
});

test('managed guidance inspection distinguishes absent, user-only, canonical, duplicate, and stale states', () => {
  const managed = '<!-- BEGIN compact -->\nmanaged\n<!-- END compact -->\n';
  const expected = [{ slug: 'compact', text: managed }];

  assert.equal(inspectManagedGuidance(null, expected).state, 'absent');
  assert.equal(inspectManagedGuidance('# user instructions\n', expected).state, 'user-authored-only');
  assert.deepEqual(inspectManagedGuidance(`# user\n${managed}`, expected), {
    status: 'complete', state: 'canonical-managed', managedBlocks: 1,
    expectedBlocks: 1, duplicateBlocks: 0, staleBlocks: 0, missingBlocks: 0,
    upstreamOwned: [],
  });
  assert.equal(inspectManagedGuidance(`${managed}\n${managed}`, expected).state, 'duplicate-managed');
  assert.equal(inspectManagedGuidance(managed.replace('managed', 'old'), expected).state, 'stale-managed');
  assert.doesNotMatch(JSON.stringify(inspectManagedGuidance('# SECRET USER\n', expected)), /SECRET USER/);
});

test('project AQE guidance is attributed as upstream-owned without exposing its content', () => {
  const aqe = '<!-- BEGIN AGENTIC-QE CODEX -->\nSECRET AQE CONTENT\n<!-- END AGENTIC-QE CODEX -->\n';
  const report = inspectManagedGuidance(`# user\n${aqe}`, []);
  assert.equal(report.state, 'upstream-managed-only');
  assert.deepEqual(report.upstreamOwned, [{
    owner: 'agentic-qe', blocks: 1, bytes: Buffer.byteLength(aqe.trimEnd()),
    estimatedTokens: {
      tokens: Math.ceil(Buffer.byteLength(aqe.trimEnd()) / 3),
      unit: 'estimated-tokens', method: 'utf8-bytes-div-3-ceil',
    },
    state: 'single-managed',
  }]);
  assert.doesNotMatch(JSON.stringify(report), /SECRET AQE CONTENT/);

  const duplicate = inspectManagedGuidance(`${aqe}${aqe}`, []);
  assert.equal(duplicate.state, 'duplicate-managed');
  assert.equal(duplicate.upstreamOwned[0].state, 'duplicate-managed');
});

async function captureConsole(fn) {
  const stdout = [];
  const stderr = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  try { return { code: await fn(), stdout: stdout.join('\n'), stderr: stderr.join('\n') }; }
  finally { console.log = oldLog; console.error = oldError; }
}

test('ak audit context supports JSON and concise text through an injected read-only collector', async () => {
  const report = buildContextAudit({ hosts: ['codex', 'external'], evidence: evidence() });
  const json = await captureConsole(() => runAuditCommand({
    flags: { json: true, host: ['codex', 'external'] }, positionals: ['context'],
    contextCollectorFn: async () => report,
  }));
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), report);

  const text = await captureConsole(() => runAuditCommand({
    flags: { json: false, host: ['codex'] }, positionals: ['context'],
    contextCollectorFn: async () => report,
  }));
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /codex: guidance 1684 B · ~562 estimated tokens/);
  assert.match(text.stdout, /window advertised 872000 · host 272000 · effective 258400 · compact 240000/);
  assert.match(text.stdout, /hooks 3 occurrence\(s\), 2 Stop/);
  assert.doesNotMatch(text.stdout, /private|secret command/);
});
