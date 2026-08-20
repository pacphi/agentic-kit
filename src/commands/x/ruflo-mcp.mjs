// Internal stdio launcher used by Codex's user-scoped MCP registration. The
// registration is global, but every process launch is pinned to the workspace
// Codex started it from, so projects never share a database accidentally.
import { spawn } from 'node:child_process';
import { rufloMcpLaunch } from '../../lib/ruflo-memory.mjs';

export const options = {};
export const help = `ak x ruflo-mcp — internal workspace-aware Ruflo MCP launcher

Used by agentic-kit's Codex registration. It pins CLAUDE_FLOW_DB_PATH to the
current repository before starting Ruflo's stdio MCP server.

Examples:
  ak x ruflo-mcp    start the stdio server (normally invoked by Codex)`;

export async function run() {
  const spec = rufloMcpLaunch();
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
