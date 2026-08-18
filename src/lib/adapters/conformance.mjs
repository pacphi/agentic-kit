// Tiered conformance harness (ADR-0031 §2, §5) — generalizes the single
// admission-tier black-box report (tests/kit/adapter-conformance.test.mjs's
// runConformanceReport) into the five graduation tiers named there: admission,
// session-driving, activity-routing, primary-eligible, statusline. Each tier
// is a black-box check against a REAL installed adapter layout — real
// manifest, real admission, real subprocess hooks — no third-party code ever
// runs in-process, matching every other module under adapters/.
//
// Reuse, not reimplementation: this module composes the SAME library calls
// runConformanceReport uses (admitAdapters, applyAdmitted, effectiveHostRegistry,
// registerAdmittedLifecycle, registerAdmittedExecution, executeRunPlan) rather
// than importing that test file directly. A *.test.mjs module registers
// node:test hooks/tests as an IMPORT-TIME side effect (its own top-level
// `before`/`test` calls run the instant the module loads) — importing it from
// a CLI command would fire that TAP output on every `ak host adapters
// conformance` invocation and re-run its whole negative corpus for nothing
// this command needs. The admission tier below is a leaner subset of the same
// sequence (manifest validates -> admits -> joins the registry -> a declared
// detect hook runs as a real subprocess); the negative corpus and
// edit-invalidation checks stay owned by adapter-conformance.test.mjs, which
// exercises the admission GATE itself, not one adapter's conformance.
//
// Passing a tier RECORDS EVIDENCE (grants.mjs's recordTierResult/recordTierGate)
// — it never grants a capability. That stays the maintainer's explicit act
// (ADR-0031 §1), landing with the promotion command in a later wave.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateAdapterManifest } from './manifest.mjs';
import { admitAdapters, hashManifest } from './admission.mjs';
import {
  applyAdmitted, resetAdmitted, effectiveHostRegistry, admittedHostIds,
} from './admitted.mjs';
import {
  recordConsent, recordedHashFor as consentRecordedHashFor, isTrusted as consentIsTrusted,
} from './consent.mjs';
import { registerAdmittedLifecycle, resetAdmittedLifecycle } from './lifecycle-registry.mjs';
import { registerAdmittedExecution, resetAdmittedExecution } from '../execution/admitted.mjs';
import { executeRunPlan } from '../execution/runner.mjs';
import { have } from '../exec.mjs';
import {
  CONFORMANCE_TIERS, TIER_GRANTS, adapterGrantsPath, recordTierResult, recordTierGate, recordTierFailure,
  grantedCapabilitiesFor,
} from './grants.mjs';

export { CONFORMANCE_TIERS, TIER_GRANTS };

const nowIso = () => new Date().toISOString();

// A real adapter drives a real, often agentic, host (Wave adrianco#131: an
// open-ended probe like "conformance harness probe" reads as a TASK to an
// agentic CLI, which then goes and builds one — minutes of real work instead
// of a transport check). Directive and bounded so every tier's exercise
// tests wiring, not the model's ambition.
const CONFORMANCE_PROBE_PROMPT = 'Reply with exactly: OK';

/** admitAdapters' readManifest contract: `(source) => Promise<any>` — a real
 * resolve, matching admission.mjs's own default (dynamic import so this
 * module's own load stays cheap for callers that always inject a reader). */
async function defaultReadManifest(source) {
  const { resolveManifestSource } = await import('./sources.mjs');
  const { raw } = await resolveManifestSource(source);
  return raw;
}

/** The adapter's own directory, for the execution adapter's F-1 cwd-anchoring
 * (execution/admitted.mjs) — same derivation admission.mjs's own
 * baseDirForSource uses (not exported there, so mirrored here rather than
 * reaching into that module's private internals). A remote (npm/https)
 * source has no persistent local bundle: null, honestly, never a guessed cwd. */
function baseDirForSource(source) {
  if (typeof source !== 'string' || !source
    || source.startsWith('https://') || source.startsWith('http://') || source.startsWith('npm:')) {
    return null;
  }
  try {
    return path.dirname(fs.realpathSync(source));
  } catch {
    return null;
  }
}

async function runCheck(checks, name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail: typeof detail === 'string' ? detail : undefined });
  } catch (error) {
    checks.push({ name, ok: false, detail: error?.message ?? String(error) });
  }
}

function evidenceFromChecks(checks) {
  return checks.map((c) => c.detail).filter(Boolean).join('; ');
}

// ── admission tier ──────────────────────────────────────────────────────
// manifest validates -> admits through admitAdapters with a real on-disk
// consent record -> joins effectiveHostRegistry() -> a declared detect hook
// runs as a real subprocess and its JSON payload flows back (ADR-0031 §2's
// evidence shape for this tier, and the shipped ADR-0029 admission gate).
async function checkAdmission({
  name, source, readManifest, consentFile, baseDir,
}) {
  const checks = [];
  let manifest = null;
  let admittedResult = null;

  await runCheck(checks, 'manifest reads and validates', async () => {
    const raw = await readManifest(source);
    manifest = validateAdapterManifest(raw);
    return `host id '${manifest.host.id}', contract ${manifest.contract}`;
  });

  if (!manifest) return { checks, manifest: null, hash: null };

  const hash = hashManifest(manifest);
  const resolvedName = name ?? manifest.host.id;

  await runCheck(checks, 'admits through admitAdapters with a real on-disk consent record', async () => {
    recordConsent(resolvedName, hash, { file: consentFile });
    const results = await admitAdapters({
      cfg: { hostAdapters: [{ name: resolvedName, source }] },
      readManifest,
      consent: {
        recordedHashFor: (n) => consentRecordedHashFor(n, { file: consentFile }),
        isTrusted: (n, h) => consentIsTrusted(n, h, { file: consentFile }),
      },
    });
    admittedResult = results[0];
    if (!admittedResult?.admitted) throw new Error(admittedResult?.detail ?? `admission refused: ${admittedResult?.reason}`);
    return `admitted as '${admittedResult.entry.id}'`;
  });

  if (admittedResult?.admitted) {
    await runCheck(checks, "joins effectiveHostRegistry()", async () => {
      applyAdmitted([admittedResult]);
      if (!effectiveHostRegistry().some((host) => host.id === resolvedName)) throw new Error('not present in effectiveHostRegistry()');
      if (!admittedHostIds().includes(resolvedName)) throw new Error('not present in admittedHostIds()');
      return 'joined effectiveHostRegistry()';
    });
  }

  const detectHook = manifest.lifecycle?.detect?.hook;
  if (detectHook) {
    await runCheck(checks, 'declared detect hook runs as a real subprocess', async () => {
      // No runHook injection: exercises buildAdmittedLifecycleAdapter's real
      // default, a dynamic import of the real hook-runner.mjs — the whole
      // chain (derived adapter -> hook runner -> spawned process -> stdout
      // JSON) actually runs, not just wired (mirrors runConformanceReport).
      // F1 (Wave C security review): baseDir MUST be threaded through here —
      // with no baseDir, buildAdmittedLifecycleAdapter's own F-1 anchoring
      // check (lifecycle-registry.mjs) refuses ANY relative lifecycle hook
      // command outright (adapter.unanchoredVerbs), which would report every
      // realistically-authored file-sourced adapter — including the repo's
      // own acme fixture — as FAILED here for a reason that has nothing to
      // do with the adapter's actual conformance.
      const adapter = registerAdmittedLifecycle(manifest, { baseDir });
      const detected = await adapter.detect({});
      if (!detected || typeof detected !== 'object') throw new Error('detect hook returned no observation');
      if (detected.error) throw new Error(`detect hook reported an error: ${detected.error}`);
      return 'detect hook produced an observation';
    });
  } else {
    checks.push({ name: 'declared detect hook runs as a real subprocess', ok: true, detail: 'no detect hook declared — nothing to prove' });
  }

  return { checks, manifest, hash };
}

// ── session-driving tier ────────────────────────────────────────────────
// Gates canDriveSession. A manifest that never declares it has nothing to
// prove (skipped). A manifest that DOES declare it cannot be proven today:
// ak has no external session-driving execution path, and being a native
// ruflo backend is upstream-owned (ADR-0031 §4, grounded against
// ruvnet/ruflo@45e65b5's per-host ENABLE_* backend model, not an outside
// registration surface) — honestly 'gated', never faked. `upstreamRef`
// (caller-supplied, `<repo>#<NNN>` form) is ONLY set once a real tracking
// issue exists to file the backend-registration request against; omitted, the
// report still says 'gated' but carries no `gatedBy` to persist — there is
// nothing yet to pin a grants.mjs recordTierGate() call to.
function checkSessionDriving({ manifest, upstreamRef }) {
  if (!manifest) {
    return { status: 'skipped', checks: [{ name: 'admission prerequisite', ok: false, detail: 'admission tier did not pass — cannot evaluate' }] };
  }
  if (manifest.host?.capabilities?.canDriveSession !== true) {
    return {
      status: 'skipped',
      checks: [{ name: 'canDriveSession declared', ok: true, detail: 'not declared — nothing to prove' }],
    };
  }
  const detail = "ak has no external session-driving execution path yet — being a native ruflo backend is "
    + 'upstream-owned (ADR-0031 §4: ruvnet/ruflo\'s per-host ENABLE_* backend model, not an outside '
    + "registration surface); interim behaviour: the host runs through ak's own supervised execution, "
    + 'just not as a ruflo-native backend';
  return {
    status: 'gated',
    checks: [{ name: 'external session-driving execution path exists', ok: false, detail }],
    detail,
    ...(typeof upstreamRef === 'string' && upstreamRef ? { gatedBy: upstreamRef } : {}),
  };
}

// ── activity-routing tier ───────────────────────────────────────────────
// Gates canRouteActivities. Requires an execution.run hook. Admits, derives
// the real execution adapter, and drives a real one-worker executeRunPlan
// routed to the host — asserting a succeeded WorkerResult under the runner's
// contract (ADR-0018). This is the tier P2 (execution/admitted.mjs) makes
// real, so it is the one tier expected to genuinely PASS against a conforming
// fixture today.
async function checkActivityRouting({
  manifest, name, baseDir, haveFn, clock, cwd, timeoutMs,
}) {
  if (!manifest) {
    return { status: 'skipped', checks: [{ name: 'admission prerequisite', ok: false, detail: 'admission tier did not pass — cannot evaluate' }] };
  }
  const canRoute = manifest.host?.capabilities?.canRouteActivities === true;
  const hasHook = !!manifest.execution?.run?.hook;
  if (!canRoute || !hasHook) {
    return {
      status: 'skipped',
      checks: [{ name: 'canRouteActivities + execution.run.hook declared', ok: true, detail: 'not declared — nothing to prove' }],
    };
  }

  const checks = [];
  let succeeded = null;

  await runCheck(checks, 'registerAdmittedExecution derives and registers a real execution adapter', async () => {
    resetAdmittedExecution();
    registerAdmittedExecution(manifest, { haveFn, baseDir });
    return `registered for '${name}'`;
  });

  await runCheck(checks, "a real one-worker executeRunPlan routed to the host returns a succeeded WorkerResult (ADR-0018)", async () => {
    // No runHook injection: exercises executeRunPlan's default adapter lookup
    // (executionAdapterFor -> admittedExecutionAdapterFor) end-to-end, same
    // discipline as runConformanceReport's P2 check — a genuine spawned
    // subprocess, not a stub.
    const plan = {
      workers: [{
        id: 'conformance-w1', activity: 'implementation', role: 'coder', host: name, prompt: CONFORMANCE_PROBE_PROMPT,
      }],
    };
    const [result] = await executeRunPlan(plan, { clock, cwd, timeoutMs });
    if (result.status !== 'succeeded') throw new Error(result.failure?.reason ?? `expected a succeeded WorkerResult, got '${result.status}'`);
    succeeded = result;
    return `worker '${result.workerId}' succeeded via host '${result.host}' (exitCategory=${result.exitCategory})`;
  });

  resetAdmittedExecution();

  const status = checks.every((c) => c.ok) ? 'passed' : 'failed';
  return {
    status,
    checks,
    ...(succeeded ? { evidence: `worker succeeded via host '${succeeded.host}', exitCategory=${succeeded.exitCategory}, provider=${succeeded.provider ?? 'unknown'}` } : {}),
  };
}

// ── primary-eligible tier: real exercise (ADR-0031 §2, ADR-0019) ───────────
// The chicken-and-egg this tier exists to break: earning canBePrimary needs
// evidence of leading a run and receiving an escalation, but ak's real
// primary-host machinery (routing.mjs) only ever selects a host that has
// ALREADY got canBePrimary — proving it through that live path would need
// the grant this tier exists to justify. The harness sidesteps that by
// building the lead/escalation plan directly in its OWN sandbox and driving
// it through the real executeRunPlan (ADR-0018/0019) — genuine subprocess
// behaviour, not the live primary-host registry.
//
// F-1 (security review, HIGH, fixed): this exercise runs UNCONDITIONALLY —
// never gated on an existing canBePrimary grant. ADR-0031 §2's own sequence
// is evidence FIRST, grant SECOND ("passing a tier records evidence; the
// maintainer's grant turns evidence into capability"): grantCapability
// (grants.mjs) refuses unless a 'passed' primary-eligible tier is ALREADY
// recorded at this hash, so gating the exercise on the grant it is meant to
// justify is a deadlock — the only way out would be hand-seeding a 'passed'
// tier before ever running the exercise, which defeats the entire earned-
// evidence point. checkPrimaryEligible below records 'passed' straight off a
// genuine exercise result; a maintainer's subsequent `ak host adapters grant
// <name> canBePrimary` is the ONLY thing that turns that recorded evidence
// into a live capability via the keystone overlay (admitted.mjs) — that
// separation, not a pre-exercise grant check, is what ADR-0031 §1 actually
// asks for. (The grant check this replaced existed to stop a caller-supplied
// exercise result from being self-evidence — moot now: there is no
// caller-injectable exercise at all, see below.)
//
// Two things the exercise proves, and what it does NOT claim (F-7):
// - A direct, non-escalated worker completes on the admitted host — the same
//   worker-execution path activity-routing already proved, run again here as
//   this tier's own independent evidence.
// - A SEPARATE worker starts on a host id this harness invents on the spot —
//   never a built-in, never admitted, never registered in ANY adapter
//   overlay — which the real runner genuinely cannot route: a real
//   `cli_unavailable` WorkerResult, not a fabricated one (no hook trickery,
//   no fixture changes needed: the failure is architectural — no adapter
//   exists for that host id at all). That worker's one-rung escalation
//   ladder points at the admitted host, so a real escalatable failure
//   (runner.mjs's ESCALATABLE_STATUSES/BLOCKING_CATEGORIES) genuinely
//   advances onto it (ADR-0019) — the `attempts` trail proves more than one
//   attempt ran and the admitted host is the LAST rung, succeeded.
// Both completions are the SAME execution.run hook exiting 0 twice, driven
// through the real derived execution adapter — this demonstrates the
// escalation ladder and execution-adapter contract plumbing over an
// already-proven activity-routing path. It is NOT evidence the host can
// "lead agentic work" in any qualitative sense — the evidence string below
// is worded to that precision, not more.
//
// This needs the host's activity-routing to actually work (it runs real
// workers through the same derived execution adapter), so this tier depends
// on activity-routing genuinely passing THIS run — enforced by the caller
// (runTieredConformance) before this function is ever reached.
//
// No caller-injectable seam: unlike the placeholder this replaces, there is
// no `exercisePrimaryEligible` option anymore — the ONLY exercise that can
// ever run is this real one, so a caller cannot launder a fabricated
// {ok:true} into a pass (Wave C's off-the-CLI constraint, hardened: not just
// unreachable from the CLI, structurally unreachable from ANY caller).
const PRIMARY_ELIGIBLE_UNROUTED_HOST_SUFFIX = 'conformance-unrouted-rung';

async function runPrimaryEligibleExercise({
  manifest, name, baseDir, haveFn, clock, cwd, timeoutMs,
}) {
  const unroutedHost = `${PRIMARY_ELIGIBLE_UNROUTED_HOST_SUFFIX}-${name}`;
  resetAdmittedExecution();
  try {
    registerAdmittedExecution(manifest, { haveFn, baseDir });
    const plan = {
      workers: [
        {
          id: 'primary-eligible-direct', activity: 'implementation', role: 'coder', host: name,
          prompt: CONFORMANCE_PROBE_PROMPT,
        },
        {
          id: 'primary-eligible-escalation', activity: 'implementation', role: 'coder', host: unroutedHost,
          prompt: CONFORMANCE_PROBE_PROMPT,
          escalate: [{ host: name, model: null }],
        },
      ],
    };
    const [direct, escalation] = await executeRunPlan(plan, {
      clock, escalate: true, cwd, timeoutMs,
    });

    if (direct?.status !== 'succeeded' || direct.host !== name) {
      return { ok: false, detail: `direct (non-escalated) worker did not complete via '${name}' (status=${direct?.status})` };
    }
    const attempts = escalation?.attempts ?? [];
    const lastAttempt = attempts[attempts.length - 1];
    const genuinelyEscalated = attempts.length > 1
      && lastAttempt?.host === name && lastAttempt?.status === 'succeeded'
      && attempts.slice(0, -1).every((a) => a.host !== name);
    if (escalation?.status !== 'succeeded' || escalation.host !== name || !genuinelyEscalated) {
      return {
        ok: false,
        detail: `escalation worker did not genuinely advance onto '${name}' via ADR-0019 (status=${escalation?.status}, attempts=${attempts.length})`,
      };
    }
    return {
      ok: true,
      detail: `'${name}' completed a direct (non-escalated) run to a succeeded result, and separately received a `
        + `genuine ADR-0019 escalation onto itself after an unrouted host's real cli_unavailable failure `
        + `(${attempts.length} attempts: ${attempts.map((a) => `${a.host}=${a.status}`).join(' -> ')}) — both runs `
        + "completed via the adapter's real execution.run hook (escalation-ladder and execution-contract plumbing "
        + 'over the already-proven activity-routing path, not a claim about agentic task quality)',
    };
  } catch (error) {
    return { ok: false, detail: `primary-eligible exercise threw: ${error?.message ?? String(error)}` };
  } finally {
    resetAdmittedExecution();
  }
}

/**
 * primary-eligible's own check (ADR-0031 §2, ADR-0019) — deliberately NOT
 * checkGrantGatedTier: F-1 (security review) found that gating this
 * exercise on an EXISTING canBePrimary grant deadlocks against
 * grantCapability's own requirement of an already-'passed' tier. This runs
 * the real exercise unconditionally (once admission and activity-routing
 * have genuinely passed) and reports 'passed' straight off a genuine result
 * — recordTierResult (the caller's shared persist step) writes that evidence
 * regardless of whether anything is granted yet, which is precisely what
 * lets a maintainer's later grantCapability succeed at all.
 */
async function checkPrimaryEligible({
  manifest, name, baseDir, haveFn, clock, cwd, timeoutMs,
}) {
  const exerciseLabel = 'leads a run and receives an escalation (ADR-0019)';
  const outcome = await runPrimaryEligibleExercise({
    manifest, name, baseDir, haveFn, clock, cwd, timeoutMs,
  });
  if (outcome.ok) {
    return { status: 'passed', checks: [{ name: exerciseLabel, ok: true, detail: outcome.detail }], evidence: outcome.detail };
  }
  return { status: 'failed', checks: [{ name: exerciseLabel, ok: false, detail: outcome.detail }] };
}

// ── statusline tier ─────────────────────────────────────────────────────
// Gates a capability the manifest can NEVER declare (commandStatusline is
// inexpressible in the schema — ADR-0029/0031). Cannot be exercised
// end-to-end today: there is no admitted-host statusline footer-render path
// anywhere in src/ yet (grep-verified against this wave) — so even a granted
// capability has nothing real to drive through. `exercise` is the injection
// point for the day that path lands: the honest default reports 'gated'
// rather than fabricate a pass, per ADR-0031's "do not fake a pass"
// discipline. Ungranted is reported 'gated' too (an ak-local wait on the
// maintainer's promotion-command grant, Wave D — never an upstream ceiling,
// so it is never persisted via grants.mjs's recordTierGate, which is
// reserved for genuinely upstream gates).
async function checkGrantGatedTier({
  capability, manifest, name, hash, grantsFile, exercise, exerciseLabel,
}) {
  if (!manifest) {
    return { status: 'skipped', checks: [{ name: 'admission prerequisite', ok: false, detail: 'admission tier did not pass — cannot evaluate' }] };
  }
  const granted = grantedCapabilitiesFor(name, hash, { file: grantsFile })[capability] === true;
  if (!granted) {
    const detail = `no '${capability}' grant recorded at this manifest hash — conferred only by an explicit `
      + 'maintainer grant on top of passed conformance evidence (ADR-0031 §1), via the promotion command';
    return {
      status: 'gated',
      checks: [{ name: `${capability} granted`, ok: false, detail }],
      detail: `ak-local: awaiting maintainer grant for '${capability}' (not an upstream ceiling)`,
    };
  }

  const outcome = exercise
    ? await exercise({ manifest, name, hash })
    : { ok: false, detail: `${exerciseLabel} — no runtime path built yet` };

  if (outcome?.ok) {
    const detail = typeof outcome.detail === 'string' ? outcome.detail : exerciseLabel;
    return { status: 'passed', checks: [{ name: exerciseLabel, ok: true, detail }], evidence: detail };
  }
  return {
    status: 'gated',
    checks: [{ name: exerciseLabel, ok: false, detail: outcome?.detail ?? `${exerciseLabel} — no runtime path built yet` }],
    detail: `ak-local: '${capability}' is granted, but the runtime path to exercise it is not built yet`,
  };
}

/**
 * Run the ADR-0031 §2 tiered conformance sequence against one adapter
 * manifest and return a structured, per-tier report. Self-contained: builds
 * its own temp consent store (unless `consentFile` is supplied) and cleans
 * it up, resets the admitted/execution overlays on the way out, and is safe
 * to call more than once in the same process — same discipline as
 * runConformanceReport (tests/kit/adapter-conformance.test.mjs).
 *
 * Recording (grants.mjs): a 'passed' tier is recorded via recordTierResult;
 * a 'gated' tier carrying a `gatedBy` upstream ref (only ever session-driving,
 * and only when the caller supplies one — see checkSessionDriving) is
 * recorded via recordTierGate, which also VOIDS a live capability the tier
 * used to back at this same hash. A genuinely 'failed' grant-bearing tier
 * (one of TIER_GRANTS' keys) is recorded via recordTierFailure — the un-earn
 * path: a re-run that fails at the SAME hash a capability was earned at
 * voids that capability too, mirroring the 'gated' downgrade (N-1,
 * security-review follow-up). A 'skipped' result records nothing, even for a
 * grant-bearing tier — the tier was never actually evaluated this run (e.g.
 * its own prerequisite didn't pass), which is ambiguous, not a disproof, so
 * it must never void a live capability. 'gated' tiers with no upstream ref
 * also record nothing — there is nothing new to persist.
 * `grantsFile` defaults to the REAL adapter-grants.json (matching grants.mjs's
 * own default-to-real-config-path convention) — callers that don't want a
 * conformance run to touch the real store (tests, dry runs) must pass an
 * explicit path. Pass `persist: false` to skip recording altogether.
 *
 * activity-routing and primary-eligible drive a REAL worker through the
 * adapter's execution.run hook (adrianco#131): `timeoutMs` explicitly
 * overrides the outer budget; omitted, the manifest's own declared
 * `execution.run.hook.timeoutMs` is honored instead of the runner's 120s
 * default, so a manifest that already declares a longer budget just works
 * (the hook-level `resolveTimeout` still takes the tighter of the two, so
 * this can only raise the ceiling, never bypass a SHORTER hook-declared one).
 * `cwd` defaults to a throwaway temp directory (cleaned up on return) rather
 * than the operator's `process.cwd()` — an auto-approving agentic worker has
 * no business landing in whatever directory the operator happened to run
 * `ak host adapters conformance` from.
 *
 * primary-eligible has no caller-injectable exercise (unlike statusline,
 * still a placeholder this wave): it always runs runPrimaryEligibleExercise,
 * a real escalation-plus-direct-run probe driven through executeRunPlan
 * (ADR-0018/0019), UNCONDITIONALLY — never gated on an existing canBePrimary
 * grant (F-1, security review: gating the exercise on the grant it exists to
 * justify is a deadlock against grantCapability's own "already passed"
 * requirement). It depends on activity-routing genuinely passing in THIS run
 * (computed regardless of whether 'activity-routing' is in `tiers`) —
 * 'skipped' with "activity-routing did not pass" otherwise, mirroring the
 * admission short-circuit above it. A genuine pass is recorded via
 * recordTierResult like any other tier; a maintainer's subsequent
 * grantCapability call is what turns that evidence into a live capability.
 *
 * @param {{
 *   fixtureRoot?: string, manifestSource?: string, name?: string,
 *   tiers?: readonly string[], readManifest?: (source: string) => Promise<any>,
 *   consentFile?: string, grantsFile?: string, persist?: boolean,
 *   haveFn?: (cmd: string, opts?: any) => Promise<boolean>, baseDir?: string|null,
 *   sessionDrivingUpstreamRef?: string,
 *   exerciseStatusline?: (ctx: {manifest:any,name:string,hash:string}) => Promise<{ok:boolean,detail?:string}>,
 *   clock?: () => string, timeoutMs?: number, cwd?: string,
 * }} [options]
 * @returns {Promise<{ name: string, hash: string|null,
 *   tiers: Array<{ tier: string, status: 'passed'|'failed'|'gated'|'skipped',
 *     checks: Array<{name:string, ok:boolean, detail?:string}>,
 *     detail?: string, gatedBy?: string, evidence?: string, recordError?: string }> }>}
 */
export async function runTieredConformance({
  fixtureRoot,
  manifestSource = fixtureRoot ? path.join(fixtureRoot, 'manifest.json') : undefined,
  name,
  tiers = CONFORMANCE_TIERS,
  readManifest = defaultReadManifest,
  consentFile,
  grantsFile = adapterGrantsPath(),
  persist = true,
  haveFn = have,
  baseDir,
  sessionDrivingUpstreamRef,
  exerciseStatusline,
  clock = nowIso,
  timeoutMs,
  cwd,
} = {}) {
  if (typeof manifestSource !== 'string' || !manifestSource) {
    throw new TypeError('runTieredConformance requires fixtureRoot or manifestSource');
  }

  let tempDir = null;
  let consentFileUsed = consentFile;
  if (!consentFileUsed) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-conformance-tiers-'));
    consentFileUsed = path.join(tempDir, 'adapter-consent.json');
  }

  // adrianco#131 #2: a live, often auto-approving worker must never land in
  // the operator's own $PWD by accident — a throwaway scratch directory,
  // never process.cwd(), unless a caller (tests) supplies its own.
  let workerCwdTempDir = null;
  let workerCwd = cwd;
  if (!workerCwd) {
    workerCwdTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-conformance-cwd-'));
    workerCwd = workerCwdTempDir;
  }

  try {
    // F1 (Wave C): baseDir is computed BEFORE checkAdmission so it can thread
    // straight into registerAdmittedLifecycle for the detect-hook check —
    // the same anchoring the execution tier already needed, just derived
    // earlier now that admission needs it too.
    const derivedBaseDir = baseDir !== undefined ? baseDir : baseDirForSource(manifestSource);
    const admission = await checkAdmission({
      name, source: manifestSource, readManifest, consentFile: consentFileUsed, baseDir: derivedBaseDir,
    });
    const resolvedName = name ?? admission.manifest?.host?.id ?? '(unknown)';
    const { hash } = admission;
    // F2 (Wave C, BLOCKER): every post-admission tier gated on manifest
    // validity alone (`admission.manifest != null`) would still exercise a
    // manifest that schema-validated but whose REAL admission (admitAdapters
    // — the consent/contract/builtin-shadow gate) was refused: e.g. stale or
    // missing consent. That let a refused adapter's execution.run hook be
    // spawned for real and its result recorded 'passed' into grantsFile
    // (which defaults to the operator's REAL adapter-grants.json). Gating on
    // the WHOLE admission tier passing — not just the manifest parsing —
    // closes that: a manifest whose admission failed is treated identically
    // to one that never validated at all, for every downstream tier.
    const admissionPassed = admission.checks.length > 0 && admission.checks.every((c) => c.ok);
    const effectiveManifest = admissionPassed ? admission.manifest : null;
    const wantTier = (tier) => tiers.includes(tier);

    // adrianco#131 #1: an explicit override always wins; otherwise honor the
    // manifest's own declared execution.run.hook.timeoutMs (if any) as the
    // OUTER runner budget too, so a manifest that already declares a longer
    // one (e.g. a local-model host) isn't silently capped at the runner's
    // 120s default before the hook's own tighter-of-the-two ever applies.
    const effectiveTimeoutMs = timeoutMs !== undefined
      ? timeoutMs
      : effectiveManifest?.execution?.run?.hook?.timeoutMs;

    const tierResults = [];

    if (wantTier('admission')) {
      tierResults.push({
        tier: 'admission',
        status: admissionPassed ? 'passed' : 'failed',
        checks: admission.checks,
      });
    }

    if (wantTier('session-driving')) {
      tierResults.push({ tier: 'session-driving', ...checkSessionDriving({ manifest: effectiveManifest, upstreamRef: sessionDrivingUpstreamRef }) });
    }

    // primary-eligible's real exercise runs actual workers through the
    // admitted host's derived execution adapter, so it needs activity-routing
    // to have genuinely passed THIS run — not merely to have been requested.
    // Computed here, once, whenever either tier needs it, so a caller asking
    // for `tiers: ['primary-eligible']` alone still gets the real dependency
    // check rather than an unconditioned pass/skip.
    let activityRoutingResult = null;
    if (wantTier('activity-routing') || wantTier('primary-eligible')) {
      activityRoutingResult = await checkActivityRouting({
        manifest: effectiveManifest, name: resolvedName, baseDir: derivedBaseDir, haveFn, clock,
        cwd: workerCwd, timeoutMs: effectiveTimeoutMs,
      });
      if (wantTier('activity-routing')) {
        tierResults.push({ tier: 'activity-routing', ...activityRoutingResult });
      }
    }

    if (wantTier('primary-eligible')) {
      // F-1 (security review): NOT checkGrantGatedTier — that gates the
      // exercise on an already-existing canBePrimary grant, which deadlocks
      // against grantCapability's own requirement of an already-'passed'
      // tier (see checkPrimaryEligible's header comment). checkPrimaryEligible
      // runs the real exercise unconditionally once its own prerequisites
      // (admission, activity-routing) are met — evidence first, grant second,
      // per ADR-0031 §1/§2.
      let result;
      if (!effectiveManifest) {
        result = { status: 'skipped', checks: [{ name: 'admission prerequisite', ok: false, detail: 'admission tier did not pass — cannot evaluate' }] };
      } else if (activityRoutingResult?.status !== 'passed') {
        // Mirrors the admission short-circuit above: when admission passed
        // but activity-routing (this tier's own real prerequisite) did not,
        // report the SAME 'skipped' shape with a distinct reason, rather
        // than attempting an exercise the host cannot actually support yet.
        result = {
          status: 'skipped',
          checks: [{ name: 'activity-routing prerequisite', ok: false, detail: 'activity-routing did not pass — cannot evaluate' }],
        };
      } else {
        result = await checkPrimaryEligible({
          manifest: effectiveManifest, name: resolvedName, baseDir: derivedBaseDir, haveFn, clock,
          cwd: workerCwd, timeoutMs: effectiveTimeoutMs,
        });
      }
      tierResults.push({ tier: 'primary-eligible', ...result });
    }

    if (wantTier('statusline')) {
      const result = await checkGrantGatedTier({
        capability: 'commandStatusline',
        manifest: effectiveManifest,
        name: resolvedName,
        hash,
        grantsFile,
        exercise: exerciseStatusline,
        exerciseLabel: 'renders and refreshes a command-backed footer',
      });
      tierResults.push({ tier: 'statusline', ...result });
    }

    if (persist && hash) {
      for (const tierResult of tierResults) {
        try {
          if (tierResult.status === 'passed') {
            const evidence = tierResult.evidence ?? evidenceFromChecks(tierResult.checks) ?? tierResult.tier;
            recordTierResult(resolvedName, tierResult.tier, { hash, evidence: evidence || tierResult.tier }, { file: grantsFile });
          } else if (tierResult.status === 'gated' && tierResult.gatedBy) {
            recordTierGate(resolvedName, tierResult.tier, { hash, gatedBy: tierResult.gatedBy }, { file: grantsFile });
          } else if (tierResult.status === 'failed' && Object.hasOwn(TIER_GRANTS, tierResult.tier)) {
            // N-1 (security-review follow-up): a grant-bearing tier that
            // RE-RUNS 'failed' at the SAME (unchanged) hash means evidence a
            // live capability rests on was just shown non-reproducible — void
            // the stored tier and the capability together (grants.mjs's
            // recordTierFailure), mirroring recordTierGate's downgrade for
            // 'gated' immediately above. Deliberately NOT triggered by
            // 'skipped': a skipped tier (e.g. primary-eligible
            // short-circuiting because its own prerequisite — activity-
            // routing — didn't run/pass THIS run) means the tier was never
            // actually EVALUATED this run, which is ambiguous, not disproven
            // — downgrading on an ambiguous non-evaluation would void a live
            // capability on evidence that says nothing about whether it
            // still holds.
            recordTierFailure(resolvedName, tierResult.tier, { hash }, { file: grantsFile });
          }
        } catch (error) {
          tierResult.recordError = error?.message ?? String(error);
        }
      }
    }

    return { name: resolvedName, hash, tiers: tierResults };
  } finally {
    // F7 (Wave C security review): all THREE overlays a conformance run can
    // touch — the host overlay, the execution overlay, and the lifecycle
    // registration checkAdmission's detect-hook check creates via
    // registerAdmittedLifecycle — must reset together. Resetting only the
    // first two (as before) left an already-registered lifecycle adapter
    // live for a host id this run's own admission may have just refused,
    // the same live-edge class F-9 (execution/admitted.mjs's
    // resetAllAdmitted) already closed for the other two overlays.
    resetAdmitted();
    resetAdmittedExecution();
    resetAdmittedLifecycle();
    if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
    if (workerCwdTempDir) { try { fs.rmSync(workerCwdTempDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
  }
}
