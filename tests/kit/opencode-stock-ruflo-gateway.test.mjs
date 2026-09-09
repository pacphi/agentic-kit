import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  extractStockOpenCodeVersion,
  isSupportedStockOpenCodeVersion,
  STOCK_OPENCODE_VERSION_RANGE,
} from './helpers/opencode-version-policy.mjs';

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkgRoot = process.env.AK_STOCK_PACKAGE_ROOT
  ? path.resolve(process.env.AK_STOCK_PACKAGE_ROOT)
  : harnessRoot;
const {
  catalogSource,
  GATEWAY_PLUGIN_NAME,
  opencodeStack,
  PLUGIN_NAME,
} = await import(pathToFileURL(path.join(pkgRoot, 'src', 'lib', 'opencode.mjs')).href);
const COMPACT_TOOL_LIMIT = 25;
const COMPACT_SCHEMA_BYTE_LIMIT = 30_000;
const COMPACT_REQUEST_BYTE_LIMIT = 45_000;
const EAGER_DIRECT_TOOL_FLOOR = 400;
const EAGER_SCHEMA_BYTE_FLOOR = 300_000;
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stockOpenCode() {
  if (process.env.AK_STOCK_OPENCODE_BIN) return process.env.AK_STOCK_OPENCODE_BIN;
  try {
    return execFileSync('sh', ['-c', 'command -v opencode'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function installedCommand(name) {
  try {
    return execFileSync('sh', ['-c', `command -v ${name}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function writeFakeMcp(file) {
  writeExecutable(file, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const basename = require('node:path').basename(process.argv[1])
const kind = basename.includes('aqe') ? 'aqe' : basename.includes('brain') ? 'brain' : 'ruflo'
const log = process.env.AK_STOCK_GATEWAY_MCP_LOG
const record = (msg) => {
  if (log) fs.appendFileSync(log, JSON.stringify({ pid: process.pid, kind, ...msg }) + '\\n')
}
record({ method: 'process/start' })
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  record({ method: msg.method, params: msg.params })
  if (msg.id == null) return
  if (msg.method === 'initialize') return send(msg.id, {
    protocolVersion: '2024-11-05', capabilities: { tools: {} },
    serverInfo: { name: 'ak-stock-' + kind, version: '1.0.0' },
  })
  if (msg.method === 'tools/list') return send(msg.id, { tools: kind === 'brain' ? [
    { name: 'search_ruvnet', description: 'Search grounded RuvNet sources', inputSchema: { type: 'object', properties: { query: { type: 'string' }, k: { type: 'number' } }, required: ['query'] } },
  ] : kind === 'aqe' ? [
    { name: 'fleet_init', description: 'Initialize the QE fleet', inputSchema: { type: 'object', properties: {} } },
    { name: 'quality_assess', description: 'Assess quality', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  ] : [
    { name: 'memory_search', description: 'Semantic project memory search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'swarm_init', description: 'Initialize an agent swarm', inputSchema: { type: 'object', properties: {} } },
  ] })
  if (msg.method === 'tools/call') return send(msg.id, { content: [{ type: 'text', text: 'called:' + msg.params.name + ':' + JSON.stringify(msg.params.arguments) }] })
  send(msg.id, {})
})
`);
}

function writeCatalog(root) {
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'stock-gateway-fixture', version: '1.0.0' }));
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'memory-specialist.md'), [
    '---', 'description: Memory specialist', '---', '', 'Use mcp__claude-flow__memory_search.', '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'memory', 'SKILL.md'), [
    '---', 'name: memory', 'description: Search project memory', '---', '', '# Memory', '',
  ].join('\n'));
  return root;
}

function seedStockPluginRuntime(configDir, cacheDir, version) {
  // OpenCode reports /global/health before a fresh config's plugin dependency
  // install finishes. Seed the exact SDK so /mcp measures instance readiness,
  // not registry latency or a blocked background installer.
  execFileSync('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact',
    `@opencode-ai/plugin@${version}`,
  ], {
    cwd: configDir,
    env: { ...process.env, npm_config_cache: cacheDir },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 45_000,
  });
  const installed = JSON.parse(fs.readFileSync(
    path.join(configDir, 'node_modules', '@opencode-ai', 'plugin', 'package.json'),
    'utf8',
  ));
  assert.equal(installed.version, version,
    'fixture plugin runtime must exactly match the stock OpenCode version');
}

function createProvider(requests, route, { agentProfile, skillName }) {
  let server;
  const ready = new Promise((resolve) => {
    server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const names = tools.map((entry) => entry?.function?.name || entry?.name).filter(Boolean);
      const toolResults = (body.messages || []).filter((message) => message.role === 'tool');
      const created = Math.floor(Date.now() / 1000);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      const respondText = (content) => response.end(`data: ${JSON.stringify({ id: 'gateway', object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      const respondTool = (functionCall) => {
        response.write(`data: ${JSON.stringify({ id: 'gateway', object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${route}-${toolResults.length}`, type: 'function', function: functionCall }] }, finish_reason: null }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ id: 'gateway', object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      };
      const callTool = route === 'brain'
        ? 'ruvnet-brain_search_ruvnet'
        : route === 'skill' ? 'ak_skill_search'
          : route === 'agent' ? 'ak_agent_search'
            : route === 'aqe' ? 'ak_aqe_call' : 'ak_ruflo_call';
      if (!names.includes(callTool)) {
        respondText('title');
        return;
      }
      if (route === 'agent') {
        const specialist = JSON.stringify(body.messages || []).includes(`PROFILE: ${agentProfile}`);
        if (specialist) {
          if (toolResults.length === 0) {
            respondTool({ name: 'ak_agent_load', arguments: JSON.stringify({ name: agentProfile }) });
          } else {
            respondText(`specialist child complete: ${agentProfile} profile loaded`);
          }
          return;
        }
        if (toolResults.length === 0) {
          respondTool({ name: 'ak_agent_search', arguments: JSON.stringify({ query: 'project memory specialist', limit: 2 }) });
        } else if (toolResults.length === 1) {
          respondTool({
            name: 'task',
            arguments: JSON.stringify({
              description: 'Run the memory specialist',
              prompt: `PROFILE: ${agentProfile}\nSearch project memory for kata.`,
              subagent_type: 'ak-specialist',
            }),
          });
        } else {
          respondText('specialist parent complete');
        }
        return;
      }
      const functionCall = toolResults.length === 0
        ? route === 'brain'
          ? { name: 'ruvnet-brain_search_ruvnet', arguments: JSON.stringify({ query: 'AgentDB memory capabilities', k: 2 }) }
          : route === 'skill'
            ? { name: 'ak_skill_search', arguments: JSON.stringify({ query: 'project memory', limit: 2 }) }
          : route === 'aqe'
            ? { name: 'ak_aqe_search', arguments: JSON.stringify({ query: 'fleet initialization', limit: 2 }) }
            : { name: 'ak_ruflo_search', arguments: JSON.stringify({ query: 'semantic project memory', limit: 2 }) }
        : route === 'aqe'
          ? { name: 'ak_aqe_call', arguments: JSON.stringify({ name: 'fleet_init', arguments_json: '{}' }) }
          : route === 'skill'
            ? { name: 'skill', arguments: JSON.stringify({ name: skillName }) }
          : { name: 'ak_ruflo_call', arguments: JSON.stringify({ name: 'memory_search', arguments_json: JSON.stringify({ query: 'kata' }) }) };
      if (toolResults.length < (route === 'brain' ? 1 : 2)) {
        respondTool(functionCall);
        return;
      }
      respondText('gateway complete');
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  return {
    ready,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

async function waitFor(predicate, message, attempts = 160) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await delay(50);
  }
  throw new Error(`${message}: ${last?.message ?? JSON.stringify(last)}`);
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    delay(2_000).then(() => { if (child.exitCode == null) child.kill('SIGKILL'); }),
  ]);
}

const opencode = stockOpenCode();
const installedRuv = process.env.AK_STOCK_RUV_MODE === 'installed';
const installedCatalog = process.env.AK_STOCK_CATALOG_MODE === 'installed';
const compactProjection = process.env.AK_STOCK_PROJECTION_MODE !== 'eager';
const route = ['agent', 'aqe', 'brain', 'skill'].includes(process.env.AK_STOCK_RUV_ROUTE)
  ? process.env.AK_STOCK_RUV_ROUTE
  : 'ruflo';
const installedBrainShim = process.env.AK_STOCK_BRAIN_SHIM
  || path.join(os.homedir(), '.claude', 'ruvnet-brain', 'mcp', 'server.mjs');
const installedCatalogSource = installedCatalog ? catalogSource() : undefined;
const agentProfile = installedCatalog ? 'coder' : 'memory-specialist';
const skillName = installedCatalog ? 'memory-search' : 'memory';
const installedRuvCommands = installedRuv
  ? {
      ruflo: installedCommand('claude-flow-mcp'),
      aqe: installedCommand('aqe-mcp'),
      brain: fs.existsSync(installedBrainShim) ? installedBrainShim : '',
    }
  : {};
const acceptanceSkip = !opencode
  ? 'stock opencode is not installed'
  : installedRuv && (!installedRuvCommands.ruflo || !installedRuvCommands.aqe
      || (route === 'brain' && !installedRuvCommands.brain))
    ? 'installed claude-flow-mcp and aqe-mcp are required for AK_STOCK_RUV_MODE=installed'
    : installedCatalog && !installedCatalogSource
      ? 'an installed Ruflo catalog is required for AK_STOCK_CATALOG_MODE=installed'
      : !compactProjection && !installedRuv
        ? 'AK_STOCK_PROJECTION_MODE=eager requires AK_STOCK_RUV_MODE=installed'
    : false;

test(`stock OpenCode keeps Ruflo and Agentic QE connected with ${compactProjection ? `one compact lazy ${route} call path` : 'the eager direct catalogue'} (${installedRuv ? 'installed MCPs' : 'fixture MCPs'}, ${installedCatalog ? 'installed catalog' : 'fixture catalog'})`, {
  skip: acceptanceSkip,
  timeout: 90_000,
}, async (t) => {
  const root = tmp('ak-stock-opencode-ruflo-');
  const requests = [];
  const provider = createProvider(requests, route, { agentProfile, skillName });
  const processes = { opencode: undefined };
  const output = [];
  let phase = 'fixture setup';
  let completed = false;
  t.after(async () => {
    if (!completed) {
      t.diagnostic(JSON.stringify({
        failedPhase: phase,
        providerRequests: requests.length,
        opencodeTail: output.join('').slice(-12_000),
      }));
    }
    await stop(processes.opencode);
    await provider.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const reportedVersion = execFileSync(opencode, ['--version'], { encoding: 'utf8' }).trim();
  const binarySha256 = createHash('sha256').update(fs.readFileSync(opencode)).digest('hex');
  const version = extractStockOpenCodeVersion(reportedVersion);
  assert.equal(
    isSupportedStockOpenCodeVersion(version), true,
    `unsupported stock OpenCode version '${reportedVersion}'; supported range is ${STOCK_OPENCODE_VERSION_RANGE} (${binarySha256})`,
  );

  const configHome = path.join(root, 'config');
  const configDir = path.join(configHome, 'opencode');
  const configFile = path.join(configDir, 'opencode.json');
  const pluginsDir = path.join(configDir, 'plugins');
  const agentsDir = path.join(configDir, 'agents');
  const skillsDir = path.join(configDir, 'skills');
  const workspace = path.join(root, 'workspace');
  const fakeBin = path.join(root, 'bin');
  const fixtureBrainShim = path.join(fakeBin, 'brain-server.cjs');
  const mcpLog = path.join(root, 'mcp.jsonl');
  const providerPort = await provider.ready;
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  if (!installedRuv) {
    writeFakeMcp(path.join(fakeBin, 'claude-flow-mcp'));
    writeFakeMcp(path.join(fakeBin, 'aqe-mcp'));
    if (route === 'brain') writeFakeMcp(fixtureBrainShim);
  }
  fs.writeFileSync(configFile, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: 'local/acceptance-model',
    snapshot: false,
    lsp: false,
    provider: {
      local: {
        npm: '@ai-sdk/openai-compatible', name: 'AK stock acceptance',
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'local' },
        models: {
          'acceptance-model': {
            name: 'Acceptance model', tool_call: true, temperature: true,
            cost: { input: 0, output: 0 }, limit: { context: 131072, output: 4096 },
          },
        },
      },
    },
  }, null, 2));

  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  try {
    const cfg = {
      aqe: true,
      integrations: {
        version: 2, hosts: { claude: false, codex: false, opencode: true }, bindings: [],
        ownership: {
          opencode: {
            mcp: null,
            managed: null,
            catalogDir: installedCatalog
              ? installedCatalogSource.root
              : writeCatalog(path.join(root, 'catalog')),
          },
        },
      },
      routing: { version: 1, primaryHost: 'opencode', routes: {} }, providers: {},
    };
    phase = 'Agentic Kit convergence';
    const stack = await opencodeStack(cfg, {
      pkgRoot, configFile, pluginsDir, agentsDir, skillsDir,
      brainShim: route === 'brain'
        ? installedRuv ? installedBrainShim : fixtureBrainShim
        : path.join(root, 'missing-brain-shim.mjs'),
    });
    assert.equal(stack.oc.ok, true);
    assert.equal(stack.gateway.ok, true);
    assert.equal(stack.agents.ok, true);
    // This focused slice exercises the MCP/gateway contract only. The separate
    // lifecycle bridge intentionally launches Ruflo hooks and daemons, which
    // would make an otherwise hermetic stock-host acceptance depend on the
    // developer's globally installed Ruflo runtime.
    fs.rmSync(path.join(pluginsDir, PLUGIN_NAME));
    if (!compactProjection) fs.rmSync(path.join(pluginsDir, GATEWAY_PLUGIN_NAME));
  } finally {
    process.env.PATH = previousPath;
  }

  phase = 'fixture dependency setup';
  seedStockPluginRuntime(configDir, path.join(root, 'npm-cache'), version);

  phase = 'stock OpenCode startup';
  const port = await freePort();
  processes.opencode = spawn(opencode, ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs', '--log-level', 'DEBUG'], {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: path.join(root, 'home'),
      XDG_CONFIG_HOME: configHome,
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_STATE_HOME: path.join(root, 'state'),
      TMPDIR: path.join(root, 'tmp'),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      AK_STOCK_GATEWAY_MCP_LOG: mcpLog,
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.opencode.stdout.on('data', (chunk) => output.push(String(chunk)));
  processes.opencode.stderr.on('data', (chunk) => output.push(String(chunk)));
  const endpoint = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${endpoint}/global/health`, {
    signal: AbortSignal.timeout(2_000),
  })).ok, 'stock OpenCode did not become healthy');

  const directory = `directory=${encodeURIComponent(workspace)}`;
  phase = 'MCP connection';
  const mcp = await waitFor(async () => {
    const response = await fetch(`${endpoint}/mcp?${directory}`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const status = await response.json();
    return status['claude-flow']?.status === 'connected' && status['agentic-qe']?.status === 'connected'
      && (route !== 'brain' || status['ruvnet-brain']?.status === 'connected')
      ? status : false;
  }, 'Ruflo and Agentic QE did not both connect');
  assert.equal(mcp['claude-flow'].status, 'connected');
  assert.equal(mcp['agentic-qe'].status, 'connected');
  if (route === 'brain') assert.equal(mcp['ruvnet-brain'].status, 'connected');

  phase = 'session creation';
  const sessionResponse = await fetch(`${endpoint}/session?${directory}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'AK stock gateway acceptance' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!sessionResponse.ok) throw new Error(`session create failed: ${await sessionResponse.text()}`);
  const session = await sessionResponse.json();
  phase = 'prompt submission';
  const promptResponse = await fetch(`${endpoint}/session/${session.id}/prompt_async?${directory}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent: 'build', model: { providerID: 'local', modelID: 'acceptance-model' },
      parts: [{ type: 'text', text: 'Use Agentic Kit to search project memory for kata.' }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (promptResponse.status !== 204) {
    throw new Error(`prompt failed with HTTP ${promptResponse.status}: ${await promptResponse.text()}`);
  }

  if (!compactProjection) {
    phase = 'eager request capture';
    const eagerRequest = await waitFor(() => requests.find((body) => (body.tools || []).some(
      (entry) => /^(?:claude[-_]flow|agentic[-_]qe)_/.test(entry?.function?.name || entry?.name),
    )), `stock OpenCode did not advertise the eager installed catalogues\n${output.join('')}`);
    const eagerNames = eagerRequest.tools
      .map((entry) => entry?.function?.name || entry?.name)
      .filter(Boolean);
    const direct = eagerNames.filter((name) => /^(?:claude[-_]flow|agentic[-_]qe)_/.test(name));
    const toolSchemaBytes = Buffer.byteLength(JSON.stringify(eagerRequest.tools));
    assert.ok(direct.length >= EAGER_DIRECT_TOOL_FLOOR,
      `expected at least ${EAGER_DIRECT_TOOL_FLOOR} direct Ruflo/AQE tools, got ${direct.length}`);
    assert.ok(toolSchemaBytes >= EAGER_SCHEMA_BYTE_FLOOR,
      `expected at least ${EAGER_SCHEMA_BYTE_FLOOR} eager schema bytes, got ${toolSchemaBytes}`);
    assert.equal(eagerNames.some((name) => name.startsWith('ak_ruflo_') || name.startsWith('ak_aqe_')), false);
    t.diagnostic(JSON.stringify({
      projection: 'eager',
      opencode: version,
      binarySha256,
      mcp: { claudeFlow: mcp['claude-flow'].status, agenticQe: mcp['agentic-qe'].status },
      advertisedTools: eagerNames.length,
      directRufloOrAqeTools: direct.length,
      toolSchemaBytes,
      providerRequestBytes: Buffer.byteLength(JSON.stringify(eagerRequest)),
    }));
    completed = true;
    return;
  }

  phase = 'compact tool continuation';
  const mainRequests = await waitFor(() => {
    const matching = requests.filter((body) => (body.tools || []).some(
      (entry) => (entry?.function?.name || entry?.name) === (route === 'brain'
        ? 'ruvnet-brain_search_ruvnet'
        : route === 'skill' ? 'ak_skill_search'
          : route === 'agent' ? 'ak_agent_search'
            : route === 'aqe' ? 'ak_aqe_call' : 'ak_ruflo_call'),
    ));
    return matching.some((body) => (body.messages || []).filter(
      (message) => message.role === 'tool',
    ).length >= (route === 'brain' ? 1 : 2))
      ? matching : false;
  }, `stock OpenCode did not complete the lazy search/call loop\n${output.join('')}`);

  const names = mainRequests[0].tools.map((entry) => entry?.function?.name || entry?.name).filter(Boolean);
  assert.ok(names.includes('ak_ruflo_search'));
  assert.ok(names.includes('ak_ruflo_call'));
  assert.ok(names.includes('ak_aqe_search'));
  assert.ok(names.includes('ak_aqe_call'));
  const toolSchemaBytes = Buffer.byteLength(JSON.stringify(mainRequests[0].tools));
  const providerRequestBytes = Buffer.byteLength(JSON.stringify(mainRequests[0]));
  assert.ok(names.length <= COMPACT_TOOL_LIMIT,
    `compact request exceeded ${COMPACT_TOOL_LIMIT} tools: ${names.length}`);
  assert.ok(toolSchemaBytes <= COMPACT_SCHEMA_BYTE_LIMIT,
    `compact schemas exceeded ${COMPACT_SCHEMA_BYTE_LIMIT} bytes: ${toolSchemaBytes}`);
  assert.ok(providerRequestBytes <= COMPACT_REQUEST_BYTE_LIMIT,
    `compact provider request exceeded ${COMPACT_REQUEST_BYTE_LIMIT} bytes: ${providerRequestBytes}`);
  assert.equal(names.some((name) => name.startsWith('claude-flow_') || name.startsWith('claude_flow_')), false);
  assert.equal(names.some((name) => name.startsWith('agentic-qe_') || name.startsWith('agentic_qe_')), false);

  const continuation = mainRequests.find((body) => {
    const toolMessages = (body.messages || []).filter((message) => message.role === 'tool');
    return toolMessages.length >= (route === 'brain' ? 1 : 2);
  });
  const continuationText = JSON.stringify(continuation);
  assert.match(continuationText, route === 'brain'
    ? /search_ruvnet/
    : route === 'skill' ? new RegExp(skillName)
      : route === 'agent' ? new RegExp(`specialist child complete: ${agentProfile}`)
        : route === 'aqe' ? /fleet_init/ : /memory_search/);
  if (route === 'ruflo') assert.match(continuationText, /kata/);
  assert.doesNotMatch(continuationText, /(?:RUFLO|AQE)_(?:(?:SEARCH|CALL)_FAILED|ERROR)/);
  assert.doesNotMatch(continuationText, /"type":"tool-error"/);
  if (route === 'skill' && installedCatalog) {
    assert.match(continuationText, /ak_ruflo_call/,
      'installed skill rewrites Claude plugin-qualified Ruflo operations lazily');
    assert.doesNotMatch(continuationText, /mcp__plugin_ruflo-core_ruflo__/);
  }
  if (route === 'agent') {
    const loadedProfile = requests.find((body) => JSON.stringify(
      (body.messages || []).filter((message) => message.role === 'tool'),
    ).includes(`Agentic Kit specialist profile: ${agentProfile}`));
    assert.ok(loadedProfile, 'stock task child did not receive the receipt-owned specialist profile');
    const loadedProfileText = JSON.stringify(
      (loadedProfile.messages || []).filter((message) => message.role === 'tool'),
    );
    if (installedCatalog) {
      assert.match(loadedProfileText, /ak_ruflo_call/,
        'installed specialist rewrites managed Ruflo operations lazily');
      assert.doesNotMatch(loadedProfileText, /mcp__(?:claude-flow|claude_flow|ruflo)__/);
      assert.doesNotMatch(loadedProfileText, /(?:claude-flow|claude_flow)_/);
    }
    const childNames = (loadedProfile.tools || [])
      .map((entry) => entry?.function?.name || entry?.name)
      .filter(Boolean);
    assert.equal(childNames.some((name) => /^(?:claude[-_]flow|agentic[-_]qe)_/.test(name)), false);
  }
  if (!installedRuv && !['agent', 'skill'].includes(route)) {
    assert.match(continuationText, route === 'brain'
      ? /called:search_ruvnet/
      : route === 'aqe' ? /called:fleet_init/ : /called:memory_search/);
    const mcpRows = fs.readFileSync(mcpLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(mcpRows.some((row) => row.kind === route && row.method === 'tools/call'
      && row.params?.name === (route === 'brain'
        ? 'search_ruvnet'
        : route === 'aqe' ? 'fleet_init' : 'memory_search')
      && (route === 'aqe' || row.params?.arguments?.query === (route === 'brain'
        ? 'AgentDB memory capabilities'
        : 'kata'))));
  }
  t.diagnostic(JSON.stringify({
    mcpMode: installedRuv ? 'installed' : 'fixture',
    catalogMode: installedCatalog ? installedCatalogSource.id : 'fixture@1.0.0',
    opencode: version,
    binarySha256,
    mcp: {
      claudeFlow: mcp['claude-flow'].status,
      agenticQe: mcp['agentic-qe'].status,
      ...(route === 'brain' ? { ruvnetBrain: mcp['ruvnet-brain'].status } : {}),
    },
    advertisedTools: names.length,
    toolSchemaBytes,
    providerRequestBytes,
    compactAkTools: names.filter((name) => name.startsWith('ak_')).sort(),
    directRufloOrAqeTools: names.filter((name) => /^(?:claude[-_]flow|agentic[-_]qe)_/.test(name)),
    operation: route === 'brain'
      ? 'ruvnet-brain_search_ruvnet(AgentDB memory capabilities)'
      : route === 'skill'
        ? `ak_skill_search -> stock skill(${skillName})`
        : route === 'agent'
          ? `ak_agent_search -> stock task(ak-specialist) -> ak_agent_load(${agentProfile})`
      : route === 'aqe'
        ? 'ak_aqe_search -> ak_aqe_call -> fleet_init'
        : 'ak_ruflo_search -> ak_ruflo_call -> memory_search(kata)',
  }));
  completed = true;
});
