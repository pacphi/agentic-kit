// Read-only local selection assessment. Never call OpenCode debug config:
// upstream Config.get installs dependencies and may fetch organization config.
// Grounding: anomalyco/opencode v1.18.31 config/{config,paths,managed}.ts and
// provider/provider.ts defaultModel; Claude model-config/settings docs; Codex
// config-basic precedence. Unknown runtime/plugin/policy overrides stay scoped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readContextConfig } from './codex-context-config.mjs';
import { withDb } from './sqlite.mjs';

const LIMIT = 1024 * 1024;
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const obs = (state, reason) => ({ state, reason });
const token = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,255}$/.test(x) ? x : null;
const initial = () => ({ configuration: obs('unknown', 'Local configuration not assessed.'),
  authentication: obs('unknown', 'Applicable credentials have not been established.'),
  model: obs('unknown', 'Model selection has not been assessed.') });

function read(file, evidence, cap = LIMIT) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > cap) throw new Error('unsupported');
      const bytes = fs.readFileSync(fd);
      if (bytes.length > cap) throw new Error('unsupported');
      const text = bytes.toString('utf8');
      if (!bytes.equals(Buffer.from(text))) throw new Error('unsupported');
      evidence.push(text);
      return text;
    } finally { fs.closeSync(fd); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Strings are copied verbatim: comment markers and commas inside URLs/secrets
// never participate in comment/trailing-comma removal.
export function parseLocalJsonc(source) {
  let out = '', index = 0;
  while (index < source.length) {
    if (source[index] === '"') {
      const start = index++;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index++] === '"') { closed = true; break; }
      }
      if (!closed) throw new SyntaxError('invalid configuration');
      out += source.slice(start, index); continue;
    }
    if (source.slice(index, index + 2) === '//') {
      while (index < source.length && source[index] !== '\n') index++;
      out += '\n'; continue;
    }
    if (source.slice(index, index + 2) === '/*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new SyntaxError('invalid configuration');
      out += ' '; index = end + 2; continue;
    }
    out += source[index++];
  }
  let clean = '';
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '"') {
      clean += out[i++];
      for (; i < out.length; i++) {
        clean += out[i];
        if (out[i] === '\\') { clean += out[++i]; continue; }
        if (out[i] === '"') break;
      }
    } else if (out[i] !== ',' || !/^\s*[}\]]/.test(out.slice(i + 1))) clean += out[i];
  }
  const value = JSON.parse(clean);
  if (!plain(value)) throw new SyntaxError('invalid configuration');
  return value;
}

function merge(a, b) {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('unsupported');
    out[key] = plain(value) && plain(out[key]) ? merge(out[key], value) : value;
  }
  return out;
}

function ancestors(cwd) {
  const dirs = [];
  for (let dir = cwd; dirs.length < 64; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) return dirs;
  }
  throw new Error('unsupported');
}

function expand(text, env) {
  if (/\{file:/.test(text)) throw new Error('unsupported');
  text = text.replace(/\{env:([^}]+)\}/g, (_all, name) => {
    if (!Object.hasOwn(env, name)) throw new Error('unsupported');
    return JSON.stringify(String(env[name])).slice(1, -1);
  });
  return text;
}

function document(file, evidence, env, jsonc = false) {
  const raw = read(file, evidence);
  if (raw === null) return {};
  const text = expand(raw, env);
  const value = jsonc ? parseLocalJsonc(text) : JSON.parse(text);
  if (!plain(value)) throw new SyntaxError('invalid configuration');
  return value;
}

function modelResult(result, model, provider) {
  if (model != null && !token(model)) throw new SyntaxError('invalid model selector');
  if (provider != null && !token(provider)) throw new Error('unsupported');
  result.model = obs('pass', model ? 'Explicit local model selection is configured; model access is not tested.'
    : 'Native default model selection; model access is checked only by a connection test.');
  result.target = { ...(provider ? { provider } : {}), ...(model ? { model } : { nativeDefault: true }) };
}

function claudeSelection(options, result, evidence) {
  const { cwd, home, env } = options;
  const root = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  let config = {};
  for (const file of [path.join(root, 'settings.json'), path.join(cwd, '.claude/settings.json'), path.join(cwd, '.claude/settings.local.json')]) {
    config = merge(config, document(file, evidence, env));
  }
  // Native doctor supplies settings validity; local model is only a projection.
  const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : process.platform === 'win32' ? path.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode/managed-settings.json')
      : '/etc/claude-code/managed-settings.json';
  const policy = document(managed, evidence, env);
  const providers = { CLAUDE_CODE_USE_BEDROCK: 'bedrock', CLAUDE_CODE_USE_VERTEX: 'vertex', CLAUDE_CODE_USE_FOUNDRY: 'foundry' };
  const effectiveEnv = { ...config.env, ...env, ...policy.env };
  const model = policy.model ?? effectiveEnv.ANTHROPIC_MODEL ?? config.model;
  const provider = Object.entries(providers).find(([key]) => effectiveEnv[key] === '1')?.[1];
  modelResult(result, model, provider);
}

function codexSelection({ cwd, home, env, codexSystemConfig }, result, evidence) {
  const root = env.CODEX_HOME || path.join(home, '.codex');
  const user = read(path.join(root, 'config.toml'), evidence) ?? '';
  const system = read(codexSystemConfig ?? (process.platform === 'win32'
    ? path.join(env.ProgramData || 'C:\\ProgramData', 'OpenAI', 'Codex', 'config.toml') : '/etc/codex/config.toml'), evidence) ?? '';
  // Project trust decides whether project files load. Do not assert a winning
  // model from an arbitrary merge when a project override exists.
  for (const dir of ancestors(cwd)) {
    const project = read(path.join(dir, '.codex/config.toml'), evidence);
    if (project !== null) {
      const projected = readContextConfig(project);
      if (projected.model || projected.provider || /^\s*(?:profile|config_profile)\s*=/m.test(project)) throw new Error('unsupported');
    }
  }
  if ([user, system].some(text => /^\s*(?:profile|config_profile)\s*=/m.test(text))) throw new Error('unsupported');
  const inherited = readContextConfig(system), selected = readContextConfig(user);
  const config = { model: selected.model ?? inherited.model, provider: selected.provider ?? inherited.provider };
  modelResult(result, config.model, config.provider);
  if (['ollama', 'lmstudio'].includes(config.provider)) {
    result.authentication = obs('pass', 'Native local provider has no configured login requirement; server authentication is not tested.');
  }
}

const PROVIDER_ENV = { anthropic: ['ANTHROPIC_API_KEY'], openai: ['OPENAI_API_KEY'], google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'], groq: ['GROQ_API_KEY'], mistral: ['MISTRAL_API_KEY'], xai: ['XAI_API_KEY'] };
function credentialPresent(value) {
  if (value?.type === 'api') return typeof value.key === 'string' && value.key.length > 0;
  if (value?.type === 'oauth') return (typeof value.refresh === 'string' && value.refresh.length > 0)
    || (typeof value.access === 'string' && value.access.length > 0 && Number(value.expires) > Date.now());
  return false;
}
function localProvider(provider) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(provider?.options?.baseURL).hostname); }
  catch { return false; }
}
function openCodeRemote(data, evidence) {
  const dbfile = path.join(data, 'opencode.db');
  if (!fs.existsSync(dbfile)) return false;
  const check = withDb(dbfile, db => {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_state'").get();
    if (!exists) return false;
    return !!db.prepare('SELECT active_org_id FROM account_state WHERE id = 1').get()?.active_org_id;
  });
  if (!check.ok) throw new Error('unsupported');
  evidence.push(JSON.stringify({ activeOrganization: check.value }));
  return check.value;
}
function selectedOpenCodeAgent(config, agentDirs) {
  const selectedAgent = config.default_agent || 'build';
  if (typeof selectedAgent !== 'string' || !/^[A-Za-z0-9_-]+$/.test(selectedAgent)) throw new Error('unsupported');
  if (agentDirs.some(dir => ['agent', 'agents'].some(folder => fs.existsSync(path.join(dir, folder, selectedAgent + '.md'))))) throw new Error('unsupported');
  const agent = config.agent?.[selectedAgent];
  if (agent !== undefined && !plain(agent)) throw new SyntaxError('invalid agent');
  if (agent?.mode === 'subagent' || agent?.disable === true) throw new SyntaxError('invalid default agent');
  if (!['build', 'plan'].includes(selectedAgent) && agent === undefined) throw new Error('unsupported');
  if (config.agent?.[selectedAgent]?.model !== undefined) config = { ...config, model: config.agent[selectedAgent].model };
  return config;
}

function loadOpenCode({ cwd, home, env }, evidence) {
  const global = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  const data = path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'opencode');
  const auth = document(path.join(data, 'auth.json'), evidence, env);
  if (Object.values(auth).some(value => value?.type === 'wellknown') || openCodeRemote(data, evidence)) throw new Error('unsupported');
  if (fs.existsSync(path.join(global, 'config'))) throw new Error('unsupported'); // legacy TOML migration is native-owned
  let config = {};
  const load = file => { config = merge(config, document(file, evidence, env, true)); };
  for (const name of ['config.json', 'opencode.json', 'opencode.jsonc']) load(path.join(global, name));
  if (env.OPENCODE_CONFIG) load(path.resolve(cwd, env.OPENCODE_CONFIG));
  const dirs = env.OPENCODE_DISABLE_PROJECT_CONFIG === 'true' || env.OPENCODE_DISABLE_PROJECT_CONFIG === '1' ? [] : ancestors(cwd);
  for (const dir of [...dirs].reverse()) for (const name of ['opencode.json', 'opencode.jsonc']) load(path.join(dir, name));
  for (const dir of [...new Set([...dirs.map(dir => path.join(dir, '.opencode')), path.join(home, '.opencode'), env.OPENCODE_CONFIG_DIR].filter(Boolean))]) {
    for (const name of ['opencode.json', 'opencode.jsonc']) load(path.join(dir, name));
  }
  if (env.OPENCODE_CONFIG_CONTENT) config = merge(config, parseLocalJsonc(expand(env.OPENCODE_CONFIG_CONTENT, env)));
  const managed = env.OPENCODE_TEST_MANAGED_CONFIG_DIR || (process.platform === 'darwin' ? '/Library/Application Support/opencode'
    : process.platform === 'win32' ? path.join(env.ProgramData || 'C:\\ProgramData', 'opencode') : '/etc/opencode');
  for (const name of ['opencode.json', 'opencode.jsonc']) load(path.join(managed, name));
  if (process.platform === 'darwin' && [path.join('/Library/Managed Preferences', os.userInfo().username, 'ai.opencode.managed.plist'),
    '/Library/Managed Preferences/ai.opencode.managed.plist'].some(file => fs.existsSync(file))) throw new Error('unsupported');
  config = selectedOpenCodeAgent(config, [global, ...dirs.map(dir => path.join(dir, '.opencode')), path.join(home, '.opencode'), env.OPENCODE_CONFIG_DIR].filter(Boolean));
  return { config, auth };
}

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.every(nonempty);
function knownField(value, key, predicate) {
  if (value[key] !== undefined && !predicate(value[key])) throw new SyntaxError('invalid operational field');
}
function validUrl(value) {
  try { return nonempty(value) && ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}
function validateMcp(entry) {
  if (!plain(entry)) throw new SyntaxError('invalid MCP entry');
  knownField(entry, 'enabled', value => typeof value === 'boolean');
  if (entry.type === undefined && entry.enabled === false) return;
  if (entry.type === 'local') {
    if (!strings(entry.command) || entry.command.length === 0) throw new SyntaxError('invalid MCP command');
    knownField(entry, 'environment', value => plain(value) && Object.values(value).every(v => typeof v === 'string'));
  } else if (entry.type === 'remote') {
    if (!validUrl(entry.url)) throw new SyntaxError('invalid MCP URL');
    knownField(entry, 'headers', value => plain(value) && Object.values(value).every(v => typeof v === 'string'));
  } else if (entry.type === undefined || typeof entry.type !== 'string') throw new SyntaxError('invalid MCP type');
  else throw new Error('unsupported MCP transport');
}
function validateProvider(entry) {
  if (!plain(entry)) throw new SyntaxError('invalid provider');
  knownField(entry, 'options', plain);
  knownField(entry, 'env', strings);
  knownField(entry, 'models', plain);
  knownField(entry, 'npm', nonempty);
  if (entry.options) {
    knownField(entry.options, 'apiKey', nonempty);
    knownField(entry.options, 'baseURL', validUrl);
  }
  for (const model of Object.values(entry.models ?? {})) if (!plain(model)) throw new SyntaxError('invalid model definition');
}
function validateAgent(entry) {
  if (!plain(entry)) throw new SyntaxError('invalid agent');
  knownField(entry, 'model', nonempty);
  knownField(entry, 'mode', value => ['primary', 'subagent', 'all'].includes(value));
  knownField(entry, 'disable', value => typeof value === 'boolean');
}

function validateOpenCode(config) {
  for (const entry of Object.values(config.mcp ?? {})) validateMcp(entry);
  for (const entry of Object.values(config.provider ?? {})) validateProvider(entry);
  for (const entry of Object.values(config.agent ?? {})) validateAgent(entry);
  for (const key of ['provider', 'mcp', 'agent']) if (config[key] !== undefined && !plain(config[key])) throw new SyntaxError('invalid configuration');
  for (const key of ['enabled_providers', 'disabled_providers']) if (config[key] !== undefined
    && (!Array.isArray(config[key]) || config[key].some(value => typeof value !== 'string'))) throw new SyntaxError('invalid configuration');
}

function explicitOpenCode(config) {
  let provider, model;
  if (config.model !== undefined) {
    if (typeof config.model !== 'string' || !config.model.includes('/')) throw new SyntaxError('invalid model selector');
    [provider, ...model] = config.model.split('/'); model = model.join('/');
    if (!provider || !model) throw new SyntaxError('invalid model selector');

  }
  return { provider, model };
}

function defaultOpenCode({ config, auth, home, env, allowed, credentialed }, evidence) {
  let provider;
  // Native default tries recent available selections, then a configured
  // provider. Do not borrow credentials from an unrelated provider.

    const recent = document(path.join(env.XDG_STATE_HOME || path.join(home, '.local/state'), 'opencode/model.json'), evidence, env).recent;
    if (Array.isArray(recent) && recent.length) throw new Error('unsupported'); // availability requires native provider catalog
    const configured = Object.keys(config.provider ?? {}).filter(allowed);
    if (configured.length === 1) provider = configured[0];
    else if (configured.length > 1) throw new Error('unsupported');
    else {
      const candidates = [...new Set([...Object.keys(auth), ...Object.keys(PROVIDER_ENV)])].filter(id => allowed(id) && credentialed(id));
      if (candidates.length === 1) provider = candidates[0];
      else if (candidates.length > 1) throw new Error('unsupported');
    }
  return provider;
}

function opencodeSelection(options, result, evidence) {
  const { home, env } = options;
  const { config, auth } = loadOpenCode(options, evidence);
  validateOpenCode(config);
  const allowed = id => !config.disabled_providers?.includes(id) && (!config.enabled_providers || config.enabled_providers.includes(id));
  const selected = explicitOpenCode(config);
  let provider = selected.provider;
  const model = selected.model;
  if (provider && !allowed(provider)) { result.model = obs('fail', 'Selected model provider is disabled by local configuration.'); return; }
  const credentialed = id => credentialPresent(auth[id]) || nonempty(config.provider?.[id]?.options?.apiKey)
    || [...(PROVIDER_ENV[id] ?? []), ...(config.provider?.[id]?.env ?? [])].some(key => !!env[key]);
  if (!provider) provider = defaultOpenCode({ config, auth, home, env, allowed, credentialed }, evidence);
  result.configuration = obs('pass', 'Local configuration layers and selection fields are readable; runtime plugins and provider connections are not executed.');
  modelResult(result, model, model ? provider : undefined);
  if (provider && credentialed(provider)) result.authentication = obs('pass', 'Applicable provider credentials are locally configured; validity is not tested.');
  else if (provider && localProvider(config.provider?.[provider])) result.authentication = obs('pass', 'Local endpoint has no configured credential requirement; server authentication is not tested.');
}

/** Read local selection without executing config code or contacting providers.
 * @param {{host:string,cwd:string,home?:string,env?:NodeJS.ProcessEnv,codexSystemConfig?:string}} options */
export function assessLocalSelection({ host, cwd, home = os.homedir(), env = process.env, codexSystemConfig }) {
  const result = initial(), evidence = [];
  try {
    const options = { cwd, home, env, codexSystemConfig };
    if (host === 'opencode') opencodeSelection(options, result, evidence);
    else if (host === 'claude') claudeSelection(options, result, evidence);
    else if (host === 'codex') codexSelection(options, result, evidence);
    result.evidenceKey = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  } catch (error) {
    return { ...initial(), configuration: obs(error instanceof SyntaxError ? 'fail' : 'unknown',
      error instanceof SyntaxError ? 'Local configuration contains invalid syntax or selection fields.' : 'Additional configuration or provider selection requires native assessment.') };
  }
  return result;
}
