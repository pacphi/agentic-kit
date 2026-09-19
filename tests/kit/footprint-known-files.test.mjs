// The cheap footprint tier stats individually-known kit files. The Claude
// context-window ledger directory is listed beside claude-rate-limits.json so
// its presence is visible. Hermetic: config/state roots are temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { knownFileNodes } from '../../src/lib/footprint/index.mjs';

function withConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-known-files-'));
  const keys = ['XDG_CONFIG_HOME', 'APPDATA', 'XDG_STATE_HOME', 'LOCALAPPDATA'];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.XDG_CONFIG_HOME = dir; process.env.APPDATA = dir;
  process.env.XDG_STATE_HOME = dir; process.env.LOCALAPPDATA = dir;
  try { return fn(dir); } finally {
    for (const k of keys) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const node = (id) => knownFileNodes().find((n) => n.id === id);

test('the ledger directory is a known kit path beside claude-rate-limits.json', () => withConfig((dir) => {
  const ledger = node('ak-claude-context-windows');
  const limits = node('ak-claude-limits');
  assert.ok(ledger, 'listed');
  assert.equal(ledger.host, limits.host);
  assert.equal(ledger.category, limits.category);
  assert.equal(ledger.label, 'claude-context-windows');
  assert.equal(ledger.path, path.join(dir, 'agentic-kit', 'claude-context-windows'));
  assert.equal(path.dirname(ledger.path), path.dirname(limits.path));
}));

test('absent ledger directory is a measured zero, present is reported as a directory with no claimed size', () => withConfig((dir) => {
  assert.equal(node('ak-claude-context-windows').presence, 'absent');
  fs.mkdirSync(path.join(dir, 'agentic-kit', 'claude-context-windows'), { recursive: true });
  const present = node('ak-claude-context-windows');
  assert.equal(present.presence, 'present');
  assert.equal(present.kind, 'dir');
  assert.notEqual(present.bytes.status, 'measured', 'a directory is never given a file size');
}));
