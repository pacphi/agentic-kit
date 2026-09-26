// Internal stdio launcher used by Codex's user-scoped MCP registration. The
// registration is global, but every process launch is pinned to the workspace
// Codex started it from, so projects never share a database accidentally.
// Outside a usable folder (the filesystem root, the home folder, a temporary
// root, a tool's own folder) it uses the one user-level store instead
// (ruflo-memory.mjs rufloMemoryLocation), creating that folder on first use.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { rufloMcpLaunch } from '../../lib/ruflo-memory.mjs';

export const options = {};
export const help = `ak x ruflo-mcp — internal workspace-aware Ruflo MCP launcher

Used by agentic-kit's Codex registration. It starts Ruflo's stdio MCP server in
the current Git repository (else the current folder) and pins
CLAUDE_FLOW_DB_PATH to that folder's .swarm/memory.db. Started from the
filesystem root, the home folder, a temporary root or a tool's own folder
(~/.codex, ~/.claude, ~/.config, …), it uses the user-level store
~/.claude-flow/memory instead and pins CLAUDE_FLOW_MEMORY_PATH as well.
\`ak status\` shows which store applies from a folder.

Examples:
  ak x ruflo-mcp    start the stdio server (normally invoked by Codex)`;

export async function run() {
  const spec = rufloMcpLaunch();
  if (spec.location.kind === 'user') {
    try { fs.mkdirSync(spec.cwd, { recursive: true }); } catch { /* spawn reports a missing cwd */ }
  }
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: 'inherit',
    });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
