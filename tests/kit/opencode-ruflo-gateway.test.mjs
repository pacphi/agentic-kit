import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const template = new URL('../../src/templates/opencode-ruflo-gateway.js', import.meta.url);
const toolContext = (overrides = {}) => ({
  abort: new AbortController().signal,
  ask: async () => {},
  ...overrides,
});

function writePluginStub(root) {
  const dir = path.join(root, 'node_modules', '@opencode-ai', 'plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@opencode-ai/plugin', version: '0.0.0-test', type: 'module', exports: './index.js',
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), `
const schema = (kind, detail = {}) => ({
  kind, ...detail,
  describe() { return this },
  optional() { this.isOptional = true; return this },
})
export const tool = (spec) => spec
tool.schema = {
  string: () => schema('string'),
  number: () => schema('number'),
  unknown: () => schema('unknown'),
  record: (key, value) => schema('record', { key, value }),
}
`);
}

function writeFakeMcp(file) {
  fs.writeFileSync(file, `
import fs from 'node:fs'
import { createInterface } from 'node:readline'
const log = process.env.AK_FAKE_MCP_LOG
const kind = process.env.AK_FAKE_MCP_KIND || 'ruflo'
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const later = (fn, delay = 0) => delay > 0 ? setTimeout(fn, delay) : fn()
const initDelay = Number(process.env.AK_FAKE_MCP_INIT_DELAY_MS || 0)
  const listDelay = Number(process.env.AK_FAKE_MCP_LIST_DELAY_MS || 0)
  const callDelay = Number(process.env.AK_FAKE_MCP_CALL_DELAY_MS || 0)
  const cancelLog = process.env.AK_FAKE_MCP_CANCEL_LOG
const hangMarker = process.env.AK_FAKE_MCP_FIRST_INIT_HANG_MARKER
const termDelay = Number(process.env.AK_FAKE_MCP_TERM_DELAY_MS || 0)
const pidFile = process.env.AK_FAKE_MCP_PID_FILE
if (pidFile) fs.writeFileSync(pidFile, String(process.pid))
if (process.env.AK_FAKE_MCP_IGNORE_TERM === '1') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
}
if (termDelay > 0) process.on('SIGTERM', () => setTimeout(() => process.exit(0), termDelay))
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (log) fs.appendFileSync(log, msg.method + '\\n')
  if (msg.method === 'notifications/cancelled' && cancelLog) {
    fs.appendFileSync(cancelLog, JSON.stringify(msg.params) + '\\n')
  }
  if (msg.id == null) return
  if (msg.method === 'initialize') {
    if (hangMarker && !fs.existsSync(hangMarker)) {
      fs.writeFileSync(hangMarker, 'hung once')
      return
    }
    return later(() => send(msg.id, { protocolVersion: '2024-11-05', capabilities: {} }), initDelay)
  }
  if (msg.method === 'tools/list' && kind === 'aqe') return later(() => send(msg.id, {
    tools: [
      { name: 'fleet_init', description: 'Initialize the QE fleet', inputSchema: { type: 'object', properties: {} } },
      { name: 'quality_assess', description: 'Evaluate the quality gate', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
    ],
  }), listDelay)
  if (msg.method === 'tools/list' && !msg.params.cursor) return later(() => send(msg.id, {
    tools: [
      { name: 'memory_search', description: 'Semantic project memory search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'structured_result', description: 'Return structured MCP content', inputSchema: { type: 'object', properties: {} } },
    ],
    nextCursor: 'page-2',
  }), listDelay)
  if (msg.method === 'tools/list' && msg.params.cursor === 'page-2') return later(() => send(msg.id, {
    tools: [{ name: 'swarm_init', description: 'Initialize an agent swarm', inputSchema: { type: 'object', properties: {} } }],
  }), listDelay)
  if (msg.method === 'tools/call' && msg.params.name === 'structured_result') return send(msg.id, {
    content: [{ type: 'text', text: 'fallback text' }],
    structuredContent: { exact: true, nested: { count: 2 } },
  })
  if (msg.method === 'tools/call') return later(() => send(msg.id, { content: [
    { type: 'text', text: 'called:' + msg.params.name + ':' + JSON.stringify(msg.params.arguments) },
  ] }), callDelay)
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }) + '\\n')
})
`);
}

async function loadGateway(root, managedMcp = {}, agentCatalog = []) {
  writePluginStub(root);
  const pluginDir = path.join(root, 'plugins');
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginFile = path.join(pluginDir, 'ruflo-gateway.mjs');
  const source = fs.readFileSync(template, 'utf8');
  const mcpPlaceholder = '/* AK_MANAGED_MCP_ENTRIES */ {}';
  const agentPlaceholder = '/* AK_MANAGED_AGENT_CATALOG */ []';
  const specialistPlaceholder = '/* AK_SPECIALIST_AGENT_PROMPT */ ""';
  assert.equal(source.split(mcpPlaceholder).length, 2, 'gateway template has one MCP placeholder');
  assert.equal(source.split(agentPlaceholder).length, 2, 'gateway template has one agent placeholder');
  assert.equal(source.split(specialistPlaceholder).length, 2, 'gateway template has one specialist placeholder');
  const specialistPrompt = 'You are the Agentic Kit specialist dispatcher for stock OpenCode.';
  fs.writeFileSync(pluginFile, source
    .replace(mcpPlaceholder, JSON.stringify(managedMcp))
    .replace(agentPlaceholder, JSON.stringify(agentCatalog))
    .replace(specialistPlaceholder, JSON.stringify(specialistPrompt)));
  return import(`${pathToFileURL(pluginFile).href}?v=${Date.now()}`);
}

test('gateway uses the ak-managed MCP command lazily and preserves the full live catalogue', async (t) => {
  const root = tmp('ak-oc-ruflo-gateway-');
  try {
    const server = path.join(root, 'fake-mcp.mjs');
    const log = path.join(root, 'mcp.log');
    const aqeLog = path.join(root, 'aqe-mcp.log');
    writeFakeMcp(server);
    const mcp = {
        'claude-flow': {
          type: 'local', command: [process.execPath, server], enabled: true,
          environment: { AK_FAKE_MCP_LOG: log },
        },
        'agentic-qe': {
          type: 'local', command: [process.execPath, server], enabled: true,
          environment: { AK_FAKE_MCP_LOG: aqeLog, AK_FAKE_MCP_KIND: 'aqe' },
        },
      };
    const mod = await loadGateway(root, mcp);
    const hooks = await mod.default();
    t.after(() => hooks.dispose());
    const cfg = {
      mcp,
      tools: { bash: true },
      permission: {
        edit: 'ask', ak_ruflo_call: 'ask',
        'claude-flow_*': 'allow', 'claude_flow_*': 'allow',
        'agentic-qe_*': 'allow', 'agentic_qe_*': 'allow',
      },
    };

    hooks.config(cfg);
    assert.equal(cfg.mcp['claude-flow'].enabled, true, 'Ruflo remains visibly connected in stock OpenCode');
    assert.equal(cfg.mcp['agentic-qe'].enabled, true, 'Agentic QE remains visibly connected in stock OpenCode');
    assert.equal(cfg.tools['claude-flow_*'], false);
    assert.equal(cfg.tools['claude_flow_*'], false);
    assert.equal(cfg.tools['agentic-qe_*'], false);
    assert.equal(cfg.tools['agentic_qe_*'], false);
    assert.equal(cfg.tools.bash, true, 'unrelated tool configuration preserved');
    assert.equal(cfg.permission.ak_ruflo_search, 'allow');
    assert.deepEqual(cfg.permission.ak_ruflo_call, { '*': 'ask' }, 'user gateway policy preserved');
    assert.equal(cfg.permission.ak_aqe_search, 'allow');
    assert.deepEqual(cfg.permission.ak_aqe_call, { '*': 'allow' });
    assert.equal(cfg.permission['claude-flow_*'], 'deny', 'eager Ruflo schemas are hidden from requests');
    assert.equal(cfg.permission['agentic-qe_*'], 'deny', 'eager AQE schemas are hidden from requests');
    assert.equal(fs.existsSync(log), false, 'Ruflo process is not started until a gateway tool is used');
    assert.equal(fs.existsSync(aqeLog), false, 'AQE process is not started until an AQE gateway tool is used');

    const context = toolContext();
    const search = await hooks.tool.ak_ruflo_search.execute({ query: 'semantic memory', limit: 4 }, context);
    const searchResult = JSON.parse(search);
    assert.match(searchResult.instruction, /arguments_json/);
    assert.equal(searchResult.matches[0].name, 'memory_search');
    assert.deepEqual(searchResult.matches[0].inputSchema.properties.query, { type: 'string' });
    const secondPage = JSON.parse(await hooks.tool.ak_ruflo_search.execute({ query: 'agent swarm' }, context));
    assert.equal(secondPage.matches[0].name, 'swarm_init', 'paginated catalogue remains fully searchable');

    const unknown = await hooks.tool.ak_ruflo_call.execute({ name: 'not_real', arguments_json: '{}' }, context);
    assert.match(unknown, /^RUFLO_CALL_FAILED: Unknown Ruflo operation/);
    const invalid = await hooks.tool.ak_ruflo_call.execute({
      name: 'memory_search', arguments_json: '{": ":"namespace","limit":2}',
    }, context);
    assert.match(invalid, /^RUFLO_CALL_FAILED: Invalid arguments for memory_search: missing required argument query/);
    const malformed = await hooks.tool.ak_ruflo_call.execute({
      name: 'memory_search', arguments_json: '{"query":',
    }, context);
    assert.match(malformed, /^RUFLO_CALL_FAILED: Invalid arguments_json for memory_search:/);
    const called = await hooks.tool.ak_ruflo_call.execute({
      name: 'memory_search', arguments_json: '{"query":"cache","limit":3}',
    }, context);
    assert.equal(called, 'called:memory_search:{"query":"cache","limit":3}');
    const structured = JSON.parse(await hooks.tool.ak_ruflo_call.execute({
      name: 'structured_result', arguments_json: '{}',
    }, context));
    assert.deepEqual(structured.structuredContent, { exact: true, nested: { count: 2 } });
    const decodedByProvider = await hooks.tool.ak_ruflo_call.execute({
      name: 'memory_search', arguments_json: { query: 'cache', limit: 2 },
    }, context);
    assert.match(decodedByProvider, /^RUFLO_CALL_FAILED: Invalid arguments_json/);

    const aqeSearch = JSON.parse(await hooks.tool.ak_aqe_search.execute({ query: 'quality gate' }, context));
    assert.equal(aqeSearch.matches[0].name, 'quality_assess');
    assert.match(aqeSearch.instruction, /fleet_init/);
    const aqeInvalid = await hooks.tool.ak_aqe_call.execute({
      name: 'quality_assess', arguments_json: '{}',
    }, context);
    assert.match(aqeInvalid, /^AQE_CALL_FAILED: Invalid arguments for quality_assess: missing required argument target/);
    const aqeCalled = await hooks.tool.ak_aqe_call.execute({
      name: 'quality_assess', arguments_json: '{"target":"working tree"}',
    }, context);
    assert.equal(aqeCalled, 'called:quality_assess:{"target":"working tree"}');

    const methods = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(methods.filter((method) => method === 'initialize').length, 1);
    assert.equal(methods.filter((method) => method === 'tools/list').length, 2, 'all pages loaded once, then catalogue cached');
    assert.equal(
      methods.filter((method) => method === 'tools/call').length,
      2,
      'unknown operations and malformed arguments never reach MCP',
    );
    const aqeMethods = fs.readFileSync(aqeLog, 'utf8').trim().split('\n');
    assert.equal(aqeMethods.filter((method) => method === 'initialize').length, 1);
    assert.equal(aqeMethods.filter((method) => method === 'tools/list').length, 1);
    assert.equal(aqeMethods.filter((method) => method === 'tools/call').length, 1);
    await hooks.dispose();
  } finally {
    rm(root);
  }
});

test('gateway coalesces concurrent catalogue startup and recovers from a timed-out stale child', async (t) => {
  const root = tmp('ak-oc-ruflo-gateway-recovery-');
  const priorTimeout = process.env.AK_OPENCODE_GATEWAY_TIMEOUT_MS;
  try {
    process.env.AK_OPENCODE_GATEWAY_TIMEOUT_MS = '80';
    const server = path.join(root, 'fake-mcp.mjs');
    const log = path.join(root, 'mcp.log');
    const marker = path.join(root, 'hung-once');
    writeFakeMcp(server);
    const mcp = {
      'claude-flow': {
        type: 'local', command: [process.execPath, server], enabled: true,
        environment: {
          AK_FAKE_MCP_LOG: log,
          AK_FAKE_MCP_FIRST_INIT_HANG_MARKER: marker,
          AK_FAKE_MCP_TERM_DELAY_MS: '30',
          AK_FAKE_MCP_INIT_DELAY_MS: '5',
          AK_FAKE_MCP_LIST_DELAY_MS: '20',
        },
      },
    };
    const mod = await loadGateway(root, mcp);
    const hooks = await mod.default();
    t.after(() => hooks.dispose());
    hooks.config({
      mcp,
      tools: {}, permission: { 'claude-flow_*': 'allow', 'claude_flow_*': 'allow' },
    });
    const context = toolContext();
    assert.match(
      await hooks.tool.ak_ruflo_search.execute({ query: 'memory' }, context),
      /^RUFLO_SEARCH_FAILED: Ruflo MCP request timed out/,
    );
    const [memory, swarm] = await Promise.all([
      hooks.tool.ak_ruflo_search.execute({ query: 'memory' }, context),
      hooks.tool.ak_ruflo_search.execute({ query: 'swarm' }, context),
    ]);
    assert.equal(JSON.parse(memory).matches[0].name, 'memory_search');
    assert.equal(JSON.parse(swarm).matches[0].name, 'swarm_init');
    const methods = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(methods.filter((method) => method === 'initialize').length, 2);
    assert.equal(methods.filter((method) => method === 'tools/list').length, 2,
      'concurrent searches share one post-recovery catalogue load');
    await hooks.dispose();
  } finally {
    if (priorTimeout === undefined) delete process.env.AK_OPENCODE_GATEWAY_TIMEOUT_MS;
    else process.env.AK_OPENCODE_GATEWAY_TIMEOUT_MS = priorTimeout;
    rm(root);
  }
});

test('gateway schema preserves arbitrary Ruflo arguments through one JSON string', async (t) => {
  const root = tmp('ak-oc-ruflo-gateway-schema-');
  try {
    const mod = await loadGateway(root);
    const hooks = await mod.default();
    t.after(() => hooks.dispose());
    const cfg = { mcp: {}, tools: {}, permission: {} };
    hooks.config(cfg);
    assert.equal(hooks.tool.ak_ruflo_call, undefined, 'absent Ruflo is not advertised');
    assert.equal(hooks.tool.ak_ruflo_search, undefined, 'absent Ruflo search is not advertised');
    assert.equal(hooks.tool.ak_aqe_call, undefined, 'absent AQE is not advertised');
    assert.equal(cfg.tools['claude-flow_*'], undefined, 'unowned direct tools are not blacklisted');
    await hooks.dispose();
  } finally {
    rm(root);
  }
});

test('gateway lazily discovers every installed OpenCode skill and agent without removing capability', async (t) => {
  const root = tmp('ak-oc-ruflo-gateway-discovery-');
  try {
    const server = path.join(root, 'fake-mcp.mjs');
    writeFakeMcp(server);
    const agentCatalog = [
      {
        name: 'code-review-swarm',
        description: 'Comprehensive multi-agent code review',
        body: 'Use claude-flow_swarm_init to coordinate the review. ' +
          'Use mcp__flow-nexus__sandbox_create only when that optional service is installed.',
      },
      {
        name: 'performance-analyzer',
        description: 'Performance profiling and optimization',
        body: 'Profile the target before changing it.',
      },
    ];
    const managed = {
      'claude-flow': { type: 'local', command: [process.execPath, server], enabled: true },
      'agentic-qe': {
        type: 'local', command: [process.execPath, server], enabled: true,
        environment: { AK_FAKE_MCP_KIND: 'aqe' },
      },
    };
    const mod = await loadGateway(root, managed, agentCatalog);
    const hooks = await mod.default();
    t.after(() => hooks.dispose());
    hooks.config({
      mcp: managed,
      agent: {
        'ak-specialist': {
          prompt: 'You are the Agentic Kit specialist dispatcher for stock OpenCode.',
        },
      },
      tools: {}, permission: {
        'claude-flow_*': 'allow', 'claude_flow_*': 'allow',
        'agentic-qe_*': 'allow', 'agentic_qe_*': 'allow',
      },
    });
    const system = {
      system: [
        'user-owned global guidance\n' +
        '<!-- BEGIN ruflo-reference -->large Claude-only AK reference<!-- END ruflo-reference -->\n' +
        '<available_skills>\n' +
        '<skill><name>memory-management</name><description>Semantic AgentDB memory search and storage</description></skill>\n' +
        '<skill><name>security-audit</name><description>Security scanning and vulnerability detection</description></skill>\n' +
        '</available_skills>',
      ],
    };
    const originalSystemArray = system.system;
    hooks['experimental.chat.system.transform']({ sessionID: 'session-a' }, system);
    assert.equal(system.system, originalSystemArray, 'stock OpenCode observes the in-place system mutation');
    assert.equal(system.system.length, 1, 'AK guidance stays inside the leading system message');
    assert.match(system.system[0], /user-owned global guidance/, 'non-AK user guidance survives');
    assert.doesNotMatch(system.system[0], /large Claude-only AK reference/);
    assert.doesNotMatch(system.system[0], /Semantic AgentDB memory search/, 'eager skill descriptions removed');
    assert.match(system.system[0], /ak_skill_search/);
    assert.match(system.system[0], /configured capability is preserved/);

    const loadedSkill = {
      output: 'Use mcp__claude-flow__memory_search and mcp__agentic-qe__quality_assess. ' +
        'For dynamic work, use mcp__claude-flow__*, claude-flow_*, and agentic-qe_*.',
    };
    hooks['tool.execute.after']({ tool: 'skill' }, loadedSkill);
    assert.match(loadedSkill.output, /ak_ruflo_call/);
    assert.match(loadedSkill.output, /ak_aqe_call/);
    assert.doesNotMatch(loadedSkill.output, /mcp__(?:claude-flow|agentic-qe)__/);
    assert.doesNotMatch(loadedSkill.output, /(?:claude-flow|agentic-qe)_\*/);

    const skillMatches = JSON.parse(await hooks.tool.ak_skill_search.execute(
      { query: 'semantic memory' }, toolContext({ sessionID: 'session-a' }),
    ));
    assert.equal(skillMatches[0].name, 'memory-management');

    const agentMatches = JSON.parse(await hooks.tool.ak_agent_search.execute(
      { query: 'code review' }, toolContext(),
    ));
    assert.equal(agentMatches.matches[0].name, 'code-review-swarm');
    assert.match(agentMatches.instruction, /subagent_type="ak-specialist"/);
    const loadedAgent = await hooks.tool.ak_agent_load.execute(
      { name: 'code-review-swarm' }, toolContext(),
    );
    assert.match(loadedAgent, /Agentic Kit specialist profile: code-review-swarm/);
    assert.match(loadedAgent, /ak_ruflo_call.*name="swarm_init"/);
    assert.match(loadedAgent, /Optional external MCP families named by this profile: `flow-nexus`/);
    assert.match(loadedAgent, /does not provision them/);
    assert.match(loadedAgent, /mcp__flow-nexus__sandbox_create/);
    assert.doesNotMatch(loadedAgent, /mcp__(?:claude-flow|claude_flow|ruflo)__/);

    assert.match(
      await hooks.tool.ak_skill_search.execute(
        { query: 'does-not-exist' }, toolContext({ sessionID: 'session-a' }),
      ),
      /\[\]/,
      'a miss is an empty result, not capability loss',
    );
    await hooks.dispose();
  } finally {
    rm(root);
  }
});

test('skill discovery is isolated per OpenCode session and empty catalogues replace prior state', async (t) => {
  const root = tmp('ak-oc-ruflo-gateway-session-skills-');
  try {
    const mod = await loadGateway(root);
    const hooks = await mod.default();
    t.after(() => hooks.dispose());
    hooks.config({ mcp: {}, tools: {}, permission: {} });

    const systemA = { system: [
      '<available_skills><skill><name>project-a-only</name>' +
      '<description>Private project A capability</description></skill></available_skills>',
    ] };
    hooks['experimental.chat.system.transform']({ sessionID: 'session-a' }, systemA);
    const foundA = JSON.parse(await hooks.tool.ak_skill_search.execute(
      { query: 'private capability' }, toolContext({ sessionID: 'session-a' }),
    ));
    assert.equal(foundA[0].name, 'project-a-only');

    const systemB = { system: ['No project skills are installed.'] };
    hooks['experimental.chat.system.transform']({ sessionID: 'session-b' }, systemB);
    assert.match(
      await hooks.tool.ak_skill_search.execute(
        { query: 'private capability' }, toolContext({ sessionID: 'session-b' }),
      ),
      /^AK_SKILL_SEARCH_FAILED:/,
    );
    assert.equal(
      JSON.parse(await hooks.tool.ak_skill_search.execute(
        { query: 'private capability' }, toolContext({ sessionID: 'session-a' }),
      ))[0].name,
      'project-a-only',
    );
    await hooks.event({
      event: { type: 'session.deleted', properties: { info: { id: 'session-a' } } },
    });
    assert.match(
      await hooks.tool.ak_skill_search.execute(
        { query: 'private capability' }, toolContext({ sessionID: 'session-a' }),
      ),
      /^AK_SKILL_SEARCH_FAILED:/,
    );
  } finally {
    rm(root);
  }
});

test('aborted side-effecting MCP calls request protocol cancellation exactly once', async (t) => {
  const root = tmp('ak-oc-ruflo-gateway-cancel-');
  try {
    const server = path.join(root, 'fake-mcp.mjs');
    const log = path.join(root, 'mcp.log');
    const cancelLog = path.join(root, 'cancel.log');
    writeFakeMcp(server);
    const mcp = {
      'claude-flow': {
        type: 'local', command: [process.execPath, server], enabled: true,
        environment: {
          AK_FAKE_MCP_LOG: log,
          AK_FAKE_MCP_CANCEL_LOG: cancelLog,
          AK_FAKE_MCP_CALL_DELAY_MS: '100',
        },
      },
    };
    const mod = await loadGateway(root, mcp);
    const hooks = await mod.default();
    t.after(() => hooks.dispose());
    hooks.config({
      mcp, tools: {},
      permission: { 'claude-flow_*': 'allow', 'claude_flow_*': 'allow' },
    });
    const warm = toolContext({ sessionID: 'cancel-session' });
    await hooks.tool.ak_ruflo_search.execute({ query: 'memory' }, warm);

    const controller = new AbortController();
    const pending = hooks.tool.ak_ruflo_call.execute(
      { name: 'memory_search', arguments_json: '{"query":"side effect"}' },
      toolContext({ sessionID: 'cancel-session', abort: controller.signal }),
    );
    setTimeout(() => controller.abort(), 15);
    assert.match(await pending, /^RUFLO_CALL_FAILED: Ruflo request cancelled$/);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const methods = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(methods.filter((method) => method === 'tools/call').length, 1);
    assert.equal(methods.filter((method) => method === 'notifications/cancelled').length, 1);
    const cancellation = JSON.parse(fs.readFileSync(cancelLog, 'utf8').trim());
    assert.equal(typeof cancellation.requestId, 'number');
    assert.match(cancellation.reason, /Ruflo request cancelled/);
  } finally {
    rm(root);
  }
});

test('skill rewriting follows the actually managed Ruflo and AQE capabilities', async (t) => {
  for (const [label, mcp, rewritten, retained] of [
    [
      'ruflo-only',
      { 'claude-flow': { type: 'local', command: [process.execPath, '/bin/true'], enabled: true } },
      /ak_ruflo_call/,
      /mcp__agentic-qe__quality_assess/,
    ],
    [
      'aqe-only',
      { 'agentic-qe': { type: 'local', command: [process.execPath, '/bin/true'], enabled: true } },
      /ak_aqe_call/,
      /mcp__claude-flow__memory_search/,
    ],
  ]) {
    const root = tmp(`ak-oc-ruflo-gateway-${label}-`);
    try {
      const mod = await loadGateway(root, mcp);
      const hooks = await mod.default();
      t.after(() => hooks.dispose());
      const permission = label === 'ruflo-only'
        ? { 'claude-flow_*': 'allow', 'claude_flow_*': 'allow' }
        : { 'agentic-qe_*': 'allow', 'agentic_qe_*': 'allow' };
      hooks.config({ mcp, tools: {}, permission });
      const loadedSkill = {
        output: 'Use mcp__claude-flow__memory_search, ' +
          'mcp__plugin_ruflo-core_ruflo__memory_list, and mcp__agentic-qe__quality_assess.',
      };
      hooks['tool.execute.after']({ tool: 'skill' }, loadedSkill);
      assert.match(loadedSkill.output, rewritten, `${label} rewrites its managed family`);
      assert.match(loadedSkill.output, retained, `${label} preserves the unavailable family`);
      if (label === 'ruflo-only') {
        assert.match(loadedSkill.output, /ak_ruflo_call.*memory_list/,
          'Claude plugin-qualified Ruflo refs use the same lazy operation call');
        assert.doesNotMatch(loadedSkill.output, /mcp__plugin_ruflo-core_ruflo__/);
      }
      await hooks.dispose();
    } finally {
      rm(root);
    }
  }
});

test('gateway refuses post-sync MCP drift without disabling or blacklisting user tools', async (t) => {
  const root = tmp('ak-oc-ruflo-gateway-drift-');
  try {
    const expected = {
      'claude-flow': { type: 'local', command: ['node', 'ak-server.mjs'], enabled: true },
    };
    const mod = await loadGateway(root, expected);
    const hooks = await mod.default();
    t.after(() => hooks.dispose());
    const userEntry = { type: 'local', command: ['node', 'user-server.mjs'], enabled: true };
    const cfg = {
      mcp: { 'claude-flow': userEntry }, tools: { bash: true },
      permission: { 'claude-flow_*': 'allow', 'claude_flow_*': 'allow' },
    };
    hooks.config(cfg);
    assert.deepEqual(cfg.mcp['claude-flow'], userEntry, 'drifted user entry is untouched');
    assert.equal(cfg.tools['claude-flow_*'], undefined, 'drifted family is not blacklisted');
    assert.equal(hooks.tool.ak_ruflo_search, undefined, 'drifted family is not captured');
    assert.equal(hooks.tool.ak_ruflo_call, undefined, 'drifted family cannot be spawned');
  } finally {
    rm(root);
  }
});

test('gateway honors an explicit user request to keep a direct tool family enabled', async (t) => {
  const root = tmp('ak-oc-ruflo-gateway-tools-policy-');
  try {
    const expected = {
      'claude-flow': { type: 'local', command: ['node', 'ak-server.mjs'], enabled: true },
    };
    const mod = await loadGateway(root, expected);
    const hooks = await mod.default();
    t.after(() => hooks.dispose());
    const cfg = {
      mcp: structuredClone(expected),
      tools: { 'claude-flow_*': true, bash: true },
      permission: { 'claude-flow_*': 'allow', 'claude_flow_*': 'allow' },
    };
    hooks.config(cfg);
    assert.equal(cfg.mcp['claude-flow'].enabled, true);
    assert.equal(cfg.tools['claude-flow_*'], true);
    assert.equal(hooks.tool.ak_ruflo_search, undefined);
    assert.equal(hooks.tool.ak_ruflo_call, undefined);
  } finally {
    rm(root);
  }
});

test('gateway preserves every user tools policy that targets a managed family', async (t) => {
  for (const [label, policy] of [
    ['family false', { 'claude-flow_*': false }],
    ['subgroup false', { 'claude-flow_memory_*': false }],
    ['exact true', { 'claude-flow_memory_store': true }],
    ['underscore exact false', { claude_flow_memory_search: false }],
  ]) {
    const root = tmp(`ak-oc-ruflo-gateway-tools-policy-${label.replace(/\s+/g, '-')}-`);
    try {
      const expected = {
        'claude-flow': { type: 'local', command: ['node', 'ak-server.mjs'], enabled: true },
      };
      const mod = await loadGateway(root, expected);
      const hooks = await mod.default();
      t.after(() => hooks.dispose());
      const cfg = {
        mcp: structuredClone(expected),
        tools: { ...policy, bash: true },
        permission: { 'claude-flow_*': 'allow', 'claude_flow_*': 'allow' },
      };
      hooks.config(cfg);
      assert.deepEqual(
        Object.fromEntries(Object.keys(policy).map((key) => [key, cfg.tools[key]])),
        policy,
        `${label}: user policy preserved exactly`,
      );
      assert.equal(hooks.tool.ak_ruflo_search, undefined, `${label}: family remains direct`);
      assert.equal(hooks.tool.ak_ruflo_call, undefined, `${label}: gateway cannot bypass policy`);
    } finally {
      rm(root);
    }
  }
});

test('gateway honors post-sync permission drift without granting a bypass', async (t) => {
  const root = tmp('ak-oc-ruflo-gateway-permission-drift-');
  try {
    const expected = {
      'claude-flow': { type: 'local', command: ['node', 'ak-server.mjs'], enabled: true },
    };
    const mod = await loadGateway(root, expected);
    const hooks = await mod.default();
    t.after(() => hooks.dispose());
    const cfg = {
      mcp: structuredClone(expected), tools: {},
      permission: { 'claude-flow_*': 'ask', 'claude_flow_*': 'allow' },
    };
    hooks.config(cfg);
    assert.equal(cfg.mcp['claude-flow'].enabled, true);
    assert.equal(cfg.permission['claude-flow_*'], 'ask');
    assert.equal(cfg.permission.ak_ruflo_search, undefined);
    assert.equal(hooks.tool.ak_ruflo_search, undefined);
    assert.equal(hooks.tool.ak_ruflo_call, undefined);
  } finally {
    rm(root);
  }
});

test('gateway projects a granular direct-operation deny and never reaches MCP', async (t) => {
  const root = tmp('ak-oc-ruflo-gateway-granular-deny-');
  try {
    const server = path.join(root, 'fake-mcp.mjs');
    const log = path.join(root, 'mcp.log');
    writeFakeMcp(server);
    const expected = {
      'claude-flow': {
        type: 'local', command: [process.execPath, server], enabled: true,
        environment: { AK_FAKE_MCP_LOG: log },
      },
    };
    const mod = await loadGateway(root, expected);
    const hooks = await mod.default();
    t.after(() => hooks.dispose());
    const cfg = {
      mcp: structuredClone(expected), tools: {},
      permission: {
        'claude-flow_*': 'allow',
        'claude_flow_*': 'allow',
        claude_flow_memory_store: 'deny',
      },
    };
    hooks.config(cfg);
    assert.equal(cfg.permission.ak_ruflo_call.memory_store, 'deny');
    const denied = await hooks.tool.ak_ruflo_call.execute(
      { name: 'memory_store', arguments_json: '{"key":"must-not-run","value":"x"}' },
      toolContext({
        ask: async (request) => {
          assert.equal(request.permission, 'ak_ruflo_call');
          assert.deepEqual(request.patterns, ['memory_store']);
          throw new Error('permission denied');
        },
      }),
    );
    assert.match(denied, /^RUFLO_CALL_FAILED: permission denied$/);
    assert.equal(fs.existsSync(log), false, 'denied operation never starts or calls the MCP server');
  } finally {
    rm(root);
  }
});

test('dispose reaps a TERM-ignoring MCP child before returning', async (t) => {
  const root = tmp('ak-oc-ruflo-gateway-reap-');
  try {
    const server = path.join(root, 'fake-mcp.mjs');
    const pidFile = path.join(root, 'mcp.pid');
    writeFakeMcp(server);
    const mcp = {
      'claude-flow': {
        type: 'local', command: [process.execPath, server], enabled: true,
        environment: { AK_FAKE_MCP_PID_FILE: pidFile, AK_FAKE_MCP_IGNORE_TERM: '1' },
      },
    };
    const mod = await loadGateway(root, mcp);
    const hooks = await mod.default();
    t.after(() => hooks.dispose());
    hooks.config({
      mcp, tools: {},
      permission: { 'claude-flow_*': 'allow', 'claude_flow_*': 'allow' },
    });
    const context = toolContext();
    await hooks.tool.ak_ruflo_search.execute({ query: 'memory' }, context);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.doesNotThrow(() => process.kill(pid, 0), 'fixture child is live before dispose');
    await hooks.dispose();
    assert.throws(() => process.kill(pid, 0), 'dispose waits through SIGKILL and reaps child');
  } finally {
    rm(root);
  }
});
