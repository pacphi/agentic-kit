// x host adapters grant/gate/status/revoke-grant — the maintainer's P5
// promotion CLI (ADR-0031 §1, §2, §3) and the P7 upstream-gate CLI (§4).
// Split out of host-adapters.mjs (which keeps list/trust/revoke/conformance)
// purely to stay under the house 500-line-per-file budget; both files are
// one logical surface dispatched from the same `run()` in host-adapters.mjs.
//
// Nothing here loads third-party code. grant/gate/status call grants.mjs, a
// pure data layer over a hash-pinned JSON store (adapter-grants.json).
// grantCapability there REFUSES unless the gating tier is already recorded
// 'passed' at the exact current manifest hash: a capability is conferred by
// already-recorded evidence plus this explicit maintainer act, never by the
// CLI itself exercising a path (a caller-supplied exercise result would be
// both the pass and its own evidence) — so no subcommand here accepts or
// forwards any 'exercise'/callback option.
import {
  CONFORMANCE_TIERS, TIER_GRANTS, recordTierGate, grantCapability, revokeGrants,
  grantsFor, grantedCapabilitiesFor, gatedTiersFor,
} from '../../lib/adapters/grants.mjs';
import { ok, warn, fail, info, bold } from '../../lib/output.mjs';
import {
  findEntry, loadAndHash, stripControl, hookCommandsFor,
} from './host-adapters.mjs';

// ── grant (P5 promotion command; alias `bless`) ─────────────────────────
// The maintainer's explicit act that turns already-recorded conformance
// evidence into a live capability (ADR-0031 §1). This blesses an EXTERNAL
// adapter's grant (§3's "Blessed external adapter" — hence the `bless`
// alias), not a built-in promotion — promoting to a built-in is a manual
// registry PR (§3), not this command.

/** TIER_GRANTS' values are the only capabilities `ak` can ever grant —
 * critically this excludes 'aqeProvider', an upstream-owned enumeration
 * (ADR-0031 §4) that must never appear grantable here. */
function grantableCapability(capability) {
  return Object.values(TIER_GRANTS).includes(capability);
}

function gatingTierFor(capability) {
  return Object.entries(TIER_GRANTS).find(([, cap]) => cap === capability)?.[0];
}

/** F-2 (security re-review, HIGH): what a grant of `capability` ACTUALLY
 * does today — precisely bounded, not overclaimed and not underclaimed. The
 * D2 keystone (admission.mjs) makes grantedCapabilitiesFor overlay into
 * effectiveHostRegistry() on every AK_EXPERIMENTAL_HOST_ADAPTERS=1
 * invocation, so a granted canBePrimary is genuinely live from the next
 * invocation: hostTierLabel() shows 'drives sessions · can lead' and the
 * host joins effectivePrimaryHostIds(). What is still deferred: no
 * production path SELECTS an external host as primary today (`ak host pick
 * --primary-host` only accepts claude|codex — built-in-scoped), so a
 * granted canBePrimary is visible/eligible but not yet auto-consumed.
 * commandStatusline reaches the same overlay but has NO runtime reader
 * anywhere in src/ (grep-verified) — its statusline render path is a later
 * wave, so it is currently inert. F-5: this is also the one-sentence
 * distinction between the two grantable caps the disclosure owes the
 * maintainer, so both call sites (pre-confirm disclosure, post-grant
 * success) share this single source of truth rather than drifting. */
function capabilityStatusNote(capability) {
  return capability === 'canBePrimary'
    ? "canBePrimary is live: from the next ak invocation this host's tier label shows 'can lead' and it joins effectivePrimaryHostIds() — but no production path yet SELECTS an external host as primary ('ak host pick' stays built-in-scoped), so this is visible/eligible, not yet auto-consumed."
    : 'commandStatusline is currently inert: it reaches the effective host registry, but no runtime path reads it anywhere yet — the statusline render path is a later wave.';
}

export async function grant({
  name, capability, cfg, consent, reader, ask, isTTY, yes, grantsFile,
}) {
  if (typeof name !== 'string' || !name || typeof capability !== 'string' || !capability) {
    fail('usage: ak host adapters grant <name> <capability>');
    return 2;
  }
  const safeCapability = stripControl(capability);
  if (!grantableCapability(capability)) {
    fail(`'${safeCapability}' is not a grantable capability — ak can only grant ${Object.values(TIER_GRANTS).join(', ')}. 'aqeProvider' in particular is an upstream-owned identity (agentic-qe's own provider enumeration) and is never ak-grantable — see ADR-0031 §4.`);
    return 1;
  }
  const safeName = stripControl(name);
  const entry = findEntry(cfg, name);
  if (!entry) { fail(`no host adapter named '${safeName}' in kit.json hostAdapters`); return 1; }

  const loaded = await loadAndHash(entry, { reader });
  if (!loaded.ok) {
    fail(`'${safeName}' manifest refused: ${stripControl(loaded.reason)} — ${stripControl(loaded.detail)}`);
    return 1;
  }
  const { manifest, hash } = loaded;
  const tier = gatingTierFor(capability);
  const safeTier = stripControl(tier);

  // F-3 (security review): this is the highest-privilege act in the model —
  // a hex hash alone told the operator nothing about what they were actually
  // converting to a live capability. Disclose the ACTUAL evidence backing
  // the gating tier, the manifest's declared hooks, and the manifest's trust
  // state, all BEFORE the confirmation prompt.
  const record = grantsFor(name, { file: grantsFile, currentHash: hash });
  const tierEntry = record?.tiers?.[tier];
  const evidence = tierEntry?.status === 'passed' ? tierEntry.evidence : undefined;

  console.log(bold(`grant '${safeCapability}' to '${safeName}'`));
  console.log(`  gating tier:   ${safeTier}`);
  console.log(`  manifest hash: ${hash}`);
  console.log(`  tier evidence: ${evidence ? stripControl(evidence) : '(no passed-tier evidence recorded at this hash — the grant below will be refused)'}`);
  const hooks = hookCommandsFor(manifest);
  console.log(`  manifest hooks:${hooks.length ? '' : ' (none)'}`);
  for (const line of hooks) console.log(`    ${stripControl(line)}`);
  // N-1 (security re-review): derive trust state from the hash this call
  // ALREADY resolved above — never re-resolve the manifest source (stateFor
  // would call loadAndHash a second time). On a mutable remote source
  // (https:/npm:) a second resolve can return different bytes than the
  // first, which would (a) disclose a trust state describing content that
  // isn't what's actually being granted, and (b) double the fetch cost (an
  // npm: source runs `npm pack` twice). Same three-state logic as stateFor,
  // just computed from data already in hand.
  let trustState;
  try {
    const recordedHash = consent.recordedHashFor(name);
    if (recordedHash === null || recordedHash === undefined) trustState = 'not consented';
    else trustState = recordedHash === hash ? 'trusted' : 'consent-stale';
  } catch (error) {
    trustState = `manifest error (consent-error: ${error?.message ?? String(error)})`;
  }
  console.log(`  manifest trust state: ${trustState}`);
  info('this grant pins the MANIFEST content (its hash), not the hook script bytes it references — see ADR-0031 §2 for that boundary.');
  info("granting a capability is a trust act, same posture as 'trust': it takes effect in the effective host registry from the next ak invocation.");
  info(capabilityStatusNote(capability));

  if (!yes) {
    if (!isTTY) {
      fail('grant needs confirmation — re-run with --yes after reviewing the summary above (non-interactive session)');
      return 2;
    }
    const confirmed = await ask(`Grant '${safeCapability}' to '${safeName}' at this manifest content? [y/N] `);
    if (!confirmed) { info(`grant for '${safeName}' left unchanged`); return 0; }
  }

  try {
    grantCapability(name, capability, { hash }, { file: grantsFile });
  } catch (error) {
    fail(`grant refused: ${stripControl(error?.message ?? String(error))} — earn it first with \`ak host adapters conformance ${safeName}\` (needs a passed '${safeTier}' tier at this exact manifest hash)`);
    return 1;
  }

  ok(`granted '${safeCapability}' to '${safeName}' at ${hash}`);
  info('an edit to the manifest voids this grant until the tier is re-earned and re-granted');
  // F-2 (security re-review, HIGH — corrects the prior F-7 wording, which
  // was accurate when written but was made FALSE by the D2 keystone
  // (admission.mjs) that landed since: grantedCapabilitiesFor is now read on
  // every flagged ak invocation and overlaid into effectiveHostRegistry(),
  // so a granted capability is NOT inert in general — see
  // capabilityStatusNote's header comment for exactly what is and isn't
  // live yet, per capability.
  info("this grant takes effect from the next ak invocation (with AK_EXPERIMENTAL_HOST_ADAPTERS=1 set): it is reflected in the effective host registry and this host's tier label.");
  info(capabilityStatusNote(capability));
  return 0;
}

// ── gate (P7): record an upstream capability request ────────────────────

export async function gate({
  name, tier, ref, cfg, reader, grantsFile,
}) {
  if (typeof name !== 'string' || !name || typeof tier !== 'string' || !tier || typeof ref !== 'string' || !ref) {
    fail('usage: ak host adapters gate <name> <tier> <ref>');
    return 2;
  }
  const safeName = stripControl(name);
  const safeTier = stripControl(tier);
  if (!CONFORMANCE_TIERS.includes(tier)) {
    fail(`'${safeTier}' is not a valid conformance tier (one of ${CONFORMANCE_TIERS.join(', ')})`);
    return 1;
  }
  const entry = findEntry(cfg, name);
  if (!entry) { fail(`no host adapter named '${safeName}' in kit.json hostAdapters`); return 1; }

  const loaded = await loadAndHash(entry, { reader });
  if (!loaded.ok) {
    fail(`'${safeName}' manifest refused: ${stripControl(loaded.reason)} — ${stripControl(loaded.detail)}`);
    return 1;
  }

  try {
    recordTierGate(name, tier, { hash: loaded.hash, gatedBy: ref }, { file: grantsFile });
  } catch (error) {
    fail(`gate refused: ${stripControl(error?.message ?? String(error))}`);
    return 1;
  }

  ok(`recorded '${safeName}' tier '${safeTier}' as gated on ${stripControl(ref)} at ${loaded.hash}`);
  info(`\`ak host adapters status ${safeName}\` will show this as waiting-on-upstream until the tracked issue ships and the gate is cleared`);
  return 0;
}

// ── status (P7 display) ───────────────────────────────────────────────
// A read-only report over grants.mjs's reporting surfaces — never the
// hash-unaware capability reader (see grants.mjs's module-header invariant).
// Staleness (a manifest edit since evidence was recorded) must be obvious,
// not buried: it voids every passed tier and every grant until re-earned.

async function statusOne(name, entry, { reader, grantsFile }) {
  const safeName = stripControl(name);
  console.log(bold(`host adapter status — ${safeName}`));
  const loaded = await loadAndHash(entry, { reader });
  if (!loaded.ok) {
    fail(`  manifest refused: ${stripControl(loaded.reason)} — ${stripControl(loaded.detail)}`);
    return 1;
  }
  const { hash } = loaded;
  console.log(`  manifest hash: ${hash}`);

  const record = grantsFor(name, { file: grantsFile, currentHash: hash });
  const passed = record ? Object.entries(record.tiers).filter(([, t]) => t?.status === 'passed') : [];
  if (!passed.length) {
    info('  passed tiers: (none)');
  } else {
    console.log('  passed tiers:');
    for (const [tier] of passed) {
      const line = `    ${stripControl(tier)}${record.stale ? '  — STALE (manifest changed since this evidence was recorded; void until re-earned)' : ''}`;
      if (record.stale) warn(line); else ok(line);
    }
  }

  const gated = gatedTiersFor(name, { file: grantsFile, currentHash: hash });
  if (!gated.length) {
    info('  gated tiers: (none)');
  } else {
    console.log('  gated tiers (waiting on upstream):');
    for (const { tier, gatedBy } of gated) info(`    ${stripControl(tier)} -> ${stripControl(gatedBy)}`);
  }

  const granted = Object.keys(grantedCapabilitiesFor(name, hash, { file: grantsFile }));
  console.log(`  granted capabilities: ${granted.length ? granted.map(stripControl).join(', ') : '(none)'}`);
  return 0;
}

export async function status({
  name, cfg, reader, grantsFile,
}) {
  const entries = Array.isArray(cfg?.hostAdapters) ? cfg.hostAdapters : [];
  if (typeof name === 'string' && name) {
    const entry = findEntry(cfg, name);
    if (!entry) { fail(`no host adapter named '${stripControl(name)}' in kit.json hostAdapters`); return 1; }
    return statusOne(name, entry, { reader, grantsFile });
  }
  if (!entries.length) { info('no host adapters configured in kit.json'); return 0; }
  for (const entry of entries) {
    await statusOne(entry?.name ?? '(unnamed)', entry, { reader, grantsFile });
    console.log('');
  }
  return 0;
}

// ── revoke-grant: withdraw conformance evidence + grants ────────────────
// Distinct from `revoke`, which only touches the adapter-consent store
// (whether admission accepts the manifest at all). This touches
// adapter-grants.json (tier evidence, upstream gates, granted capabilities)
// — an operator revoking a manifest's TRUST does not automatically revoke
// capabilities EARNED separately, and vice versa; they are separate stores
// for separate questions. Fail-safe like `revoke`: reachable with the
// experimental flag off, so a disabled surface can still be voided.

export function revokeGrant({ name, grantsFile }) {
  if (typeof name !== 'string' || !name) { fail('usage: ak host adapters revoke-grant <name>'); return 2; }
  const safeName = stripControl(name);
  const existed = revokeGrants(name, { file: grantsFile });
  if (existed) { ok(`revoked all conformance evidence and grants for '${safeName}'`); return 0; }
  info(`no recorded grants for '${safeName}'`);
  return 0;
}
