// One project-memory launch contract for every host. Ruflo accepts the
// compatibility path through CLAUDE_FLOW_DB_PATH; its native AgentDB bridge
// may derive and write the sibling agentdb-memory.db from that same project.
import fs from 'node:fs';
import * as paths from './paths.mjs';

export function memoryProjectRoot(cwd = process.cwd()) {
  return fs.realpathSync(paths.repoRoot(cwd) ?? cwd);
}

export function projectMemoryEnv(cwd = process.cwd(), env = {}) {
  const root = memoryProjectRoot(cwd);
  return { ...env, CLAUDE_FLOW_DB_PATH: paths.projectMemoryDb(root) };
}

export function rufloMcpLaunch(cwd = process.cwd(), env = process.env) {
  const root = memoryProjectRoot(cwd);
  return {
    command: 'ruflo',
    args: ['mcp', 'start'],
    cwd: root,
    env: projectMemoryEnv(root, env),
  };
}
