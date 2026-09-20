import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aqeTomlEnvironment } from '../../src/lib/aqe-embedding-toml.mjs';

test('ordinary quoted Codex project tables do not block a scoped AQE edit', () => {
  const unrelated = '[projects."/Users/user/a.b"]\ntrust_level = "trusted"\n';
  const source = '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\nargs = []\n' + unrelated;
  const next = aqeTomlEnvironment(source).replace({ present: true, value: 'http://localhost:11434' });
  assert.ok(next.includes(unrelated));
  assert.match(next, /AQE_EMBEDDER_ENDPOINT/);
});
test('quoted aliases of AQE tables are recognized without confusing dots within keys', () => {
  const source = '[mcp_servers."agentic-qe"]\ncommand = "aqe-mcp"\n[mcp_servers."agentic-qe".env]\nAQE_EMBEDDER_ENDPOINT = "http://localhost:11434"\n';
  assert.equal(aqeTomlEnvironment(source).current.value, 'http://localhost:11434');
  assert.equal(aqeTomlEnvironment('[mcp_servers."agentic-qe.env"]\ncommand = "other"\n').missing, true);
});
