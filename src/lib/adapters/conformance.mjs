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
  CONFORMANCE_TIERS, TIER_GRANTS, adapterGrantsPath, recordTierResult, recordTierGate, grantedCapabilitiesFor,
} from './grants.mjs';

export { CONFORMANCE_TIERS, TIER_GRANTS };

const nowIso = () => new Date().toISOString();

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
  manifest, name, baseDir, haveFn, clock,
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
        id: 'conformance-w1', activity: 'implementation', role: 'coder', host: name, prompt: 'conformance harness probe',
      }],
    };
    const [result] = await executeRunPlan(plan, { clock });
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

// ── primary-eligible / statusline tiers ─────────────────────────────────
// Both gate a capability the manifest can NEVER declare (canBePrimary,
// commandStatusline are inexpressible in the schema — ADR-0029/0031). Neither
// can be exercised end-to-end today: there is no lead-a-run/receive-an-
// escalation runtime path (ADR-0019) and no admitted-host statusline
// footer-render path anywhere in src/ yet (grep-verified against this wave) —
// so even a granted capability has nothing real to drive through. `exercise`
// is the injection point for the day one of those paths lands: the honest
// default reports 'gated' rather than fabricate a pass, per ADR-0031's "do
// not fake a pass" discipline. Ungranted is reported 'gated' too (an
// ak-local wait on the maintainer's promotion-command grant, Wave D — never
// an upstream ceiling, so it is never persisted via grants.mjs's
// recordTierGate, which is reserved for genuinely upstream gates).
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
 * recorded via recordTierGate. 'skipped'/'failed' tiers, and 'gated' tiers
 * with no upstream ref, record nothing — there is nothing new to persist.
 * `grantsFile` defaults to the REAL adapter-grants.json (matching grants.mjs's
 * own default-to-real-config-path convention) — callers that don't want a
 * conformance run to touch the real store (tests, dry runs) must pass an
 * explicit path. Pass `persist: false` to skip recording altogether.
 *
 * @param {{
 *   fixtureRoot?: string, manifestSource?: string, name?: string,
 *   tiers?: readonly string[], readManifest?: (source: string) => Promise<any>,
 *   consentFile?: string, grantsFile?: string, persist?: boolean,
 *   haveFn?: (cmd: string, opts?: any) => Promise<boolean>, baseDir?: string|null,
 *   sessionDrivingUpstreamRef?: string,
 *   exercisePrimaryEligible?: (ctx: {manifest:any,name:string,hash:string}) => Promise<{ok:boolean,detail?:string}>,
 *   exerciseStatusline?: (ctx: {manifest:any,name:string,hash:string}) => Promise<{ok:boolean,detail?:string}>,
 *   clock?: () => string,
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
  exercisePrimaryEligible,
  exerciseStatusline,
  clock = nowIso,
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

    if (wantTier('activity-routing')) {
      const result = await checkActivityRouting({
        manifest: effectiveManifest, name: resolvedName, baseDir: derivedBaseDir, haveFn, clock,
      });
      tierResults.push({ tier: 'activity-routing', ...result });
    }

    if (wantTier('primary-eligible')) {
      const result = await checkGrantGatedTier({
        capability: 'canBePrimary',
        manifest: effectiveManifest,
        name: resolvedName,
        hash,
        grantsFile,
        exercise: exercisePrimaryEligible,
        exerciseLabel: 'leads a run and receives an escalation (ADR-0019)',
      });
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
  }
}
