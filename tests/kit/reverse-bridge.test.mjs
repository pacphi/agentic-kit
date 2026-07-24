import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rufloCodexMcpStatus } from '../../src/lib/mcp.mjs';

/** Build a temp $HOME containing (or not) ~/.codex/config.toml with given body. */
function tempHome(configBody) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rev-'));
  if (configBody != null) {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), configBody);
  }
  return home;
}

test('rufloCodexMcpStatus detects a registered ruflo MCP server', () => {
  const home = tempHome('[mcp_servers.ruflo]\ncommand = "ruflo"\nargs = ["mcp", "start"]\n');
  const s = rufloCodexMcpStatus({}, { home });
  assert.equal(s.registered, true);
});

test('rufloCodexMcpStatus reports not-registered when the table is absent', () => {
  const home = tempHome('[mcp_servers.other]\ncommand = "x"\n');
  const s = rufloCodexMcpStatus({}, { home });
  assert.equal(s.registered, false);
});

test('rufloCodexMcpStatus reports not-registered when config.toml is missing', () => {
  const home = tempHome(null); // no .codex/config.toml
  const s = rufloCodexMcpStatus({}, { home });
  assert.equal(s.registered, false);
});

test('rufloCodexMcpStatus reflects ak ownership from the kit.json marker', () => {
  const home = tempHome('[mcp_servers.ruflo]\n');
  const owned = rufloCodexMcpStatus({ providers: { rufloCodexMcp: 'ak' } }, { home });
  const unowned = rufloCodexMcpStatus({ providers: {} }, { home });
  assert.equal(owned.owned, true);
  assert.equal(unowned.owned, false);
});

test('rufloCodexMcpStatus does not match a similarly-named table', () => {
  // a table like [mcp_servers.ruflo-extra] must not satisfy the ruflo check
  const home = tempHome('[mcp_servers.ruflo-extra]\ncommand = "x"\n');
  const s = rufloCodexMcpStatus({}, { home });
  assert.equal(s.registered, false);
});
