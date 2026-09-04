// Machine footprint — RuntimeCensus (ADR-0025 §4, docs/ddd/machine-footprint.md).
//
// EPHEMERAL BY INVARIANT (#5): computed per request, never written into the
// persisted snapshot. A process table is a moment, not a fact worth retaining,
// and replaying a stale one as liveness is the trap that invariant closes.
// Nothing in this module writes to disk — there is no `carriedForward` figure
// here, by construction.
//
// Figures report in walk.mjs's Measurement vocabulary so an unmeasured quantity
// can never be mistaken for a measured zero (invariant #2, ADR-0023). No
// running daemons is `measured(0)`; a daemon census that failed is `unknown`.
import os from 'node:os';
import path from 'node:path';
import { listDaemons, staleDaemons } from '../daemons.mjs';
import { surveyHostProcesses } from '../live/process-sessions.mjs';
import { measured, sumMeasurements, unknown } from './walk.mjs';
import { classifyWorkingContext } from './working-context.mjs';

// Why a working directory was unavailable, in the words the Runtime table
// renders. Each is a distinguishable cause — a blocked probe, a denied handle,
// a bitness mismatch — because "we could not attribute this process" and "this
// process has no project" are different facts. A row never guesses a project
// and never renders blank.
const CWD_REASONS = new Map([
  ['cwd-unavailable', 'not attributable — the process reported no working directory'],
  ['cwd-survey-failed', 'not attributable — the working-directory probe failed'],
  ['open-denied', 'not attributable — access to the process was denied'],
  ['wow64-mismatch', 'not attributable on Windows — 32-bit process, 64-bit probe'],
  ['reader-not-64bit', 'not attributable on Windows — 32-bit PowerShell cannot read the process'],
  ['compile-failed', 'not attributable on Windows — the working-directory probe could not be built'],
  ['probe-failed', 'not attributable on Windows — the working-directory probe was refused'],
  ['query-failed', 'not attributable on Windows — the process could not be queried'],
  ['peb-read-failed', 'not attributable on Windows — the process environment could not be read'],
  ['parameters-read-failed', 'not attributable on Windows — the process environment could not be read'],
  ['cwd-read-failed', 'not attributable on Windows — the working directory could not be read'],
  ['empty-cwd', 'not attributable — the process recorded an empty working directory'],
]);

const cwdDetail = (reason) => CWD_REASONS.get(reason)
  ?? `not attributable — working directory unavailable (${reason})`;

const hostTitle = (host) => ({ claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' })[host]
  ?? String(host || 'Host');

function sourceOf(entry, { platform, classifyContext }) {
  if (entry.controllerKind === 'host-service') {
    return measured({ kind: 'host-service', label: `${hostTitle(entry.host)} app service` });
  }
  if (entry.controllerKind === 'desktop-app') {
    return measured({ kind: 'desktop-app', label: `${hostTitle(entry.host)} desktop app` });
  }
  if (!entry.cwd) return unknown(cwdDetail(entry.cwdReason ?? 'cwd-unavailable'));
  const pathImpl = platform === 'win32' ? path.win32 : path;
  const context = classifyContext(entry.cwd, { pathImpl });
  return context ? measured(context) : unknown('not attributable — working directory is not absolute');
}

function projectOf(entry, source) {
  if (source?.status === 'measured' && source.value?.kind === 'repository') {
    return measured({
      path: source.value.path,
      label: source.value.label,
      key: source.value.projectKey,
    });
  }
  if (!entry.cwd) return unknown(cwdDetail(entry.cwdReason ?? 'cwd-unavailable'));
  return unknown('this process is not running from a proven Git repository');
}

function machineFacts(osImpl) {
  let cores;
  try { cores = osImpl.cpus()?.length ?? 0; } catch { cores = 0; }
  return {
    // The denominator every RSS figure in the System area is read against.
    physicalMemoryBytes: measured(osImpl.totalmem()),
    freeMemoryBytes: measured(osImpl.freemem()),
    // A container with no readable CPU topology reports zero cores — an
    // unmeasured quantity, not a machine with no CPUs.
    cpuCount: cores > 0 ? measured(cores) : unknown('the platform reported no CPU topology'),
  };
}

/**
 * The daemon census: how many ruflo daemons are alive and how old the oldest is
 * against its TTL.
 *
 * There is deliberately NO launch-budget field. `ruflo daemon budget` exists as
 * a CLI, but the kit has no local file or API to read it from — not
 * circumstantially, structurally — so the field could only ever have rendered
 * as "unavailable". A permanently unknowable quantity is removed rather than
 * reported as degraded: an unknown that can never resolve is not honest
 * degradation, it is a promise the product cannot keep, and it teaches the
 * reader to ignore the unknowns that DO mean something (ADR-0023 §9). If ruflo
 * ever exposes a readable local source, this is where the field comes back.
 */
async function daemonCensus({ listDaemonsImpl, cwd, ttlSecs }) {
  try {
    const daemons = await listDaemonsImpl({ cwd });
    const ages = daemons.map((entry) => entry.ageSecs).filter((age) => Number.isFinite(age));
    return {
      count: measured(daemons.length),
      staleCount: measured(staleDaemons(daemons, ttlSecs).length),
      ttlSecs,
      oldestAgeSecs: ages.length ? measured(Math.max(...ages)) : unknown(daemons.length
        ? 'no running daemon recorded a start time'
        : 'no daemons are running'),
      entries: daemons.map((entry) => ({
        pid: entry.pid,
        workspace: entry.workspace,
        workspaceExists: entry.workspaceExists,
        ageSecs: Number.isFinite(entry.ageSecs)
          ? measured(entry.ageSecs)
          : unknown('this daemon recorded no start time'),
      })),
    };
  } catch (error) {
    const reason = `daemon discovery failed (${error?.code ?? error?.name ?? 'error'})`;
    return {
      count: unknown(reason),
      staleCount: unknown(reason),
      ttlSecs,
      oldestAgeSecs: unknown(reason),
      entries: [],
    };
  }
}

/**
 * Collect the RuntimeCensus. Never throws: a failed process survey degrades the
 * process section to unknown-with-reason while the daemon census and the
 * machine denominators still render, because those are independent facts and
 * losing one must not blank the view.
 *
 * Every collaborator is injectable, mirroring how the process survey injects
 * its command runner — the win32 path is exercised by feeding fixture output
 * through `surveyImpl`, not by running Windows.
 *
 * @param {{
 *   surveyImpl?: typeof surveyHostProcesses,
 *   listDaemonsImpl?: typeof listDaemons,
 *   osImpl?: typeof os,
 *   platform?: NodeJS.Platform,
 *   cwd?: string,
 *   ttlSecs?: number,
 *   now?: number,
 *   classifyContext?: typeof classifyWorkingContext,
 * }} [options]
 */
export async function collectRuntimeCensus({
  surveyImpl = surveyHostProcesses,
  listDaemonsImpl = listDaemons,
  osImpl = os,
  platform = process.platform,
  cwd = process.cwd(),
  ttlSecs = Number(process.env.RUFLO_DAEMON_TTL_SECS ?? 43200),
  now = Date.now(),
  classifyContext = classifyWorkingContext,
} = {}) {
  const observedAt = new Date(now).toISOString();
  const machine = machineFacts(osImpl);
  const daemons = await daemonCensus({ listDaemonsImpl, cwd, ttlSecs });

  let survey = null;
  let failure = null;
  try {
    survey = await surveyImpl({ platform, now });
  } catch (error) {
    failure = error?.code ?? 'ERR_RUNTIME_PROCESS_SURVEY';
  }

  if (!survey) {
    const reason = `the process survey could not run (${failure})`;
    return {
      observedAt,
      platform,
      ephemeral: true,
      processes: unknown(reason),
      totals: {
        processCount: unknown(reason),
        rssBytes: unknown(reason),
        cpuPercent: unknown(reason),
      },
      daemons,
      machine,
    };
  }

  const rows = survey.processes.map((entry) => {
    const source = sourceOf(entry, { platform, classifyContext });
    return {
      host: entry.host,
      pid: entry.pid,
      startedAt: entry.startedAt,
      // Kept alongside `project` so a renderer or a debug log can key on the
      // machine token while the user reads the sentence.
      cwdReason: entry.cwd ? null : (entry.cwdReason ?? 'cwd-unavailable'),
      source,
      uptimeMs: Number.isFinite(entry.uptimeMs)
        ? measured(entry.uptimeMs)
        : unknown('the process reported no usable start time'),
      cpuPercent: Number.isFinite(entry.cpuPercent)
        ? measured(entry.cpuPercent)
        : unknown('the platform reported no CPU time for this process'),
      rssBytes: Number.isFinite(entry.rssBytes)
        ? measured(entry.rssBytes)
        : unknown('the platform reported no resident set size for this process'),
      project: projectOf(entry, source),
    };
  });

  return {
    observedAt: survey.observedAt ?? observedAt,
    platform: survey.platform ?? platform,
    ephemeral: true,
    // `processes.value` is the row array, not a number — the Measurement
    // wrapper is what states "the survey ran" as distinct from "no processes".
    processes: measured(rows),
    // NOTE: the survey still counts child and MCP-server processes — that count
    // is what makes the per-host rows correct — but it is no longer republished
    // here. As a rendered figure it was a bare number with no denominator, no
    // history and no action attached to it; as an input it is unchanged.
    totals: {
      processCount: measured(rows.length),
      // sumMeasurements marks a total `partial` when a row could not report,
      // so the combined figure stays an honest lower bound instead of silently
      // treating an unmeasured process as consuming nothing.
      rssBytes: sumMeasurements(rows.map((row) => row.rssBytes)),
      cpuPercent: sumMeasurements(rows.map((row) => row.cpuPercent)),
    },
    daemons,
    machine,
  };
}
