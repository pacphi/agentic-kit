// ak's workspace-aware launcher in its two registered forms: Codex's
// (`ak x ruflo-mcp`) and Claude Code's (`ak x ruflo-mcp --host claude`).
export const LAUNCHER_ARGS = Object.freeze({
  codex: Object.freeze(['x', 'ruflo-mcp']),
  claude: Object.freeze(['x', 'ruflo-mcp', '--host', 'claude']),
});

/** Is `{command, args}` exactly ak's launcher for `host` (either host when omitted)? */
export function isAkLauncher({ command, args }, host = null) {
  if (command !== 'ak' || !Array.isArray(args)) return false;
  const forms = host ? [LAUNCHER_ARGS[host]] : Object.values(LAUNCHER_ARGS);
  return forms.some((form) => JSON.stringify(args) === JSON.stringify(form));
}

// Recognition for topology diagnostics only. This does not grant permission
// to remove upstream npx registrations or extend remembered repair consent.
export function isRufloMcpTransport({ command, args }) {
  if (!Array.isArray(args)) return false;
  const same = expected => JSON.stringify(args) === JSON.stringify(expected);
  if (command === 'ak') return isAkLauncher({ command, args });
  if (command === 'ruflo' || command === 'claude-flow') return same(['mcp', 'start']);
  if (command !== 'npx') return false;
  const invocation = args[0] === '-y' || args[0] === '--yes' ? args.slice(1) : args;
  return invocation.length === 3 && invocation[1] === 'mcp' && invocation[2] === 'start'
    && /^(?:ruflo|claude-flow|@claude-flow\/cli)(?:@[a-zA-Z0-9._-]+)?$/.test(invocation[0]);
}
