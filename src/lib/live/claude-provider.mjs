import os from 'node:os';
import path from 'node:path';
import { readJson } from '../settings.mjs';

// Which endpoint serves a Claude Code session. Claude transcripts never record
// this, so the resolver mirrors the host's documented selection surface
// (code.claude.com/docs/en/env-vars + the Bedrock/Vertex/Foundry guides):
// CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY switch the serving platform and
// ANTHROPIC_BASE_URL points the first-party path at a proxy or gateway.
// Settings `env` blocks override the shell — managed > project local >
// project shared > user — and an empty string means "unset at this layer".
// The result is a claim about configuration, so provenance is 'configured'
// (explicit selection found) or 'inferred' (first-party default), never
// 'observed'.

/** @type {Record<string, string>} */
const MANAGED_SETTINGS = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
};

const plainEnv = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? value : null;

// "1" is the documented spelling; tolerate other truthy strings but never
// treat an explicit "0"/"false" as a selection.
const flag = (value) => typeof value === 'string' && value !== ''
  && !['0', 'false'].includes(value.toLowerCase());

function gatewayProvider(baseUrl) {
  let host = null;
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { /* unparseable → generic */ }
  if (host === 'api.anthropic.com' || host?.endsWith('.anthropic.com')) return 'anthropic';
  if (host?.includes('openrouter')) return 'openrouter';
  return 'gateway';
}

/**
 * Resolve the inference provider configured for Claude Code sessions rooted at
 * `cwd`. Returns { provider, provenance } — provenance 'configured' when an
 * explicit selection was found, 'inferred' for the first-party default.
 *
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, home?: string,
 *   platform?: string, read?: (file: string) => any }} [opts] test seams
 */
export function resolveClaudeProvider({
  cwd,
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  read = readJson,
} = {}) {
  const layers = [];
  const managed = MANAGED_SETTINGS[platform];
  if (managed) layers.push(plainEnv(read(managed)?.env));
  if (typeof cwd === 'string' && cwd) {
    layers.push(plainEnv(read(path.join(cwd, '.claude', 'settings.local.json'))?.env));
    layers.push(plainEnv(read(path.join(cwd, '.claude', 'settings.json'))?.env));
  }
  layers.push(plainEnv(read(path.join(home, '.claude', 'settings.json'))?.env));
  const lookup = (name) => {
    for (const layer of layers) {
      if (layer && Object.hasOwn(layer, name)) {
        const value = layer[name];
        return typeof value === 'string' && value !== '' ? value : null;
      }
    }
    const value = env[name];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  if (flag(lookup('CLAUDE_CODE_USE_BEDROCK'))) return { provider: 'bedrock', provenance: 'configured' };
  if (flag(lookup('CLAUDE_CODE_USE_VERTEX'))) return { provider: 'vertex', provenance: 'configured' };
  if (flag(lookup('CLAUDE_CODE_USE_FOUNDRY'))) return { provider: 'foundry', provenance: 'configured' };
  const base = lookup('ANTHROPIC_BASE_URL');
  if (base) return { provider: gatewayProvider(base), provenance: 'configured' };
  return { provider: 'anthropic', provenance: 'inferred' };
}
