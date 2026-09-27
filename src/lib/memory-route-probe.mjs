// Cross-interface observation of project memory (issue #213): does a value
// written through one Ruflo interface come back through the other? The process
// boundaries (CLI runner, MCP session, on-disk lookup) are injected so this
// stays a pure choreography that only ever touches an isolated fixture.
//
// Order matters: the MCP session stores its key and then reads the CLI key in
// one process, and the CLI reads the MCP key afterwards from a fresh process.
// A result is only "observed" when both writes were accepted; an unusable
// interface is reported as unavailable, never as aligned or split.

const CLI_KEY = 'route-written-by-cli';
const MCP_KEY = 'route-written-by-mcp';

const seenBy = (found) => (found ? 'visible' : 'not-visible');

// Only an explicit found:false is evidence of absence. Any other shape (an error
// string, an object value, a missing field) is a Ruflo contract change or a
// failure, and reporting it as a split would be a false verdict.
function classifyMcpRead(data, value) {
  if (!data || typeof data !== 'object' || typeof data.found !== 'boolean') return 'unknown';
  if (!data.found) return 'not-visible';
  return data.value === value ? 'visible' : 'unknown';
}

function mcpFailure(session) {
  if (session.status !== 'ok') return `MCP session ${session.status}`;
  const [stored, read] = session.results;
  if (!stored?.ok || stored.data?.success !== true) {
    return String(stored?.error ?? stored?.data?.error ?? 'memory_store did not report success');
  }
  return read?.ok ? null : String(read?.error ?? 'memory_retrieve did not answer');
}

/** @returns {Promise<object>} observation; see describeMemoryRoutes */
export async function observeMemoryRoutes({ namespace, value, cli, mcp, locate }) {
  if (!(await cli.store(CLI_KEY, value))) return { status: 'cli-unavailable' };
  const session = await mcp([
    { name: 'memory_store', arguments: { key: MCP_KEY, value, namespace } },
    { name: 'memory_retrieve', arguments: { key: CLI_KEY, namespace } },
  ]);
  const detail = mcpFailure(session);
  if (detail) return { status: 'mcp-unavailable', detail };
  const cliSeesMcp = await cli.retrieve(MCP_KEY);
  const backend = session.results[0].data?.backend;
  return {
    status: 'observed',
    cliToMcp: classifyMcpRead(session.results[1].data, value),
    mcpToCli: cliSeesMcp.ok ? seenBy(cliSeesMcp.found) : 'unknown',
    cliStore: locate(CLI_KEY),
    mcpStore: locate(MCP_KEY),
    mcpBackend: typeof backend === 'string' ? backend : null,
  };
}

const splitRow = (message) => ({ level: 'warn', message });

const backendNote = (observation) => (observation.mcpBackend
  ? `(MCP backend: ${observation.mcpBackend})` : '(MCP backend unknown)');

const mcpToCliRow = (observation) => {
  const where = observation.mcpStore
    ? `${observation.mcpStore} (read it with ruflo memory retrieve --path <project>/.swarm/${observation.mcpStore})`
    : 'an unlocated store';
  return splitRow(`an MCP write is not visible to a CLI read; it landed in ${where} ${backendNote(observation)}`);
};

/** @returns {Array<{level:string,message:string}>} */
export function describeMemoryRoutes(observation) {
  if (observation.status === 'cli-unavailable') {
    return [splitRow('cross-interface routing not observed: the CLI store step failed')];
  }
  if (observation.status === 'mcp-unavailable') {
    return [splitRow(`cross-interface routing not observed: MCP round-trip unavailable (${observation.detail})`)];
  }
  const rows = [];
  if (observation.mcpToCli === 'not-visible') rows.push(mcpToCliRow(observation));
  if (observation.mcpToCli === 'unknown') {
    rows.push(splitRow('an MCP write read back through the CLI was not observed (ruflo memory retrieve failed)'));
  }
  if (observation.cliToMcp === 'not-visible') {
    rows.push(splitRow(`a CLI write is not visible to an MCP read; it landed in ${observation.cliStore ?? 'an unlocated store'} ${backendNote(observation)}`));
  }
  if (observation.cliToMcp === 'unknown') {
    rows.push(splitRow('a CLI write read back through MCP was not observed (unexpected memory_retrieve response)'));
  }
  return rows.length ? rows : [{ level: 'ok',
    message: `CLI and MCP see each other's writes in an isolated test project ${backendNote(observation)}` }];
}
