import { cmpVersions } from '../versions.mjs';
import { componentById } from './catalogue.mjs';
import { managedIntent } from './config.mjs';
import { readPolicy } from './policy.mjs';

export const RC_KEYS = Object.freeze({
  typesafe: 'CLAUDE_FLOW_ROUTER_TYPESAFE', embedder: 'CLAUDE_FLOW_ROUTER_EMBEDDER',
  enforce: 'RUFLO_MCP_ENFORCE_POLICY', mode: 'RUFLO_INTELLIGENCE_MODE',
});

export function supports(version, minRuflo) {
  if (!minRuflo) return true;
  if (!version) return false;
  return cmpVersions(version, minRuflo) >= 0;
}

const on = (cfg, id, version) => managedIntent(cfg, id) && supports(version, componentById(id).minRuflo);

export function machineComponentEnv(cfg, rufloVersion) {
  const env = {};
  if (on(cfg, 'typesafePicker', rufloVersion)) env[RC_KEYS.typesafe] = '1';
  if (on(cfg, 'minilmPicker', rufloVersion)) env[RC_KEYS.embedder] = 'minilm';
  if (on(cfg, 'learningProfile', rufloVersion)) env[RC_KEYS.mode] = managedIntent(cfg, 'learningProfile');
  return env;
}

export function componentEnv(projectRoot, cfg, rufloVersion) {
  const env = machineComponentEnv(cfg, rufloVersion);
  if (projectRoot && on(cfg, 'mcpGovernance', rufloVersion) && readPolicy(projectRoot).state === 'valid') {
    env[RC_KEYS.enforce] = '1';
  }
  return env;
}
