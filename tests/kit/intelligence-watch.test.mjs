import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IntelligenceWatch } from '../../src/lib/live/intelligence-watch.mjs';

const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ak-intel-watch-'));

/** A controllable fake clock: `now()` returns the current fake ms, `advance`
 *  moves it forward without any real wall-clock wait. */
const makeClock = (startMs = 0) => {
  let ms = startMs;
  return { now: () => ms, advance: (delta) => { ms += delta; } };
};

/** A fake interval: captures the callback `start()` registers so the test can
 *  fire poll ticks manually, deterministically, with no real timers. */
const fakeTimer = () => {
  let tick = null;
  let handle = null;
  return {
    setInterval: (fn) => {
      tick = fn;
      handle = { unref() {} };
      return handle;
    },
    clearInterval: () => {},
    fire: () => tick(),
  };
};

test('constructor requires an onUpdate callback', () => {
  assert.throws(() => new IntelligenceWatch({ cwd: sandbox() }), TypeError);
});

test('flushes once, only after debounceMs of quiet following a watched-file change', () => {
  const dir = sandbox();
  const file = path.join(dir, 'stats.json');
  fs.writeFileSync(file, '{}');
  const clock = makeClock(0);
  const timer = fakeTimer();
  const updates = [];
  const watcher = new IntelligenceWatch({
    cwd: dir,
    watchedFiles: [file],
    pendingInsightsFile: path.join(dir, 'pending.jsonl'),
    debounceMs: 2_500,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    now: clock.now,
    readGlobalStats: () => null,
    readIntelHistory: () => ({ n: updates.length }),
    appendHealthSnapshot: () => {},
    onUpdate: (combined) => updates.push(combined),
  });

  watcher.start(); // t=0: file exists for the first time -> a detected change
  assert.equal(updates.length, 0, 'must not flush on the same tick a change is first observed');

  clock.advance(1_000);
  timer.fire(); // t=1000 < debounceMs since the change
  assert.equal(updates.length, 0);

  clock.advance(1_000);
  timer.fire(); // t=2000 < debounceMs since the change
  assert.equal(updates.length, 0);

  clock.advance(600);
  timer.fire(); // t=2600 >= debounceMs(2500) since the change -> flush
  assert.equal(updates.length, 1);

  clock.advance(10_000);
  timer.fire(); // no new change -> must not flush again
  assert.equal(updates.length, 1);
});

test('coalesces a burst of file changes into a single debounced flush', () => {
  const dir = sandbox();
  const file = path.join(dir, 'stats.json');
  fs.writeFileSync(file, '{}');
  const clock = makeClock(0);
  const timer = fakeTimer();
  const updates = [];
  const watcher = new IntelligenceWatch({
    cwd: dir,
    watchedFiles: [file],
    pendingInsightsFile: path.join(dir, 'pending.jsonl'),
    debounceMs: 2_500,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    now: clock.now,
    readGlobalStats: () => null,
    readIntelHistory: () => ({ n: updates.length }),
    appendHealthSnapshot: () => {},
    onUpdate: (combined) => updates.push(combined),
  });

  watcher.start(); // t=0: baseline change, lastChangeAt=0

  clock.advance(1_000);
  fs.utimesSync(file, new Date(1_000), new Date(1_000)); // burst edit #2
  timer.fire(); // t=1000: another change resets the quiet window
  assert.equal(updates.length, 0);

  clock.advance(1_000);
  fs.utimesSync(file, new Date(2_000), new Date(2_000)); // burst edit #3
  timer.fire(); // t=2000: another change resets the quiet window again
  assert.equal(updates.length, 0);

  clock.advance(2_500);
  timer.fire(); // t=4500: 2500ms quiet since the LAST edit (t=2000) -> exactly one flush
  assert.equal(updates.length, 1, 'three edits within the window must collapse into one onUpdate call');
});

test('a pending-insights.jsonl append triggers a flush even when watched files are unchanged', () => {
  const dir = sandbox();
  const pendingFile = path.join(dir, 'pending.jsonl');
  // The file must already exist before start() so the tailer's first
  // reconcile() baselines its offset at the CURRENT size (startAtEnd:true) --
  // otherwise content written after the baseline would look like history.
  fs.writeFileSync(pendingFile, '');
  const clock = makeClock(0);
  const timer = fakeTimer();
  const updates = [];
  const watcher = new IntelligenceWatch({
    cwd: dir,
    watchedFiles: [], // isolate the jsonl-tailer signal from mtime polling
    pendingInsightsFile: pendingFile,
    debounceMs: 1_000,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    now: clock.now,
    readGlobalStats: () => null,
    readIntelHistory: () => ({ combined: true }),
    appendHealthSnapshot: () => {},
    onUpdate: (combined) => updates.push(combined),
  });

  watcher.start(); // baselines at offset 0 -> no change yet
  assert.equal(updates.length, 0);

  fs.appendFileSync(pendingFile, `${JSON.stringify({ type: 'edit' })}\n`);
  clock.advance(200);
  timer.fire(); // tailer reconciles the new line -> change detected
  assert.equal(updates.length, 0);

  clock.advance(1_000);
  timer.fire(); // quiet window elapsed -> flush
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { combined: true });
});

test('a malformed pending-insights.jsonl line is reported via onError but does not by itself trigger a flush', () => {
  const dir = sandbox();
  const pendingFile = path.join(dir, 'pending.jsonl');
  fs.writeFileSync(pendingFile, ''); // exists before start() so the tailer baselines at offset 0
  const clock = makeClock(0);
  const timer = fakeTimer();
  const updates = [];
  const errors = [];
  const watcher = new IntelligenceWatch({
    cwd: dir,
    watchedFiles: [],
    pendingInsightsFile: pendingFile,
    debounceMs: 500,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    now: clock.now,
    readGlobalStats: () => null,
    readIntelHistory: () => ({ ok: true }),
    appendHealthSnapshot: () => {},
    onUpdate: (combined) => updates.push(combined),
    onError: (error) => errors.push(error),
  });

  watcher.start();
  // JsonlTailer calls onRecord only for a line that parses; a malformed line
  // routes to the tailer's onError instead (see jsonl-tailer.mjs), so this
  // watcher's tailerDirty flag -- set only from onRecord -- is intentionally
  // NOT raised here: garbage bytes alone must not push a dashboard update.
  fs.appendFileSync(pendingFile, 'not-json\n');
  clock.advance(600);
  timer.fire();
  assert.equal(errors.length, 1, 'the malformed line must still be reported via onError');
  assert.equal(updates.length, 0, 'a malformed line alone must not trigger a flush');
});

test('appendHealthSnapshot is only called when globalStats genuinely changes between flushes', () => {
  const dir = sandbox();
  const file = path.join(dir, 'stats.json');
  fs.writeFileSync(file, '{}');
  const clock = makeClock(0);
  const timer = fakeTimer();
  const appended = [];
  let stats = { patternsLearned: 1 };
  const watcher = new IntelligenceWatch({
    cwd: dir,
    watchedFiles: [file],
    pendingInsightsFile: path.join(dir, 'pending.jsonl'),
    debounceMs: 500,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    now: clock.now,
    readGlobalStats: () => stats,
    readIntelHistory: () => ({}),
    appendHealthSnapshot: (cwd, snapshot) => appended.push(snapshot),
    onUpdate: () => {},
  });

  watcher.start(); // t=0: baseline change
  clock.advance(600);
  timer.fire(); // t=600: flush #1 -- stats differ from "never seen" -> appended
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0], { patternsLearned: 1, ts: 600 });

  // File rewritten with identical stats content (e.g. a no-op re-save).
  fs.utimesSync(file, new Date(1_000), new Date(1_000));
  clock.advance(600);
  timer.fire(); // t=1200: change detected, quiet window starts
  clock.advance(600);
  timer.fire(); // t=1800: flush #2 -- stats unchanged -> must NOT append again
  assert.equal(appended.length, 1);

  // Now the stats genuinely change.
  stats = { patternsLearned: 2 };
  fs.utimesSync(file, new Date(2_000), new Date(2_000));
  clock.advance(600);
  timer.fire();
  clock.advance(600);
  timer.fire(); // flush #3 -- stats changed -> appended again
  assert.equal(appended.length, 2);
  assert.equal(appended[1].patternsLearned, 2);
});

test('reader errors are caught, routed to onError, and never reach onUpdate', () => {
  const dir = sandbox();
  const pendingFile = path.join(dir, 'pending.jsonl');
  fs.writeFileSync(pendingFile, ''); // exists before start() so the tailer baselines at offset 0
  const clock = makeClock(0);
  const timer = fakeTimer();
  const errors = [];
  const updates = [];
  const boom = new Error('boom');
  const watcher = new IntelligenceWatch({
    cwd: dir,
    watchedFiles: [],
    pendingInsightsFile: pendingFile,
    debounceMs: 500,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    now: clock.now,
    readGlobalStats: () => { throw boom; },
    readIntelHistory: () => { throw boom; },
    appendHealthSnapshot: () => {},
    onUpdate: (combined) => updates.push(combined),
    onError: (error) => errors.push(error),
  });

  watcher.start();
  fs.appendFileSync(pendingFile, `${JSON.stringify({ type: 'edit' })}\n`);
  clock.advance(600);
  timer.fire(); // t=600: change detected this tick -> quiet window not elapsed yet
  clock.advance(600);
  timer.fire(); // t=1200: quiet window elapsed since the change -> flush

  assert.equal(updates.length, 0, 'onUpdate must not fire when readIntelHistory threw');
  assert.equal(errors.filter((error) => error === boom).length, 2,
    'both the readGlobalStats and readIntelHistory failures must reach onError');
});

test('a statSync failure other than ENOENT is routed to onError but does not stop polling', () => {
  const dir = sandbox();
  const clock = makeClock(0);
  const timer = fakeTimer();
  const errors = [];
  const updates = [];
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  const fsImpl = { statSync: () => { throw denied; } };
  const watcher = new IntelligenceWatch({
    cwd: dir,
    watchedFiles: [path.join(dir, 'unreadable.json')],
    pendingInsightsFile: path.join(dir, 'pending.jsonl'),
    debounceMs: 500,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    now: clock.now,
    fsImpl,
    readGlobalStats: () => null,
    readIntelHistory: () => ({ ok: true }),
    appendHealthSnapshot: () => {},
    onUpdate: (combined) => updates.push(combined),
    onError: (error) => errors.push(error),
  });

  watcher.start(); // first observation of a permanently-failing stat still counts as a baseline change
  assert.ok(errors.includes(denied));

  clock.advance(600);
  timer.fire(); // debounce window elapsed since the baseline -> exactly one flush
  assert.equal(updates.length, 1);

  clock.advance(600);
  timer.fire(); // stat keeps failing the same way -> no further "change" -> no second flush
  assert.equal(updates.length, 1);
});

test('start() is idempotent and stop() invokes the injected clearInterval exactly once', () => {
  const dir = sandbox();
  let intervalCalls = 0;
  let clearedWith;
  const handle = { unref() {} };
  const watcher = new IntelligenceWatch({
    cwd: dir,
    watchedFiles: [],
    pendingInsightsFile: path.join(dir, 'pending.jsonl'),
    setInterval: () => { intervalCalls += 1; return handle; },
    clearInterval: (h) => { clearedWith = h; },
    now: () => 0,
    readGlobalStats: () => null,
    readIntelHistory: () => ({}),
    appendHealthSnapshot: () => {},
    onUpdate: () => {},
  });

  watcher.start();
  watcher.start(); // idempotent: must not register a second interval
  assert.equal(intervalCalls, 1);

  watcher.stop();
  assert.equal(clearedWith, handle);
  watcher.stop(); // safe no-op when already stopped
});

test('end-to-end: real intel-history.mjs readers wired against the default project paths', () => {
  const dir = sandbox();
  const statsFile = path.join(dir, '.claude-flow', 'neural', 'stats.json');
  fs.mkdirSync(path.dirname(statsFile), { recursive: true });
  fs.writeFileSync(statsFile, JSON.stringify({
    patternsLearned: 3, trajectoriesRecorded: 5, signalsProcessed: 7, lastAdaptation: 123,
  }));
  const clock = makeClock(0);
  const timer = fakeTimer();
  const updates = [];
  const watcher = new IntelligenceWatch({
    cwd: dir,
    debounceMs: 1_000,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    now: clock.now,
    onUpdate: (combined) => updates.push(combined),
  });

  watcher.start();
  clock.advance(1_500);
  timer.fire();

  assert.equal(updates.length, 1);
  assert.equal(updates[0].globalStats.patternsLearned, 3);
  assert.deepEqual(updates[0].patternStore, []);

  const ringFile = path.join(dir, '.claude-flow', 'health-history.json');
  const ring = JSON.parse(fs.readFileSync(ringFile, 'utf8'));
  assert.equal(ring.samples.length, 1);
  assert.equal(ring.samples[0].patternsLearned, 3);
  assert.equal(typeof ring.samples[0].ts, 'number');
});
