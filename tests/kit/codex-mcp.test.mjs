import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexMcpStatus } from '../../src/lib/mcp.mjs';

// A tmp dir with a .git marker → repoRoot() resolves to it, so codexMcpStatus reads
// the .mcp.json we write here (not the real repo's).
function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-codexmcp-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const writeMcp = (dir, servers) =>
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }));

test('registered is false when no .mcp.json exists', () => {
  const dir = tmpProject();
  try {
    assert.deepEqual(codexMcpStatus({}, dir), { registered: false, owned: false });
  } finally { rm(dir); }
});

test('registered is true when .mcp.json lists a codex server', () => {
  const dir = tmpProject();
  try {
    writeMcp(dir, { codex: { command: 'codex', args: ['mcp-server'] } });
    assert.equal(codexMcpStatus({}, dir).registered, true);
  } finally { rm(dir); }
});

test('registered is false when .mcp.json has other servers but not codex', () => {
  const dir = tmpProject();
  try {
    writeMcp(dir, { 'claude-flow': { command: 'ruflo' } });
    assert.equal(codexMcpStatus({}, dir).registered, false);
  } finally { rm(dir); }
});

test('owned reflects the kit.json ak-ownership marker', () => {
  const dir = tmpProject();
  try {
    writeMcp(dir, { codex: {} });
    assert.equal(codexMcpStatus({ providers: { codexMcp: 'ak' } }, dir).owned, true);
    assert.equal(codexMcpStatus({ providers: { codexMcp: null } }, dir).owned, false);
    assert.equal(codexMcpStatus({}, dir).owned, false);
  } finally { rm(dir); }
});

test('a pre-existing (unowned) codex server is registered but not owned', () => {
  const dir = tmpProject();
  try {
    writeMcp(dir, { codex: {} });
    assert.deepEqual(codexMcpStatus({ providers: { codexMcp: null } }, dir),
      { registered: true, owned: false });
  } finally { rm(dir); }
});

test('malformed .mcp.json degrades to not-registered (no throw)', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{ not valid json');
    assert.deepEqual(codexMcpStatus({}, dir), { registered: false, owned: false });
  } finally { rm(dir); }
});
