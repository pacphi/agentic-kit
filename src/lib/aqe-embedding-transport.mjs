import path from 'node:path';

/** Exact supported registrations from AQE's platform-config-generator and aqe-mcp bin. */
export function recognizedAqeTransport(command, args = []) {
  if (typeof command !== 'string' || !Array.isArray(args)) return false;
  const binary = path.basename(command);
  if (['aqe-mcp', 'aqe-mcp.cmd'].includes(binary)) return args.length === 0;
  return ['npx', 'npx.cmd'].includes(binary)
    && JSON.stringify(args) === JSON.stringify(['-y', 'agentic-qe@latest', 'mcp']);
}

export function parseEmbeddingJson(source) {
  try { return JSON.parse(source); }
  catch { throw new Error('invalid JSON configuration preserved'); }
}
