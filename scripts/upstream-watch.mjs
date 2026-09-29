#!/usr/bin/env node
// Deterministic upstream watch (maintainer tooling; package.json `files` does
// not ship scripts/). Reads the one upstream registry, checks each watched
// thread with `gh` and `npm`, and prints a report or ledger event lines. It
// never writes to GitHub, npm or the registry; acting on the output is the
// maintainer's (or the routine's) job, under the registry's approval policy.
// POSIX only: on Windows `npm` is a .cmd file that execFile cannot start
// without a shell, and a shell would misread the caret ranges passed to npm.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadUpstreamRegistry } from '../src/lib/hook-audit/upstream.mjs';
import { computeSupportWindow, minorFirstPublished } from '../src/lib/ruflo-support-window.mjs';
import {
  buildReport, candidateVersions, confirmationStart, ledgerEvents, nextRelease, tagRefs, upstreamOf, withoutRecorded,
} from './upstream-watch/classify.mjs';
import { createDispatcher, dispatch } from './upstream-watch/dispatch.mjs';
import { createFetcher, mapLimit, retrying } from './upstream-watch/fetch.mjs';
import { createLedgerStore, toRecord } from './upstream-watch/ledger-branch.mjs';
import { LEDGER_EVENTS, commitSafe, isoSeconds, renderNotice, sentence } from './upstream-watch/ledger.mjs';
import { renderEvents, renderReport } from './upstream-watch/render.mjs';

const USAGE = `usage: node scripts/upstream-watch.mjs report [--json] [--concurrency <1-16>] [--registry <file>]
       node scripts/upstream-watch.mjs check --since <iso-date> [--json] [--concurrency <1-16>] [--registry <file>]
       node scripts/upstream-watch.mjs record [--since <iso-date>] [--dry-run] [--json] [--concurrency <1-16>] [--registry <file>]
       node scripts/upstream-watch.mjs ledger [--id <owner/repo#n>] [--event <name>] [--since <iso-date>] [--recorded-since <iso-date>] [--json] [--registry <file>]
`;
const PENDING = new Set(['watching', 'fixed-unreleased']);
// record exits BLIND when gh, the registry, the ledger branch or every upstream thread is unreadable.
const BLIND = 3;

class UsageError extends Error {}

function sinceValue(value, flag = '--since') {
  const time = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(time)) {
    throw new UsageError(`${flag} must be an ISO date or date-time`);
  }
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['report', 'check', 'record', 'ledger'].includes(command)) throw new UsageError(command ? `unknown command ${command}` : 'missing command');
  const options = { command, json: false, concurrency: 4, since: null, recordedSince: null, registry: null, dryRun: false, id: null, event: null };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    const value = () => {
      const next = rest[++index];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return next;
    };
    if (flag === '--json') options.json = true;
    else if (flag === '--concurrency') options.concurrency = Number(value());
    else if (flag === '--registry') options.registry = value();
    else if (flag === '--dry-run' && command === 'record') options.dryRun = true;
    else if (flag === '--since' && ['check', 'record', 'ledger'].includes(command)) options.since = sinceValue(value());
    else if (flag === '--recorded-since' && command === 'ledger') options.recordedSince = sinceValue(value(), flag);
    else if (flag === '--id' && command === 'ledger') options.id = value();
    else if (flag === '--event' && command === 'ledger') {
      options.event = value();
      if (!LEDGER_EVENTS.includes(options.event)) throw new UsageError(`--event must be one of ${LEDGER_EVENTS.join(', ')}`);
    }
    else throw new UsageError(`unknown option ${flag}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
    throw new UsageError('--concurrency must be an integer from 1 to 16');
  }
  if (command === 'check' && !options.since) throw new UsageError('check needs --since <iso-date>');
  return options;
}

// Without a recorded first fixed version, a release counts only when it
// contains the merged fixing change: walk the releases published after that
// change merged in the order nextRelease gives (oldest first, then the newest,
// then the gap) until it finds the oldest release not ruled out.
async function confirmReleases(entries, live, fetcher, concurrency, fetchErrors) {
  await mapLimit(entries, concurrency, async (entry) => {
    const state = live.get(entry.id);
    try {
      const changes = await fetcher.fixingChanges(entry.id);
      const checks = [];
      if (changes.length) {
        const candidates = candidateVersions(confirmationStart(upstreamOf(state.thread).fixedAt, { changes }), state.release);
        for (let item = nextRelease(candidates, checks, state.release); item; item = nextRelease(candidates, checks, state.release)) {
          const found = await fetcher.contains(changes[0].repo, tagRefs(entry.doneWhen.release, item.version), changes[0].sha);
          checks.push({ version: item.version, ...found });
        }
      }
      state.confirmation = { changes, checks };
    } catch (error) {
      // The release is "Could not check"; the thread already read is kept, so its
      // closed, reply and acknowledged lines are not lost.
      state.confirmation = { changes: [], checks: [], error: error.message };
      fetchErrors.push({ id: entry.id, error: error.message });
    }
  });
}

// What the newest carrier (Ruflo for AgentDB) installs, or the carrier at `at`
// (the support-window floor) into `floorBundle`, once per chain; a failure
// leaves the field unset, so the entry is "Could not check".
async function resolveBundles(entries, live, fetcher, concurrency, fetchErrors, { at = null, into = 'bundle' } = {}) {
  const keyOf = (gate) => [...gate.bundledBy, gate.name].join('>');
  const chains = [...new Map(entries.map((entry) => [keyOf(entry.doneWhen.release), entry.doneWhen.release])).entries()];
  const bundles = new Map();
  await mapLimit(chains, concurrency, async ([key, gate]) => {
    try {
      bundles.set(key, await fetcher.bundled(gate.bundledBy, gate.name, at));
    } catch (error) {
      for (const entry of entries.filter((item) => keyOf(item.doneWhen.release) === key)) fetchErrors.push({ id: entry.id, error: error.message });
    }
  });
  for (const entry of entries) {
    const bundle = bundles.get(keyOf(entry.doneWhen.release));
    if (bundle) live.get(entry.id)[into] = bundle;
  }
}

/**
 * Decision B3-D5: an AgentDB fix delivered through Ruflo waits, like a Ruflo
 * fix, until the oldest supported Ruflo bundles it. Resolved for the entries
 * the newest carrier was checked for, and for those the registry records as
 * released with a first fixed version.
 */
async function resolveFloorBundles(registry, live, fetcher, floor, concurrency, fetchErrors) {
  const entries = registry.watch.filter((entry) => {
    const gate = entry.doneWhen?.release;
    const state = live.get(entry.id);
    if (entry.status === 'retired' || gate?.bundledBy?.[0] !== 'ruflo' || !state?.thread) return false;
    return Boolean(state.bundle) || (['released', 'dispatched'].includes(entry.status) && Boolean(gate.minVersion));
  });
  await resolveBundles(entries, live, fetcher, concurrency, fetchErrors, { at: floor, into: 'floorBundle' });
}

async function collect(registry, fetcher, concurrency) {
  const active = registry.watch.filter((entry) => entry.status !== 'retired');
  const live = new Map();
  const fetchErrors = [];
  await mapLimit(active, concurrency, async (entry) => {
    try {
      live.set(entry.id, { thread: await fetcher.thread(entry.id) });
    } catch (error) {
      live.set(entry.id, { error: error.message });
      fetchErrors.push({ id: entry.id, error: error.message });
    }
  });
  // Release facts only where a fixed thread still has a pending ak change.
  const gated = active.filter((entry) => live.get(entry.id).thread && PENDING.has(entry.status)
    && entry.doneWhen.release && upstreamOf(live.get(entry.id).thread).fixed);
  const gates = [...new Map(gated.map((entry) => [`${entry.doneWhen.release.channel}:${entry.doneWhen.release.name}`, entry.doneWhen.release])).entries()];
  const facts = new Map();
  await mapLimit(gates, concurrency, async ([key, gate]) => {
    try {
      facts.set(key, await fetcher.release(gate));
    } catch (error) {
      fetchErrors.push({ id: gate.name, error: error.message });
    }
  });
  for (const entry of gated) {
    live.get(entry.id).release = facts.get(`${entry.doneWhen.release.channel}:${entry.doneWhen.release.name}`) ?? null;
  }
  await confirmReleases(gated.filter((entry) => !entry.doneWhen.release.minVersion && live.get(entry.id).release), live, fetcher, concurrency, fetchErrors);
  await resolveBundles(gated.filter((entry) => entry.doneWhen.release.bundledBy), live, fetcher, concurrency, fetchErrors);
  fetchErrors.sort((a, b) => a.id.localeCompare(b.id));
  // Blind judges upstream threads only: a token scoped to the home repository
  // still reads our tracking issues there while every upstream read fails.
  const own = `${registry.watchPolicy.repo.toLowerCase()}#`;
  const upstream = active.filter((entry) => !entry.id.toLowerCase().startsWith(own));
  const judged = upstream.length ? upstream : active;
  const blind = judged.length > 0 && judged.every((entry) => !live.get(entry.id).thread);
  return { live, fetchErrors, facts, blind };
}

/**
 * ADR-0041 §7: the oldest supported Ruflo, from the npm release dates the
 * watch reads anyway (reused when a gate already fetched them). Null when the
 * registry carries no window or npm could not be read; in the second case the
 * report marks the floor unknown and holds every Ruflo-carried fix.
 */
async function supportFloor(registry, fetcher, facts, fetchErrors, now) {
  const window = registry.dependencyPolicies.find((policy) => policy.dependency === 'ruflo')?.supportWindow;
  if (!window) return null;
  let ruflo = facts.get('npm:ruflo');
  if (!ruflo) {
    try {
      ruflo = await fetcher.release({ channel: 'npm', name: 'ruflo' });
    } catch (error) {
      fetchErrors.push({ id: 'ruflo support window', error: error.message });
      return null;
    }
  }
  const time = Object.fromEntries(ruflo.versions.map((item) => [item.version, item.publishedAt]));
  return computeSupportWindow({
    firstPublished: minorFirstPublished(time), now: now.getTime(), newestMinors: window.newestMinors, minDays: window.minDays,
  })?.floor ?? null;
}

/** Every read the watch makes, then the report; `blind` when nothing could be read. */
async function runCheck(registry, fetcher, options, { stderr, now }) {
  const auth = await fetcher.auth();
  const offline = auth.ok ? null : auth.message;
  if (offline) stderr.write(`${offline}\n`);
  // Blind: gh is unusable, or not one watched thread could be read.
  const { live, fetchErrors, facts, blind } = offline
    ? { live: new Map(), fetchErrors: [], facts: new Map(), blind: true } : await collect(registry, fetcher, options.concurrency);
  const floor = offline ? null : await supportFloor(registry, fetcher, facts, fetchErrors, now);
  if (floor) {
    await resolveFloorBundles(registry, live, fetcher, floor, options.concurrency, fetchErrors);
    fetchErrors.sort((a, b) => a.id.localeCompare(b.id));
  }
  // A window policy whose floor could not be read holds Ruflo-carried fixes.
  const floorUnknown = !offline && !floor && Boolean(registry.dependencyPolicies.find((policy) => policy.dependency === 'ruflo')?.supportWindow);
  const report = buildReport(registry, live, { now, offline, fetchErrors, supportFloor: floor, floorUnknown });
  return { report, offline, fetchErrors, blind };
}

async function lastRunOf(fetcher, repo, now) {
  if (typeof fetcher.lastRun !== 'function') return null;
  try {
    const run = await fetcher.lastRun(repo);
    return run ? { at: run.at, ageHours: Math.round((now.getTime() - Date.parse(run.at)) / 360_000) / 10, url: run.url } : null;
  } catch (error) {
    return { error: error.message };
  }
}

async function ledgerQuery(registry, options, { stdout, stderr, now, ledgerStore }) {
  const { branch } = registry.watchPolicy.ledger;
  let ledger;
  try {
    ledger = await ledgerStore.read(branch, { now });
  } catch (error) {
    stderr.write(`Could not read the ledger branch ${branch}: ${error.message}\n`);
    return BLIND;
  }
  // --since selects by the event's date; --recorded-since by when the run wrote it.
  const day = options.since?.slice(0, 10);
  const written = options.recordedSince ? Date.parse(options.recordedSince) : null;
  const matches = ledger.records.filter((item) => (!options.id || item.id === options.id)
    && (!options.event || item.event === options.event) && (!day || item.date >= day)
    && (written === null || Date.parse(item.recordedAt) >= written));
  if (options.json) stdout.write(`${JSON.stringify({ commit: ledger.commit, checkedAt: ledger.checkedAt, records: matches }, null, 2)}\n`);
  else stdout.write(matches.length ? `${matches.map((item) => item.line).join('\n')}\n` : 'No matching records.\n');
  return 0;
}

const WEEK = 7 * 86_400_000;

function blindRecord(error, { stdout, stderr, json }, extra = {}, { writeError = true } = {}) {
  if (writeError) stderr.write(`${error}\n`);
  const result = {
    blind: true, error, records: [], fetchErrors: [], dispatchErrors: [], wouldFire: [], fired: [], parent: null, commit: null, notice: { post: false, body: '' }, ...extra,
  };
  if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return BLIND;
}

/**
 * The scheduled run (spec 2026-09-28): read the ledger branch, check from its
 * window, fire the dispatch routine for new dispatch work, and build one local
 * commit when there are new records. Never pushes; the workflow does. A dry
 * run makes the same read-only dispatch checks and lists what would fire.
 */
async function record(registry, fetcher, options, { stdout, stderr, now, ledgerStore, dispatcher, sleep }) {
  const { repo, ledger: { branch, sentinel }, notify: { mention } } = registry.watchPolicy;
  const io = { stdout, stderr, json: options.json };
  if (options.since && Date.parse(options.since) > now.getTime()) {
    stderr.write(`--since is in the future\n${USAGE}`);
    return 2;
  }
  const auth = await fetcher.auth();
  if (!auth.ok) return blindRecord(auth.message, io);
  let ledger;
  try {
    ledger = await ledgerStore.read(branch, { now });
  } catch (error) {
    return blindRecord(`Could not read the ledger branch ${branch}: ${error.message}`, io);
  }
  const since = options.since ?? ledger.checkedAt ?? isoSeconds(now.getTime() - WEEK);
  const sinceSource = options.since ? 'flag' : ledger.checkedAt ? 'ledger' : 'default';
  const { report, fetchErrors, blind } = await runCheck(registry, retrying(fetcher, { sleep }), options, { stderr: { write: () => true }, now });
  if (blind) return blindRecord('Not one upstream thread could be read.', io, { fetchErrors });
  const runAt = isoSeconds(now);
  const recorded = ledger.records.map((item) => item.line).join('\n');
  const all = ledgerEvents(report, registry, { since });
  const released = all.filter((event) => event.event === 'released' && event.fields.branch);
  const eligibleIds = new Set(registry.watch.filter((entry) => PENDING.has(entry.status)).map((entry) => entry.id));
  const fired = await dispatch({ released, records: ledger.records, dispatcher, repo, sentinel, now, recordedAt: runAt, dryRun: options.dryRun, eligibleIds });
  const records = [...withoutRecorded(all, recorded).map((event) => toRecord(event, runAt)), ...fired.records];
  const checkedAt = fetchErrors.length ? (ledger.checkedAt ?? since) : runAt;
  let commit = null;
  if (!options.dryRun && records.length) {
    try {
      commit = await ledgerStore.build({
        parent: ledger.commit, records: [...ledger.records, ...records], checkedAt,
        subject: `upstream-watch: ${records.length} new ${records.length === 1 ? 'record' : 'records'}`,
        sentences: records.map((item) => commitSafe(sentence(item))),
      });
    } catch (error) {
      // The routine already ran for these; without the commit the next run fires again.
      const sessions = fired.records.filter((item) => item.event === 'fired');
      for (const item of sessions) stderr.write(`Fired ${item.id} before the ledger commit failed: session ${item.fields.session}\n`);
      return blindRecord(`Could not build the ledger commit: ${error.message}`, io, { fetchErrors, dispatchErrors: fired.errors, fired: sessions });
    }
  }
  const body = renderNotice({ records, mention, date: runAt.slice(0, 10), recordedAt: runAt });
  const result = {
    since, sinceSource, checkedAt, blind: false, records, fetchErrors, dispatchErrors: fired.errors, wouldFire: fired.wouldFire,
    parent: ledger.commit, commit, notice: { post: Boolean(body), body },
  };
  for (const item of fetchErrors) stderr.write(`Could not check ${item.id}: ${item.error}\n`);
  for (const item of fired.errors) stderr.write(`Dispatch ${item.id}: ${item.error}\n`);
  const lines = [...records.map((item) => item.line), ...fired.wouldFire.map((item) => `Would fire ${item.id} ${item.version} ${item.branch}`)];
  stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : lines.length ? `${lines.join('\n')}\n` : 'No new records.\n');
  return 0;
}

export async function main(argv, {
  fetcher = createFetcher(), ledgerStore = createLedgerStore(), dispatcher = createDispatcher(),
  sleep = undefined, stdout = process.stdout, stderr = process.stderr, now = new Date(),
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`${error.message}\n${USAGE}`);
    return 2;
  }
  const registry = loadUpstreamRegistry({ ...(options.registry ? { file: path.resolve(options.registry) } : {}), now: () => now });
  if (registry.registryStatus !== 'valid') {
    stderr.write(`upstream registry is ${registry.registryStatus ?? registry.status}:\n${registry.errors.map((error) => `  ${error}`).join('\n')}\n`);
    const status = { status: registry.registryStatus ?? registry.status, errors: registry.errors };
    if (options.command === 'record') {
      return blindRecord(`upstream registry is ${status.status}`, { stdout, stderr, json: options.json }, { registry: status }, { writeError: false });
    }
    if (options.command === 'ledger') {
      if (options.json) stdout.write(`${JSON.stringify({ registry: status }, null, 2)}\n`);
      return BLIND;
    }
    stdout.write(options.json ? `${JSON.stringify({ registry: status }, null, 2)}\n` : 'No report: the upstream registry is not valid.\n');
    return 0;
  }
  if (options.command === 'record') return record(registry, fetcher, options, { stdout, stderr, now, ledgerStore, dispatcher, sleep });
  if (options.command === 'ledger') return ledgerQuery(registry, options, { stdout, stderr, now, ledgerStore });
  const { report, offline, fetchErrors, blind } = await runCheck(registry, fetcher, options, { stderr, now });
  if (options.command === 'report') {
    if (!offline) report.lastRun = await lastRunOf(fetcher, registry.watchPolicy.repo, now);
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
    return 0;
  }
  const events = offline ? [] : ledgerEvents(report, registry, { since: options.since });
  if (options.json) stdout.write(`${JSON.stringify({ since: options.since, offline, blind, events, fetchErrors }, null, 2)}\n`);
  else {
    // stdout stays ledger lines only; what could not be checked goes to stderr.
    for (const item of fetchErrors) stderr.write(`Could not check ${item.id}: ${item.error}\n`);
    stdout.write(offline ? `No events: ${offline}\n` : renderEvents(events, fetchErrors));
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
