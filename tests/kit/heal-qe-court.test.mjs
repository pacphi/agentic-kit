// healQeCourtPanel — TEMPORARY heal for agentic-qe's own shipped default
// (proffesor-for-testing/agentic-qe#576: defense=cognitum-low + jury=cognitum-high
// collide on vendor, violating the config's own writerIsNeverJuror). Remove this
// test alongside heal.mjs's healQeCourtPanel once a released aqe fixes it upstream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { healQeCourtPanel } from '../../src/lib/heal.mjs';
import { qeCourtConfigPath } from '../../src/lib/qeCourt.mjs';

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-heal-qecourt-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });
function writeConfig(dir, routing, options = {}) {
  const file = qeCourtConfigPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ routing, options: { writerIsNeverJuror: true, ...options } }));
  return file;
}

test('healQeCourtPanel is a no-op when there is no project root', () => {
  const r = healQeCourtPanel('/nonexistent-path-xyz');
  assert.equal(r.ok, true);
  assert.match(r.detail, /no project root/);
});

test('healQeCourtPanel is a no-op when qe-court has not created its config yet', () => {
  const dir = tmpProject();
  const r = healQeCourtPanel(dir);
  assert.equal(r.ok, true);
  assert.match(r.detail, /no qe-court config present/);
  rm(dir);
});

test('healQeCourtPanel is a no-op (and touches nothing) when the panel is already valid', () => {
  const dir = tmpProject();
  const file = writeConfig(dir, {
    defense: { provider: 'cognitum-low' },
    'prosecutor.codex-review': { provider: 'codex' },
    jury: { provider: 'claude-code' },
  });
  const before = fs.readFileSync(file, 'utf8');
  const r = healQeCourtPanel(dir);
  assert.equal(r.ok, true);
  assert.match(r.detail, /already valid/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(`${file}.bak`), false);
  rm(dir);
});

test('healQeCourtPanel reassigns jury and backs up the original on a collision', () => {
  const dir = tmpProject();
  const file = writeConfig(dir, {
    defense: { provider: 'cognitum-low' },
    'prosecutor.codex-review': { provider: 'codex' },
    jury: { provider: 'cognitum-high' },
    deeperReviewer: { provider: 'codex' },
  });
  const r = healQeCourtPanel(dir);
  assert.equal(r.ok, true);
  assert.match(r.detail, /jury cognitum-high → codex/);
  assert.match(r.detail, /agentic-qe\/issues\/576/);

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.routing.jury.provider, 'codex');
  assert.equal(after.routing.defense.provider, 'cognitum-low'); // untouched
  assert.equal(after.routing.deeperReviewer.provider, 'codex'); // untouched

  const backup = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
  assert.equal(backup.routing.jury.provider, 'cognitum-high');
  rm(dir);
});

test('healQeCourtPanel is idempotent — running it twice makes no further change', () => {
  const dir = tmpProject();
  const file = writeConfig(dir, {
    defense: { provider: 'cognitum-low' },
    'prosecutor.codex-review': { provider: 'codex' },
    jury: { provider: 'cognitum-high' },
  });
  healQeCourtPanel(dir);
  const afterFirst = fs.readFileSync(file, 'utf8');
  const r2 = healQeCourtPanel(dir);
  assert.match(r2.detail, /already valid/);
  assert.equal(fs.readFileSync(file, 'utf8'), afterFirst);
  rm(dir);
});

test('healQeCourtPanel leaves an unfixable violation untouched', () => {
  const dir = tmpProject();
  const file = writeConfig(dir, {
    defense: { provider: 'cognitum-low' },
    'prosecutor.sherlock': { provider: 'cognitum-high' },
    jury: { provider: 'cognitum-mid' }, // every seat is cognitum — no distinct vendor to borrow
  });
  const before = fs.readFileSync(file, 'utf8');
  const r = healQeCourtPanel(dir);
  assert.match(r.detail, /unfixable automatically/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  rm(dir);
});
