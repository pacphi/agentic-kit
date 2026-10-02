// Checkout-only transport harness. The supplied child is a real released AQE
// entrypoint in live conformance; fixture children exercise transport failures.
export function createMcpSession(run, { timeoutMs = 30_000, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  if (!run.child.stdin) throw Error('MCP session requires call-owned piped input');
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  let bytes = 0;
  let failure = null;
  const fail = (error) => {
    failure ??= error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(failure);
    }
    pending.clear();
  };
  const receive = (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxOutputBytes) { fail(Error('MCP output limit exceeded')); return; }
    if (failure) return;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      if (response?.jsonrpc !== '2.0') continue;
      const entry = pending.get(response.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      pending.delete(response.id);
      if (response.error || !Object.hasOwn(response, 'result')) entry.reject(Error('MCP request failed'));
      else entry.resolve(response.result);
    }
  };
  const closed = () => fail(Error('MCP child closed before request completion'));
  const inputFailed = () => fail(Error('MCP input pipe failed'));
  run.child.stdout.on('data', receive);
  run.child.once('close', closed);
  run.child.stdin.on('error', inputFailed);

  function request(method, params) {
    if (failure || run.closed || run.error || run.inputError) return Promise.reject(failure ?? Error('MCP transport unavailable'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`MCP ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      run.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async function discover() {
    const protocolVersion = '2025-03-26';
    const server = await request('initialize', { protocolVersion, capabilities: {},
      clientInfo: { name: 'agentic-kit-lock-conformance', version: '1' } });
    if (server?.protocolVersion !== protocolVersion || typeof server.serverInfo?.name !== 'string'
      || typeof server.serverInfo?.version !== 'string') throw Error('MCP initialize schema or negotiated protocol mismatch');
    run.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const result = await request('tools/list', {});
    if (!Array.isArray(result?.tools) || !result.tools.length
      || result.tools.some((tool) => typeof tool?.name !== 'string' || !tool.name
        || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema))) {
      throw Error('MCP tools/list schema invalid');
    }
    return { protocolVersion, serverInfo: server.serverInfo, toolCount: result.tools.length };
  }

  function dispose() {
    fail(Error('MCP session disposed'));
    run.child.stdout.off('data', receive);
    run.child.off('close', closed);
    run.child.stdin.off('error', inputFailed);
  }
  return { discover, dispose };
}
