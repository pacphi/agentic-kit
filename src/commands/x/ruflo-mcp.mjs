// Internal stdio launcher used by the user-scoped Ruflo MCP registrations of
// Codex (`ak x ruflo-mcp`) and Claude Code (`ak x ruflo-mcp --host claude`).
// The registration is global, but every process launch is pinned to the
// workspace the host started it from, so projects never share a database
// accidentally. Outside a usable folder (the filesystem root, the home folder,
// a temporary root, a tool's own folder) it uses the one user-level store
// instead (ruflo-memory.mjs rufloMemoryLocation), creating that folder on
// first use. Claude mode sets only the memory location and ak's agent-browser
// config: Claude Code passes its settings env, component keys included, to
// the server itself (ADR-0058 §3).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { resolveShim } from '../../lib/exec.mjs';
import { isWindows } from '../../lib/paths.mjs';
import { LAUNCHER_HOSTS, rufloMcpLaunch } from '../../lib/ruflo-memory.mjs';
import { fail } from '../../lib/output.mjs';

export const options = { host: { type: 'string' } };
export const help = `ak x ruflo-mcp — internal workspace-aware Ruflo MCP launcher

Used by agentic-kit's Ruflo MCP registrations for Codex and Claude Code. It
starts Ruflo's stdio MCP server in the current Git repository (else the
current folder) and pins CLAUDE_FLOW_DB_PATH to that folder's .swarm/memory.db,
so Ruflo also reads that folder's .harness/mcp-policy.json. Started from the
filesystem root, the home folder, a temporary root or a tool's own folder
(~/.codex, ~/.claude, ~/.config, …), it uses the user-level store
~/.claude-flow/memory instead and pins CLAUDE_FLOW_MEMORY_PATH as well.
\`ak status\` shows which store applies from a folder.

Options:
  --host <claude|codex>   the host that starts it (default codex). Claude mode
                          sets only the memory location and the agent-browser
                          config; Claude Code's settings env supplies the rest.

Examples:
  ak x ruflo-mcp                 start the stdio server (normally invoked by Codex)
  ak x ruflo-mcp --host claude   the same, as Claude Code's registration starts it`;

/** How to start `spec.command`: on Windows `ruflo` is an npm .cmd shim that
 *  CreateProcess cannot start, so it resolves through the launch env's PATH
 *  exactly as run()/have() do (exec.mjs resolveShim), argv kept separate.
 *  @param {{ command: string, args: string[], env: NodeJS.ProcessEnv }} spec
 *  @param {{ windows?: boolean }} [options] */
export function launchInvocation(spec, { windows = isWindows } = {}) {
  return resolveShim(spec.command, spec.args, { windows, env: spec.env });
}

/** @param {{ flags?: { host?: string } }} [options] */
export async function run({ flags = {} } = {}) {
  const host = flags.host ?? 'codex';
  if (!LAUNCHER_HOSTS.includes(host)) {
    fail(`ak x ruflo-mcp: --host must be claude or codex (got ${JSON.stringify(host)})`);
    return 2;
  }
  const spec = rufloMcpLaunch(process.cwd(), process.env, { host });
  if (spec.location.kind === 'user') {
    try { fs.mkdirSync(spec.cwd, { recursive: true }); } catch { /* spawn reports a missing cwd */ }
  }
  const invocation = launchInvocation(spec);
  if (!invocation.resolved) {
    fail(`ak x ruflo-mcp: \`${spec.command}\` is not on PATH, or its .cmd shim lacks its .ps1 sibling or Windows PowerShell`);
    return 1;
  }
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: 'inherit',
    });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
