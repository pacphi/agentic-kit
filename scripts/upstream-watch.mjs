#!/usr/bin/env node
// Deterministic upstream watch (maintainer tooling; package.json `files` does
// not ship scripts/). Reads the one upstream registry, checks each watched
// thread with `gh` and `npm`, and prints a report or ledger event lines. It
// never writes to GitHub, npm or the registry; acting on the output is the
// maintainer's (or the routine's) job, under the registry's approval policy.
// POSIX only: on Windows `npm` is a .cmd file that execFile cannot start
// without a shell, and a shell would misread the caret ranges passed to npm.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadUpstreamRegistry } from '../src/lib/hook-audit/upstream.mjs';
import { computeSupportWindow, minorFirstPublished } from '../src/lib/ruflo-support-window.mjs';
import {
  buildReport, candidateVersions, confirmationStart, ledgerEvents, nextRelease, tagRefs, upstreamOf, withoutRecorded,
} from './upstream-watch/classify.mjs';
import { createFetcher, mapLimit } from './upstream-watch/fetch.mjs';
import { isoSeconds, readLedger, renderComment } from './upstream-watch/ledger.mjs';
import { renderEvents, renderReport } from './upstream-watch/render.mjs';

const USAGE = `usage: node scripts/upstream-watch.mjs report [--json] [--concurrency <1-16>] [--registry <file>]
       node scripts/upstream-watch.mjs check --since <iso-date> [--ledger <file>] [--json] [--concurrency <1-16>] [--registry <file>]
       node scripts/upstream-watch.mjs comment [--json] [--concurrency <1-16>] [--registry <file>]
`;
// comment exits BLIND when it could read nothing (gh unusable, the ledger, or
// every watched thread), so the scheduled workflow fails visibly (decision 14).
const BLIND = 3;
const PENDING = new Set(['watching', 'fixed-unreleased']);

class UsageError extends Error {}

function sinceValue(value) {
  const time = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(time)) {
    throw new UsageError('--since must be an ISO date or date-time');
  }
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['report', 'check', 'comment'].includes(command)) throw new UsageError(command ? `unknown command ${command}` : 'missing command');
  const options = { command, json: false, concurrency: 4, since: null, ledger: null, registry: null };
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
    else if (flag === '--since' && command === 'check') options.since = sinceValue(value());
    else if (flag === '--ledger' && command === 'check') options.ledger = value();
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
  // Blind judges upstream threads only: a token scoped to the ledger's own
  // repository still reads our tracking issues there while every upstream read fails.
  const own = `${registry.watchPolicy.ledger.repo.toLowerCase()}#`;
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

const blindResult = (error) => ({ blind: true, post: false, error, events: [], fetchErrors: [], dispatch: [], body: '' });

/**
 * The ledger comment (decision 14): read our ledger comments, check from the
 * newest `checked-at` in them, and print the body to post, or nothing. The
 * scheduled workflow posts it as-is; the script itself writes nothing.
 */
async function comment(registry, fetcher, options, { stdout, stderr, now }) {
  const { repo, issue, authors } = registry.watchPolicy.ledger;
  const auth = await fetcher.auth();
  let ledger = null;
  let failure = auth.ok ? null : auth.message;
  if (!failure) {
    try {
      ledger = readLedger(await fetcher.comments(repo, issue), authors, now);
    } catch (error) {
      failure = `Could not read the ledger ${repo}#${issue}: ${error.message}`;
    }
  }
  if (failure) {
    stderr.write(`${failure}\n`);
    if (options.json) stdout.write(`${JSON.stringify(blindResult(failure), null, 2)}\n`);
    return BLIND;
  }
  const { report, fetchErrors, blind } = await runCheck(registry, fetcher, options, { stderr: { write: () => true }, now });
  const events = withoutRecorded(ledgerEvents(report, registry, { since: ledger.since }), ledger.text);
  const body = blind ? '' : renderComment({ events, fetchErrors, since: ledger.since, now });
  const result = {
    since: ledger.since, sinceSource: ledger.sinceSource, now: isoSeconds(now), checkedAt: fetchErrors.length ? ledger.since : isoSeconds(now),
    blind, post: Boolean(body), dispatch: events.filter((event) => event.event === 'released' && event.fields.branch).map((event) => event.fields.branch),
    events, fetchErrors, body,
  };
  for (const item of fetchErrors) stderr.write(`Could not check ${item.id}: ${item.error}\n`);
  stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : body);
  return blind ? BLIND : 0;
}

export async function main(argv, {
  fetcher = createFetcher(), stdout = process.stdout, stderr = process.stderr, now = new Date(),
} = {}) {
  let options;
  let ledgerText = null;
  try {
    options = parseArgs(argv);
    if (options.ledger) {
      try { ledgerText = fs.readFileSync(options.ledger, 'utf8'); } catch (error) { throw new UsageError(`cannot read --ledger ${options.ledger}: ${error.code ?? error.message}`); }
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`${error.message}\n${USAGE}`);
    return 2;
  }
  const registry = loadUpstreamRegistry({ ...(options.registry ? { file: path.resolve(options.registry) } : {}), now: () => now });
  if (registry.registryStatus !== 'valid') {
    stderr.write(`upstream registry is ${registry.registryStatus ?? registry.status}:\n${registry.errors.map((error) => `  ${error}`).join('\n')}\n`);
    const status = { status: registry.registryStatus ?? registry.status, errors: registry.errors };
    // The scheduled comment run must not pass quietly on a broken registry, and
    // the workflow reads one JSON shape whatever failed.
    if (options.command === 'comment') {
      if (options.json) stdout.write(`${JSON.stringify({ ...blindResult(`upstream registry is ${status.status}`), registry: status }, null, 2)}\n`);
      return BLIND;
    }
    stdout.write(options.json ? `${JSON.stringify({ registry: status }, null, 2)}\n` : 'No report: the upstream registry is not valid.\n');
    return 0;
  }
  if (options.command === 'comment') return comment(registry, fetcher, options, { stdout, stderr, now });
  const { report, offline, fetchErrors, blind } = await runCheck(registry, fetcher, options, { stderr, now });
  if (options.command === 'report') {
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
    return 0;
  }
  const events = offline ? [] : withoutRecorded(ledgerEvents(report, registry, { since: options.since }), ledgerText);
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
