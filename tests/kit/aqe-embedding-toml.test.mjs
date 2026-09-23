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
test('multi-line AQE args written by aqe/codex are recognized and edited in place', () => {
  const base = '[mcp_servers.agentic-qe]\ntype = "stdio"\ncommand = "npx"\nargs = [\n    "-y",\n    "agentic-qe@latest",\n    "mcp",\n]\n\n[mcp_servers.agentic-qe.env]\nAQE_V3_MODE = "true"\n';
  const editor = aqeTomlEnvironment(base);
  assert.deepEqual(editor.current, { present: false });
  const next = editor.replace({ present: true, value: 'http://127.0.0.1:11434' });
  assert.ok(next.startsWith(base.slice(0, base.indexOf('[mcp_servers.agentic-qe.env]'))));
  assert.equal(aqeTomlEnvironment(next).current.value, 'http://127.0.0.1:11434');
});
test('multi-line AQE args with non-string entries or comments stay unsupported', () => {
  assert.throws(() => aqeTomlEnvironment('[mcp_servers.agentic-qe]\ncommand = "npx"\nargs = [\n  1,\n]\n'), /arguments encoding/);
  assert.throws(() => aqeTomlEnvironment('[mcp_servers.agentic-qe]\ncommand = "npx"\nargs = [\n  "-y", # pin\n  "agentic-qe",\n]\n'), /arguments encoding/);
});
