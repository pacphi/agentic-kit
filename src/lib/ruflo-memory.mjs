// One project-memory launch contract for every host. Ruflo accepts the
// compatibility path through CLAUDE_FLOW_DB_PATH; its native AgentDB bridge
// may derive and write the sibling agentdb-memory.db from that same project.
import fs from 'node:fs';
import * as paths from './paths.mjs';
import { loadKitConfig } from './config.mjs';
import { managedAgentBrowserEnv } from './agent-browser.mjs';
import { installedVersion } from './versions.mjs';
import { componentEnv, RC_KEYS, supports } from './ruflo-components/env.mjs';
import { managedIntent } from './ruflo-components/config.mjs';
import { componentById } from './ruflo-components/catalogue.mjs';

export function memoryProjectRoot(cwd = process.cwd()) {
  return fs.realpathSync(paths.repoRoot(cwd) ?? cwd);
}

export function projectMemoryEnv(cwd = process.cwd(), env = {}) {
  const root = memoryProjectRoot(cwd);
  return { ...env, CLAUDE_FLOW_DB_PATH: paths.projectMemoryDb(root) };
}

export function rufloMcpLaunch(cwd = process.cwd(), env = process.env, {
  cfg = loadKitConfig(), rufloVersion = installedVersion('ruflo'),
} = {}) {
  const root = memoryProjectRoot(cwd);
  const rc = componentEnv(root, cfg, rufloVersion);
  const merged = {
    ...env,
    ...managedAgentBrowserEnv({ enabled: cfg.agentBrowser !== false }),
    ...rc,
  };
  // Governance is a project-scoped ak-owned key: when managed, ak either sets
  // it (valid policy) or actively clears a stale/inherited value (no/invalid
  // policy) — never leaves ruflo pointed at a policy file it can no longer
  // see, which would make it fail closed on every tool call (when ruflo's
  // enforcer is reachable; ruflo 3.44.0's stdio entry points do not reach it,
  // see ADR-0058 upstream request 6). When governance
  // is not managed, an inherited value is the user's own choice and is left
  // untouched.
  if (managedIntent(cfg, 'mcpGovernance') && supports(rufloVersion, componentById('mcpGovernance').minRuflo) && !(RC_KEYS.enforce in rc)) {
    delete merged[RC_KEYS.enforce];
  }
  return {
    command: 'ruflo',
    args: ['mcp', 'start'],
    cwd: root,
    env: projectMemoryEnv(root, merged),
  };
}
