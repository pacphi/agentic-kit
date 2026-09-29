import path from 'node:path';

// Which AQE MCP registrations ak may edit, one rule for Claude, Codex and OpenCode
// (Decision 3 of docs/plans/2026-09-26-issues-237-238-239-verification-and-decisions.md,
// widening the #230 allow-list). Accepted: AQE's own programs started exactly as AQE
// starts its MCP server. `aqe`, `agentic-qe` and `aqe-v3` are one CLI whose `mcp`
// command starts the same server as `aqe-mcp` (agentic-qe package.json `bin`,
// dist/cli/commands/mcp.js). Every plain npx spelling of the package counts too: an
// optional single `-y`/`--yes`, then `agentic-qe` unversioned, `@latest` or an exact
// version (`@3.14.4`, `@3.15.0-rc.1`), then `mcp` and nothing else. Ranges, other
// dist-tags, scoped look-alikes, `--package` forms, extra flags, subcommands and
// wrappers stay user-owned.
const MCP_PROGRAM = 'aqe-mcp';
const CLI_PROGRAMS = new Set(['aqe', 'agentic-qe', 'aqe-v3']);
const NPX_PACKAGE = /^agentic-qe(?:@(?:latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))?$/;
const NPX_YES = new Set(['-y', '--yes']);

// npm installs `.cmd` shims on Windows; Windows file names are case-insensitive.
function programName(command, platform) {
  const windows = platform === 'win32';
  const base = (windows ? path.win32 : path.posix).basename(command);
  const name = windows ? base.toLowerCase() : base;
  return name.endsWith('.cmd') ? name.slice(0, -'.cmd'.length) : name;
}

const exactly = (args, expected) => args.length === expected.length && args.every((arg, i) => arg === expected[i]);

/** @param {unknown} command @param {unknown} [args] @param {{platform?: string}} [options] */
export function recognizedAqeTransport(command, args = [], { platform = process.platform } = {}) {
  if (typeof command !== 'string' || !Array.isArray(args)) return false;
  const program = programName(command, platform);
  if (program === MCP_PROGRAM) return args.length === 0;
  if (CLI_PROGRAMS.has(program)) return exactly(args, ['mcp']);
  return program === 'npx' && npxStartsAqe(args);
}

function npxStartsAqe(args) {
  const rest = NPX_YES.has(args[0]) ? args.slice(1) : args;
  return rest.length === 2 && NPX_PACKAGE.test(rest[0]) && rest[1] === 'mcp';
}

/** OpenCode stores the program and its arguments as one array.
 * @param {unknown} commandLine @param {{platform?: string}} [options] */
export function recognizedAqeCommandLine(commandLine, options) {
  return Array.isArray(commandLine) && commandLine.length > 0
    && recognizedAqeTransport(commandLine[0], commandLine.slice(1), options);
}

export function parseEmbeddingJson(source) {
  try { return JSON.parse(source); }
  catch { throw new Error('invalid JSON configuration preserved'); }
}
