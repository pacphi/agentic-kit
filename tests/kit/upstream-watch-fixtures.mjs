// Shared helpers for the upstream watch's record, ledger and report tests:
// recorded gh/npm fixtures (tests/fixtures/upstream-watch/), a registry file
// built from the real one, an in-memory ledger store and a fake dispatcher.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UPSTREAM_REGISTRY_FILE } from '../../src/lib/hook-audit/upstream.mjs';
import { releaseFacts } from '../../scripts/upstream-watch/classify.mjs';

const FIXTURES = path.resolve('tests/fixtures/upstream-watch');
const threads = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'threads.json'), 'utf8')).threads;
const npm = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'npm.json'), 'utf8')).packages;
export const NOW = new Date('2026-09-26T23:00:00Z');
export const clone = (value) => JSON.parse(JSON.stringify(value));
export const noSleep = async () => {};

export function entry(id, overrides = {}) {
  const [repo, n] = id.split('#');
  return {
    id, url: `https://github.com/${repo}/issues/${n}`, relation: 'filed', kind: 'issue', title: `title of ${id}`,
    dependency: repo.endsWith('agentic-qe') ? 'agentic-qe' : 'ruflo',
    doneWhen: { state: 'closed-completed', release: { channel: 'npm', name: repo.endsWith('agentic-qe') ? 'agentic-qe' : 'ruflo', minVersion: null } },
    mapping: 'mapped', kitImpact: { refs: ['a plan ref'], files: [] }, adjustment: 'the ak change', status: 'watching',
    constraintIds: [], history: [{ date: '2026-09-26', event: 'registered' }], ...overrides,
  };
}

/** A registry file with `watch` as its watch list (plus retired entries for constraint issues). */
export async function withRegistryFile(watch, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-watch-record-'));
  try {
    const document = JSON.parse(fs.readFileSync(UPSTREAM_REGISTRY_FILE, 'utf8'));
    document.watch = watch;
    document.lastVerifiedAt = '2026-09-26';
    document.lastCheckedAt = '2026-09-26';
    for (const constraint of document.constraints) constraint.nextRetestAt = '2026-10-03';
    for (const constraint of document.constraints.filter((item) => item.issue)) {
      const id = constraint.issue.replace('https://github.com/', '').replace('/issues/', '#');
      const existing = watch.find((item) => item.id === id);
      if (existing) { existing.constraintIds = [...existing.constraintIds, constraint.id]; continue; }
      watch.push(entry(id, { status: 'retired', dependency: constraint.dependency, constraintIds: [constraint.id], doneWhen: { state: 'closed-completed', release: null } }));
    }
    const file = path.join(root, 'registry.json');
    fs.writeFileSync(file, JSON.stringify(document));
    return await run(file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function fixtureFetcher({ authenticated = true, failing = new Set(), flaky = new Map() } = {}) {
  return {
    auth: async () => (authenticated ? { ok: true } : { ok: false, message: 'gh is not authenticated; run `gh auth login`, then re-run.' }),
    thread: async (id) => {
      if (failing.has(id)) throw new Error('HTTP 502');
      if (flaky.get(id) > 0) { flaky.set(id, flaky.get(id) - 1); throw new Error('HTTP 502'); }
      if (!threads[id]) throw new Error(`no fixture for ${id}`);
      return clone(threads[id]);
    },
    release: async ({ name }) => releaseFacts('npm', npm[name]),
    fixingChanges: async () => [],
    contains: async () => ({ ref: null, contained: null }),
    bundled: async () => null,
  };
}

export function memoryLedger(initial = { commit: null, records: [], checkedAt: null }) {
  const built = [];
  return { built, read: async () => clone(initial), build: async (input) => { built.push(clone(input)); return 'c'.repeat(40); } };
}

export function fakeDispatcher({ exists = false, fireError = null } = {}) {
  const fired = [];
  return {
    fired,
    branchExists: async () => exists,
    openPullRequest: async () => null,
    fire: async (text) => { if (fireError) throw new Error(fireError); fired.push(text); return 'https://claude.ai/code/session_new'; },
  };
}

export function capture() {
  const out = [];
  return { stream: { write: (chunk) => { out.push(String(chunk)); return true; } }, text: () => out.join('') };
}
