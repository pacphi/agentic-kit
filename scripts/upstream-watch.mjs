#!/usr/bin/env node
// Deterministic upstream watch (maintainer tooling; package.json `files` does
// not ship scripts/). Reads the one upstream registry, checks each watched
// thread with `gh` and `npm`, and prints a report or ledger event lines. It
// never writes to GitHub, npm or the registry; acting on the output is the
// maintainer's (or the routine's) job, under the registry's approval policy.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadUpstreamRegistry } from '../src/lib/hook-audit/upstream.mjs';
import {
  buildReport, candidateVersions, confirmationStart, ledgerEvents, tagRefs, upstreamOf, withoutRecorded,
} from './upstream-watch/classify.mjs';
import { createFetcher, mapLimit } from './upstream-watch/fetch.mjs';
import { renderEvents, renderReport } from './upstream-watch/render.mjs';

const USAGE = `usage: node scripts/upstream-watch.mjs report [--json] [--concurrency <1-16>] [--registry <file>]
       node scripts/upstream-watch.mjs check --since <iso-date> [--ledger <file>] [--json] [--concurrency <1-16>] [--registry <file>]
`;
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
  if (!['report', 'check'].includes(command)) throw new UsageError(command ? `unknown command ${command}` : 'missing command');
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
// change merged, oldest first, and stop at the first that contains it or has
// no tag to check.
async function confirmReleases(entries, live, fetcher, concurrency, fetchErrors) {
  await mapLimit(entries, concurrency, async (entry) => {
    const state = live.get(entry.id);
    try {
      const changes = await fetcher.fixingChanges(entry.id);
      const checks = [];
      if (changes.length) {
        for (const item of candidateVersions(confirmationStart(upstreamOf(state.thread).fixedAt, { changes }), state.release)) {
          const found = await fetcher.contains(changes[0].repo, tagRefs(entry.doneWhen.release, item.version), changes[0].sha);
          checks.push({ version: item.version, ...found });
          if (found.contained !== false) break;
        }
      }
      state.confirmation = { changes, checks };
    } catch (error) {
      state.error = error.message;
      fetchErrors.push({ id: entry.id, error: error.message });
    }
  });
}

// What the newest carrier (Ruflo for AgentDB) installs, once per chain; a
// failure leaves `bundle` unset, so the entry is "Could not check".
async function resolveBundles(entries, live, fetcher, concurrency, fetchErrors) {
  const keyOf = (gate) => [...gate.bundledBy, gate.name].join('>');
  const chains = [...new Map(entries.map((entry) => [keyOf(entry.doneWhen.release), entry.doneWhen.release])).entries()];
  const bundles = new Map();
  await mapLimit(chains, concurrency, async ([key, gate]) => {
    try {
      bundles.set(key, await fetcher.bundled(gate.bundledBy, gate.name));
    } catch (error) {
      for (const entry of entries.filter((item) => keyOf(item.doneWhen.release) === key)) fetchErrors.push({ id: entry.id, error: error.message });
    }
  });
  for (const entry of entries) {
    const bundle = bundles.get(keyOf(entry.doneWhen.release));
    if (bundle) live.get(entry.id).bundle = bundle;
  }
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
  return { live, fetchErrors };
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
    stdout.write(options.json ? `${JSON.stringify({ registry: { status: registry.registryStatus ?? registry.status, errors: registry.errors } }, null, 2)}\n` : 'No report: the upstream registry is not valid.\n');
    return 0;
  }
  const auth = await fetcher.auth();
  const offline = auth.ok ? null : auth.message;
  if (offline) stderr.write(`${offline}\n`);
  const { live, fetchErrors } = offline ? { live: new Map(), fetchErrors: [] } : await collect(registry, fetcher, options.concurrency);
  const report = buildReport(registry, live, { now, offline, fetchErrors });
  if (options.command === 'report') {
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
    return 0;
  }
  const events = offline ? [] : withoutRecorded(ledgerEvents(report, registry, { since: options.since }), ledgerText);
  if (options.json) stdout.write(`${JSON.stringify({ since: options.since, offline, events }, null, 2)}\n`);
  else stdout.write(offline ? `No events: ${offline}\n` : renderEvents(events));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
