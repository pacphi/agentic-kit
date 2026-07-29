import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PRESETS, applyCodexStatusline, inspectCodexStatusline, projectionFor,
  removeCodexStatusline, statuslineDrift,
} from '../../src/lib/codex-statusline.mjs';

const roots = [];
const fixture = (body = null) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-codex-statusline-'));
  roots.push(root);
  const file = path.join(root, 'config.toml');
  if (body != null) fs.writeFileSync(file, body);
  return file;
};

test('applies native preset when config and [tui] are absent', () => {
  const file = fixture();
  const r = applyCodexStatusline('native', file);
  assert.equal(r.changed, true);
  assert.deepEqual(inspectCodexStatusline(file).values, projectionFor('native'));
});

test('preserves unrelated tables, comments, and keys in existing [tui]', () => {
  const file = fixture('# hello\nmodel = "gpt"\n\n[tui]\nnotifications = true # keep\n\n[mcp_servers.ruflo]\ncommand = "ruflo"\n');
  applyCodexStatusline('extended', file);
  const out = fs.readFileSync(file, 'utf8');
  assert.match(out, /# hello/);
  assert.match(out, /notifications = true # keep/);
  assert.match(out, /\[mcp_servers\.ruflo\]\ncommand = "ruflo"/);
  assert.deepEqual(inspectCodexStatusline(file).values.status_line, PRESETS.extended);
});

test('replaces a multiline /statusline-style array idempotently', () => {
  const file = fixture('[tui]\nstatus_line_use_colors = false\nstatus_line = [\n  "model", # old\n  "git-branch",\n]\nother = 1\n');
  applyCodexStatusline('native', file);
  const once = fs.readFileSync(file, 'utf8');
  assert.equal(applyCodexStatusline('native', file).changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), once);
  assert.match(once, /other = 1/);
});

test('preserves CRLF newline style', () => {
  const file = fixture('[tui]\r\nother = true\r\n');
  applyCodexStatusline('native', file);
  const out = fs.readFileSync(file, 'utf8');
  assert.ok(!/(?<!\r)\n/.test(out), 'must not introduce bare LF');
  assert.equal((out.match(/\[tui\]/g) ?? []).length, 1, 'must recognize the existing CRLF table');
});

test('invalid duplicate managed keys are rejected without writing', () => {
  const body = '[tui]\nstatus_line = []\nstatus_line = []\n';
  const file = fixture(body);
  assert.throws(() => applyCodexStatusline('native', file), /duplicate status_line/);
  assert.equal(fs.readFileSync(file, 'utf8'), body);
  assert.equal(inspectCodexStatusline(file).valid, false);
});

test('preserves a hash inside a quoted status-line item while stripping comments', () => {
  const file = fixture('[tui]\nstatus_line = [\n  "custom#field", # comment\n]\n');
  assert.deepEqual(inspectCodexStatusline(file).values.status_line, ['custom#field']);
});

for (const [label, body] of [
  ['quoted table', '["tui"]\nstatus_line = []\n'],
  ['single-quoted table', "['tui']\nstatus_line = []\n"],
  ['dotted key', 'tui.status_line = []\n'],
  ['quoted key', '[tui]\n"status_line" = []\n'],
]) {
  test(`fails closed on TOML-equivalent ${label} syntax`, () => {
    const file = fixture(body);
    assert.equal(inspectCodexStatusline(file).valid, false);
    assert.throws(() => applyCodexStatusline('native', file), /not safely patchable/);
    assert.equal(fs.readFileSync(file, 'utf8'), body);
  });
}

test('off removes only values that still equal the last managed projection', () => {
  const file = fixture('[tui]\nother = true\n');
  applyCodexStatusline('native', file);
  let out = fs.readFileSync(file, 'utf8').replace('status_line_use_colors = true', 'status_line_use_colors = false');
  fs.writeFileSync(file, out);
  const r = removeCodexStatusline(projectionFor('native'), file);
  assert.equal(r.changed, true);
  out = fs.readFileSync(file, 'utf8');
  assert.match(out, /status_line_use_colors = false/, 'user-modified key survives');
  assert.doesNotMatch(out, /^status_line =/m, 'unchanged managed key is removed');
  assert.match(out, /other = true/);
});

test('ownership controls drift and unmanaged configurations are never actionable', () => {
  const file = fixture('[tui]\nstatus_line = ["custom"]\n');
  assert.equal(statuslineDrift({ statusline: { codex: null } }, file).drifted, false);
  const cfg = { statusline: { codex: { preset: 'native', lastProjection: projectionFor('native') } } };
  assert.equal(statuslineDrift(cfg, file).drifted, true);
  applyCodexStatusline('native', file);
  assert.equal(statuslineDrift(cfg, file).drifted, false);
});

test.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
