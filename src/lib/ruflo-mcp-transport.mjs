// Recognition for topology diagnostics only. This does not grant permission
// to remove upstream npx registrations or extend remembered repair consent.
export function isRufloMcpTransport({ command, args }) {
  if (!Array.isArray(args)) return false;
  const same = expected => JSON.stringify(args) === JSON.stringify(expected);
  if (command === 'ak') return same(['x', 'ruflo-mcp']);
  if (command === 'ruflo' || command === 'claude-flow') return same(['mcp', 'start']);
  if (command !== 'npx') return false;
  const invocation = args[0] === '-y' || args[0] === '--yes' ? args.slice(1) : args;
  return invocation.length === 3 && invocation[1] === 'mcp' && invocation[2] === 'start'
    && /^(?:ruflo|claude-flow|@claude-flow\/cli)(?:@[a-zA-Z0-9._-]+)?$/.test(invocation[0]);
}
