// Release proof for Agentic-QE ADR-127 / issue #628. Unlike the unit seams,
// this opt-in live test invokes the installed Agentic-QE CLI and MCP server
// through the exact project-local declaration agentic-kit writes.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrapHostAdapters } from '../../src/lib/adapters/admission.mjs';
import { resetAdmitted } from '../../src/lib/adapters/admitted.mjs';
import {
  resetAdmittedAqeProviders,
} from '../../src/lib/adapters/aqe-provider.mjs';
import { recordConsent } from '../../src/lib/adapters/consent.mjs';
import {
  adapterGrantsPath, grantCapability, recordTierResult,
} from '../../src/lib/adapters/grants.mjs';
import { hashAdapterContent } from '../../src/lib/adapters/integrity.mjs';
import { validateAdapterManifest } from '../../src/lib/adapters/manifest.mjs';
import { loadKitConfig, saveKitConfig } from '../../src/lib/config.mjs';
import { applyAqeRouter, aqeRouterFile } from '../../src/lib/providers.mjs';

const PROVIDER_ID = 'aqe-live-proof';
const MODEL_ID = 'proof-model';
const COMPLETION = 'LIVE_AQE_628_OK';
const AQE_BIN = process.env.AQE_BIN ?? 'aqe';
const REQUIRED_AQE = [3, 13, 12];

function versionTuple(text) {
  const match = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual, required) {
  return actual.some((part, index) => part !== required[index]
    && part > required[index] && actual.slice(0, index).every((value, prior) => value === required[prior]))
    || actual.every((part, index) => part === required[index]);
}

function manifest() {
  return {
    name: PROVIDER_ID,
    version: '1.0.0',
    contract: 1,
    host: {
      id: PROVIDER_ID,
      label: 'AQE live proof provider',
      install: { bin: 'node', externalInstallPolicy: 'detect-never-overwrite' },
      capabilities: {
        canDriveSession: false,
        canBePrimary: false,
        canRouteActivities: true,
        commandStatusline: false,
        transcripts: false,
        usage: false,
        nativeMcpConfig: false,
        nativeGuidance: false,
      },
      trust: { approvalPolicy: 'unchanged', changes: [] },
      enabledByDefault: false,
      configProjection: 'ruflo',
      observability: [],
    },
    detection: { bin: 'node' },
    driving: { surfaces: ['cli-subprocess'] },
    execution: {
      run: {
        hook: {
          command: [process.execPath, 'execution-hook.mjs'],
          files: ['execution-hook.mjs'],
          timeoutMs: 5_000,
        },
      },
    },
    aqe: {
      provider: {
        hook: {
          command: [process.execPath, 'aqe-hook.mjs'],
          files: ['aqe-hook.mjs'],
          timeoutMs: 10_000,
        },
        billingMode: 'subscription',
        models: [MODEL_ID],
        defaultModel: MODEL_ID,
        maxConcurrency: 1,
        stripEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
        displayName: 'Agentic-kit #628 live proof',
      },
    },
    trust: { changes: [] },
  };
}

function writeFixture(adapterDir) {
  fs.mkdirSync(adapterDir, { recursive: true });
  fs.writeFileSync(path.join(adapterDir, 'execution-hook.mjs'), `
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write('OK'));
`);
  fs.writeFileSync(path.join(adapterDir, 'aqe-hook.mjs'), `
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
const proof = [
  '${COMPLETION}',
  'provider=' + process.env.AK_AQE_PROVIDER,
  'model=' + process.env.AK_AQE_MODEL,
  'cwd=' + process.env.AK_AQE_PROJECT_CWD,
  'prompt-bytes=' + Buffer.byteLength(prompt),
].join('|');
process.stdout.write([
  "import { describe, it } from 'node:test';",
  "import assert from 'node:assert/strict';",
  '',
  '// ' + proof,
  "describe('add', () => {",
  "  it('adds two numbers', () => assert.equal(1 + 2, 3));",
  '});',
].join('\\n'));
`);
  const validated = validateAdapterManifest(manifest());
  fs.writeFileSync(path.join(adapterDir, 'manifest.json'), `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

function runAqe(args, { cwd, env, input } = {}) {
  return spawnSync(AQE_BIN, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    assert.fail(`${label} did not return JSON: ${error.message}\nstdout: ${text}`);
  }
}

async function mcpGenerate({ cwd, env }) {
  const child = spawn(AQE_BIN, ['mcp'], {
    cwd,
    env: { ...env, AQE_MEMORY_BACKEND: 'memory' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdoutBuffer = '';
  let stderrTail = '';
  const pending = new Map();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-16_384);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });

  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`AQE MCP ${method} timed out\nstderr: ${stderrTail}`));
    }, 90_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    const initialized = await request(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'agentic-kit-live-proof', version: '1.0.0' },
    });
    assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    const generation = await request(2, 'tools/call', {
      name: 'test_generate_enhanced',
      arguments: {
        sourceCode: 'export function add(a, b) { return a + b; }',
        language: 'javascript',
        testType: 'unit',
        framework: 'node-test',
        aiEnhancement: true,
      },
    });
    assert.equal(generation.error, undefined, JSON.stringify(generation.error));
    return { result: generation.result, stderr: stderrTail };
  } finally {
    child.stdin.end();
    let exitTimer;
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise((resolve) => {
        exitTimer = setTimeout(() => resolve(null), 7_000);
        exitTimer.unref();
      }),
    ]);
    clearTimeout(exitTimer);
    if (!exited) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    assert.ok(exited, `AQE MCP did not terminate after stdin EOF\nstderr: ${stderrTail}`);
  }
}

test('Agentic-QE 3.13.12+ serves an admitted provider through CLI and MCP', {
  timeout: 240_000,
}, async (t) => {
  const version = runAqe(['--version']);
  assert.equal(version.status, 0, `AQE is required for this live proof: ${version.stderr}`);
  const actualVersion = versionTuple(version.stdout);
  assert.ok(actualVersion, `unrecognized AQE version: ${version.stdout}`);
  assert.ok(versionAtLeast(actualVersion, REQUIRED_AQE),
    `AQE >=${REQUIRED_AQE.join('.')} required; found ${actualVersion.join('.')}`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-628-live-'));
  const projectRoot = path.join(temp, 'project');
  const adapterDir = path.join(projectRoot, 'adapter');
  const xdg = path.join(temp, 'xdg');
  const home = path.join(temp, 'home');
  const priorXdg = process.env.XDG_CONFIG_HOME;
  fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const validated = writeFixture(adapterDir);
  const manifestFile = path.join(adapterDir, 'manifest.json');
  const integrity = hashAdapterContent(validated, { baseDir: adapterDir });
  const configFile = path.join(xdg, 'agentic-kit', 'kit.json');
  const consentFile = path.join(xdg, 'agentic-kit', 'adapter-consent.json');
  const grantsFile = path.join(xdg, 'agentic-kit', 'adapter-grants.json');
  t.after(() => {
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
    resetAdmittedAqeProviders();
    resetAdmitted();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const cfg = loadKitConfig(path.join(temp, 'missing-kit.json'));
  cfg.hostAdapters = [{ name: PROVIDER_ID, source: manifestFile, contract: 1 }];
  cfg.integrations.hosts[PROVIDER_ID] = true;
  cfg.providers.aqeProvider = PROVIDER_ID;
  cfg.providers.aqeFallback = [{ provider: PROVIDER_ID, models: [MODEL_ID] }];
  saveKitConfig(cfg, configFile);
  recordConsent(PROVIDER_ID, integrity.hash, { file: consentFile });
  recordTierResult(PROVIDER_ID, 'aqe-provider', {
    hash: integrity.hash,
    evidence: 'release proof exercises installed Agentic-QE CLI and MCP transports',
  }, { file: grantsFile });
  grantCapability(PROVIDER_ID, 'aqeProvider', { hash: integrity.hash }, { file: grantsFile });

  process.env.XDG_CONFIG_HOME = xdg;
  const bootstrap = await bootstrapHostAdapters({
    cfg,
    env: { ...process.env, AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
  });
  assert.equal(bootstrap.warnings.length, 0, JSON.stringify(bootstrap.warnings));
  assert.equal(bootstrap.admitted.length, 1);
  const projection = applyAqeRouter(cfg, projectRoot);
  assert.equal(projection.ok, true, projection.detail);
  assert.equal(projection.changed, true, projection.detail);
  assert.ok(fs.existsSync(aqeRouterFile(projectRoot)));
  const projectedConfig = JSON.parse(fs.readFileSync(aqeRouterFile(projectRoot), 'utf8'));
  assert.deepEqual(projectedConfig.providers[PROVIDER_ID], { enabled: true });

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    AK_EXPERIMENTAL_HOST_ADAPTERS: '1',
    AQE_CONFIG_ROOT: projectRoot,
    AQE_PROJECT_ROOT: projectRoot,
    AQE_LLM_PROVIDER: PROVIDER_ID,
  };
  const providers = runAqe(['llm', 'providers', '--json'], { cwd: projectRoot, env });
  assert.equal(providers.status, 0, providers.stderr);
  const providerList = parseJson('aqe llm providers', providers.stdout);
  assert.match(JSON.stringify(providerList), new RegExp(PROVIDER_ID));

  const mcp = await mcpGenerate({ cwd: projectRoot, env });
  const mcpText = JSON.stringify(mcp.result);
  assert.match(mcpText, new RegExp(COMPLETION), mcp.stderr);
  assert.match(mcpText, new RegExp(`provider=${PROVIDER_ID}`));
  assert.match(mcpText, new RegExp(`model=${MODEL_ID}`));
  assert.equal(adapterGrantsPath().startsWith(xdg), true);
});
