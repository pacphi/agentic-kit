// x host adapters — the trust CLI for external host-adapter manifests (ADR-0031
// P1) plus the tiered conformance runner (P4). The maintainer's grant/gate CLI
// (P5) and the upstream-gate display (P7) live in the sibling
// host-adapters-grants.mjs (split out to stay under the house 500-line-per-file
// budget) and are re-exported into this file's `run()` dispatch below — from
// the operator's point of view it is all one `ak host adapters` surface.
// Nothing in admission.mjs ever writes consent; this closes that gap by
// recording hash-pinned consent the same way Codex pins an MCP server's
// content (ADR-0029 §6). No adapter code ever executes here — this module
// only reads, validates, hashes, discloses, and (on confirmation) records.
//
// Mirrors admitOne's refusal semantics exactly: the validated manifest and
// declared hook files are hashed only after validateAdapterManifest accepts
// the shape, so the content a user consents to is always the VALIDATED shape
// plus disclosed file bytes, never the raw file — an invalid manifest (e.g.
// one claiming canBePrimary) is refused with its .reason and nothing is ever
// recorded for it.
import readline from 'node:readline/promises';
import { positiveInt } from '../run.mjs';
import {
  baseDirForSource, hashAdapterContent, SUPPORTED_CONTRACT,
} from '../../lib/adapters/admission.mjs';
import { validateAdapterManifest } from '../../lib/adapters/manifest.mjs';
import { HOST_REGISTRY } from '../../lib/adapters/registries.mjs';
import * as consentStore from '../../lib/adapters/consent.mjs';
import { runTieredConformance as defaultRunTieredConformance } from '../../lib/adapters/conformance.mjs';
import { loadKitConfig } from '../../lib/config.mjs';
import { ok, warn, fail, info, dim, bold } from '../../lib/output.mjs';
import {
  grant as grantCap, gate as gateTier, status as statusReport, revokeGrant,
} from './host-adapters-grants.mjs';

const FLAG_ENV_VAR = 'AK_EXPERIMENTAL_HOST_ADAPTERS';

const flagEnabled = (env) => env?.[FLAG_ENV_VAR] === '1';

/** Lazy dynamic import so this file loads even before sources.mjs lands (a
 * sibling work item this same wave) and so tests never pay for it unless
 * they choose to — same pattern admission.mjs uses for consent.mjs. */
async function defaultReader(source) {
  const { resolveManifestSource } = await import('../../lib/adapters/sources.mjs');
  return resolveManifestSource(source);
}

async function defaultAsk(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

/** Untrusted text (manifest trust.changes fields, reader/validator error
 * detail) is printed verbatim ahead of a consent prompt — a crafted string
 * carrying cursor-movement/erase ANSI escapes or extra newlines could
 * visually rewrite the disclosure the operator is about to agree to. A
 * codepoint loop, not a control-character regex class (that trips
 * `no-control-regex` AND is what sources.mjs's sanitizeDetail already uses,
 * so this stays lint-clean the same way). Strips C0 (0x00-0x1F), DEL
 * (0x7F), and C1 (0x80-0x9F, e.g. U+009B CSI — a real terminal control that
 * JSON.stringify does NOT escape, unlike C0) outright; \n/\t/\r collapse to
 * a single space instead of vanishing, so a multi-line/tabbed string stays
 * readable as one line rather than silently losing a word boundary. */
export function stripControl(value) {
  const input = String(value ?? '');
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (code === 0x09 || code === 0x0a || code === 0x0d) { out += ' '; continue; }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

export function findEntry(cfg, name) {
  return (Array.isArray(cfg?.hostAdapters) ? cfg.hostAdapters : []).find((e) => e?.name === name) ?? null;
}

/** Read + validate + hash one adapter entry. Never throws — reports
 * {ok:false, reason, detail} on any failure, the same per-entry isolation
 * posture admission.mjs's admitOne holds. `reader` may return either the
 * sources.mjs `{raw, origin}` shape or a bare raw document (tests are free
 * to stub either). */
export async function loadAndHash(entry, { reader }) {
  let raw;
  // Fail-closed, not fail-open: a bare-raw reader result (no {raw,origin}
  // wrapper — including one whose `origin` is missing/malformed) is
  // 'unknown', never assumed to be 'file'. Defaulting to 'file' would let
  // --yes silently skip the --expect-hash pin (finding 8) for a source that
  // was never actually proven local; only an explicit origin:'file' counts.
  let origin = 'unknown';
  try {
    const resolved = await reader(entry.source);
    if (resolved && typeof resolved === 'object' && 'raw' in resolved) {
      raw = resolved.raw;
      origin = typeof resolved.origin === 'string' && resolved.origin ? resolved.origin : 'unknown';
    } else {
      raw = resolved;
    }
  } catch (error) {
    return { ok: false, reason: error?.reason ?? 'manifest-unreadable', detail: error?.message ?? String(error) };
  }

  // Same distinct failure admitOne draws: cfg's pinned contract disagreeing
  // with the manifest's self-declared one means the file changed underneath
  // the operator, not merely "unsupported version".
  if (entry.contract !== undefined && raw?.contract !== undefined && entry.contract !== raw.contract) {
    return {
      ok: false, reason: 'contract-mismatch',
      detail: `cfg declares contract ${entry.contract}, manifest declares ${raw.contract}`,
    };
  }

  let manifest;
  try {
    manifest = validateAdapterManifest(raw);
  } catch (error) {
    return { ok: false, reason: error?.reason ?? 'manifest-invalid', detail: error?.message ?? String(error) };
  }

  if (manifest.contract !== SUPPORTED_CONTRACT) {
    return { ok: false, reason: 'contract-version', detail: `unsupported contract ${manifest.contract}` };
  }
  if (manifest.host.id !== entry.name) {
    return {
      ok: false, reason: 'name-mismatch',
      detail: `cfg entry '${entry.name}' does not match manifest host id '${manifest.host.id}'`,
    };
  }
  // Same check admitOne applies before ever computing a hash: a manifest
  // whose host id collides with a built-in can never actually be admitted,
  // so trusting it would record a standing consent for content admission
  // will always refuse — misleading UX for nothing gained.
  if (HOST_REGISTRY.some((host) => host.id === manifest.host.id)) {
    return { ok: false, reason: 'builtin-shadow', detail: `'${manifest.host.id}' is a built-in host id` };
  }

  let integrity;
  try {
    integrity = hashAdapterContent(manifest, { baseDir: baseDirForSource(entry.source) });
  } catch (error) {
    return { ok: false, reason: error?.reason ?? 'hook-integrity', detail: error?.message ?? String(error) };
  }
  return { ok: true, manifest, hash: integrity.hash, integrity, origin };
}

/** Trust state for one entry — never throws. One of 'trusted', 'consent-stale',
 * 'not consented', or 'manifest error (<reason>)'. */
export async function stateFor(entry, { consent, reader }) {
  if (typeof entry?.name !== 'string' || !entry.name) return 'manifest error (invalid-entry: missing name)';
  const loaded = await loadAndHash(entry, { reader });
  if (!loaded.ok) return `manifest error (${stripControl(loaded.reason)})`;
  let recorded;
  try {
    recorded = consent.recordedHashFor(entry.name);
  } catch (error) {
    return `manifest error (consent-error: ${error?.message ?? String(error)})`;
  }
  if (recorded === null || recorded === undefined) return 'not consented';
  return recorded === loaded.hash ? 'trusted' : 'consent-stale';
}

async function list({ cfg, consent, reader }) {
  const entries = Array.isArray(cfg?.hostAdapters) ? cfg.hostAdapters : [];
  if (!entries.length) { info('no host adapters configured in kit.json'); return 0; }
  console.log(bold('host adapters') + dim('  (trust state)'));
  for (const entry of entries) {
    const name = entry?.name ?? '(unnamed)';
    console.log(`  ${String(name).padEnd(16)} ${dim(entry?.source ?? '')}`);
    console.log(`    ${await stateFor(entry, { consent, reader })}`);
  }
  return 0;
}

function discloseManifest(name, manifest, integrity) {
  const hash = integrity.hash;
  console.log(bold(`host adapter manifest — ${name}`));
  // Full content FIRST, decision-critical summary LAST (finding 16): a
  // large-but-legal manifest can run many screens of JSON, and whatever
  // prints immediately before the [y/N] prompt is what the operator's eyes
  // are actually on. Burying the summary above the JSON block meant it
  // scrolled off-screen entirely on a big manifest, well before the prompt.
  //
  // Consent is granted over the WHOLE validated manifest (ADR-0029 §6),
  // including fields the curated summary below doesn't call out by name
  // (host.legacy.*, host.trust.approvalPolicy, detection, driving.surfaces,
  // ...) — printing it in full means nothing hashed is ever hidden from the
  // thing being consented to.
  console.log(bold('full manifest (exactly the content being hashed):'));
  // JSON.stringify escapes every C0 control character (0x00-0x1F) WITHIN A
  // STRING VALUE by construction, but leaves C1 (0x80-0x9F, e.g. U+009B
  // CSI) untouched — those can only reach this text as a raw byte that
  // leaked from an untrusted manifest field, never from the pretty-printer's
  // own structural indentation (spaces/real newlines are the ONLY raw
  // control-range bytes stringify itself emits). Splitting on that
  // structural newline before sanitizing each line and rejoining after
  // means stripControl only ever sees within-line content — it strips a
  // leaked C1 byte (and is a no-op on \n/\t/\r, since none survive stringify
  // raw inside a line) without collapsing the block's own line breaks.
  console.log(JSON.stringify(manifest, null, 2).split('\n').map(stripControl).join('\n'));
  console.log('');
  console.log(`  version:  ${manifest.version}`);
  console.log(`  contract: ${manifest.contract}`);
  console.log(`  host id:  ${manifest.host.id}`);
  const trueCaps = Object.entries(manifest.host.capabilities ?? {})
    .filter(([, v]) => v === true).map(([k]) => k);
  console.log(`  capabilities: ${trueCaps.length ? trueCaps.join(', ') : '(none)'}`);
  const lifecycle = manifest.lifecycle ?? {};
  const verbs = Object.keys(lifecycle);
  console.log(`  lifecycle hooks:${verbs.length ? '' : ' (none)'}`);
  for (const verb of verbs) {
    const { hook } = lifecycle[verb];
    const timeout = hook.timeoutMs !== undefined ? ` (timeout ${hook.timeoutMs}ms)` : '';
    console.log(`    ${verb}: ${JSON.stringify(hook.command)}${timeout}`);
  }
  const changes = manifest.trust?.changes ?? [];
  console.log(`  trust changes:${changes.length ? '' : ' (none)'}`);
  for (const change of changes) {
    console.log(`    [${change.scope}] ${stripControl(change.owner)}: ${stripControl(change.value)} — ${stripControl(change.effect)}`);
  }
  console.log(`  hook file digests: ${integrity.hookFiles.length ? '' : '(none)'}`);
  for (const file of integrity.hookFiles) console.log(`    ${file.path}: ${file.sha256}`);
  console.log(`  sha256: ${hash}`);
}

async function trust({ name, cfg, consent, reader, ask, isTTY, yes, expectHash }) {
  if (typeof name !== 'string' || !name) { fail('usage: ak host adapters trust <name>'); return 2; }
  const entry = findEntry(cfg, name);
  if (!entry) { fail(`no host adapter named '${name}' in kit.json hostAdapters`); return 1; }

  const loaded = await loadAndHash(entry, { reader });
  if (!loaded.ok) {
    fail(`'${name}' manifest refused: ${stripControl(loaded.reason)} — ${stripControl(loaded.detail)}`);
    return 1;
  }
  const { manifest, integrity, hash, origin } = loaded;

  // --expect-hash pinning (finding 8): required whenever --yes is paired
  // with a non-file origin, so an unattended (CI) run can never blanket-
  // consent to "whatever content the remote currently serves" — that
  // defeats hash pinning exactly where it matters. Checked before any
  // consent-store lookup or disclosure.
  if (yes && origin !== 'file' && !expectHash) {
    fail(`'${name}' resolved from a non-file origin ('${stripControl(origin)}') — --yes needs --expect-hash <sha256> so an unattended run pins exact content instead of trusting whatever the remote serves right now (drop --yes to review interactively, or pass the hash from a prior interactive trust)`);
    return 2;
  }
  if (expectHash !== undefined && expectHash !== hash) {
    fail(`'${name}' hash mismatch — --expect-hash ${expectHash} does not match the resolved adapter content hash ${hash}; refusing to record consent for unexpected content`);
    return 1;
  }

  let recorded;
  try {
    recorded = consent.recordedHashFor(name);
  } catch (error) {
    fail(`consent store error: ${error?.message ?? String(error)}`);
    return 1;
  }
  if (recorded === hash) {
    ok(`'${name}' is already trusted at this exact content (${hash}) — nothing to do`);
    return 0;
  }
  if (recorded !== null && recorded !== undefined) {
    warn(`'${name}' consent is stale — previously trusted content hash ${recorded}, current adapter content hash ${hash}`);
  }

  discloseManifest(name, manifest, integrity);

  if (!yes) {
    if (!isTTY) {
      fail('trust needs confirmation — re-run with --yes after reviewing the manifest above (non-interactive session)');
      return 2;
    }
    const confirmed = await ask('Trust this manifest content exactly as disclosed above? [y/N] ');
    if (!confirmed) { info(`consent for '${name}' left unchanged`); return 0; }
  }

  consent.recordConsent(name, hash);
  ok(`consent recorded for '${name}' at ${hash}`);
  info('admission will now accept this exact manifest and declared hook-file content — edit either and re-run `ak host adapters trust` after reviewing the new digest');
  return 0;
}

function revoke({ name, consent }) {
  if (typeof name !== 'string' || !name) { fail('usage: ak host adapters revoke <name>'); return 2; }
  const existed = consent.revokeConsent(name);
  if (existed) { ok(`revoked consent for '${name}'`); return 0; }
  info(`no recorded consent for '${name}'`);
  return 0;
}

/** Unwrap a reader result down to the raw manifest document —
 * runTieredConformance's `readManifest` follows admitAdapters' own contract
 * ((source) => Promise<any> raw), while `reader` here may return either the
 * sources.mjs `{raw, origin}` shape or a bare raw document (same tolerance
 * loadAndHash above applies). */
function toRawManifestReader(reader) {
  return async (source) => {
    const resolved = await reader(source);
    return resolved && typeof resolved === 'object' && 'raw' in resolved ? resolved.raw : resolved;
  };
}

function tierLine(tier) {
  const detail = tier.detail
    ?? tier.checks.find((c) => !c.ok)?.detail
    ?? tier.checks[0]?.detail
    ?? '';
  return `${String(tier.tier).padEnd(18)} ${String(tier.status).padEnd(8)} ${dim(stripControl(detail))}`;
}

export function hookCommandsFor(manifest) {
  const hooks = [];
  for (const [verb, def] of Object.entries(manifest.lifecycle ?? {})) {
    if (def?.hook?.command) hooks.push(`lifecycle.${verb}: ${JSON.stringify(def.hook.command)}`);
  }
  if (manifest.execution?.run?.hook?.command) {
    hooks.push(`execution.run: ${JSON.stringify(manifest.execution.run.hook.command)}`);
  }
  return hooks;
}

/** F6 (Wave C security review): `conformance` self-consents — it records its
 * own temporary consent and spawns declared hooks with only the experimental
 * flag plus a kit.json entry as gates, needing no prior
 * `ak host adapters trust`. That is the intended self-test posture (ADR-0031
 * §5), not a consent bypass, but the operator/maintainer must not be
 * surprised by it: disclose every hook command about to run as a REAL
 * subprocess before the harness does anything. Best-effort and non-fatal —
 * a manifest that can't be pre-read/validated here still gets a generic
 * warning; the harness's own admission tier reports the real failure reason
 * either way, this is disclosure only, never a gate. */
async function warnAboutHooks(name, entry, rawReader) {
  warn(`'${name}' conformance is a SELF-TEST (ADR-0031 §5) — it records its own temporary consent and needs no prior 'ak host adapters trust'.`);
  let manifest;
  try {
    manifest = validateAdapterManifest(await rawReader(entry.source));
  } catch {
    warn('  the manifest could not be pre-disclosed here; any declared hooks still run as REAL subprocesses.');
    return;
  }
  const hooks = hookCommandsFor(manifest);
  if (!hooks.length) {
    info(`  '${name}' declares no lifecycle/execution hooks — nothing will be spawned.`);
    return;
  }
  warn('  the following hooks will run as REAL subprocesses:');
  // N-1 (Wave C security review): hook.command is arbitrary validated
  // strings — JSON.stringify escapes C0 (0x00-0x1F) but leaves C1
  // (0x80-0x9F, e.g. U+009B CSI) and DEL (0x7F) untouched, same gap F3
  // closed elsewhere in this file. This is the one line whose entire job is
  // to be trustworthy before any code runs, so it routes through the same
  // stripControl every other untrusted-string sink here already uses.
  for (const line of hooks) console.log(`    ${dim(stripControl(line))}`);
}

/** `ak host adapters conformance <name>` — runs the ADR-0031 §2 tiered
 * conformance harness against one configured adapter entry and prints a
 * per-tier table. Recording into the grant store happens INSIDE
 * runTieredConformance itself (conformance.mjs) — this command's job is
 * resolving the cfg entry, wiring a real reader, disclosing what is about to
 * spawn, and rendering the report; see conformance.mjs's own header for the
 * recording semantics (passed -> recordTierResult, upstream-gated ->
 * recordTierGate, everything else persists nothing). */
async function conformance({
  name, cfg, reader, runTiered, consentFile, grantsFile, flags = /** @type {{timeout?:string,dev?:boolean}} */ ({}),
}) {
  if (typeof name !== 'string' || !name) { fail('usage: ak host adapters conformance <name>'); return 2; }
  const entry = findEntry(cfg, name);
  if (!entry) { fail(`no host adapter named '${name}' in kit.json hostAdapters`); return 1; }

  let timeoutMs;
  try {
    timeoutMs = positiveInt(flags.timeout, 'timeout', { ceiling: 2_147_483_647 });
  } catch (error) {
    fail(error.message);
    return 2;
  }

  const rawReader = toRawManifestReader(reader);
  if (flags.dev) {
    warn(`'${name}' conformance DEV MODE — hooks still run as real subprocesses, but no consent, tier evidence, or capability grant is persisted; this run cannot graduate the adapter.`);
  }
  await warnAboutHooks(name, entry, rawReader);

  let report;
  try {
    report = await runTiered({
      name,
      manifestSource: entry.source,
      readManifest: rawReader,
      consentFile,
      grantsFile,
      timeoutMs,
      persist: !flags.dev,
    });
  } catch (error) {
    fail(`'${name}' conformance run failed: ${stripControl(error?.message ?? String(error))}`);
    return 1;
  }

  console.log(bold(`host adapter conformance — ${report.name}`) + (report.hash ? dim(`  (${report.hash})`) : ''));
  if (flags.dev) info('  [dev: evidence not persisted]');
  let anyFailed = false;
  for (const tier of report.tiers) {
    const line = tierLine(tier);
    if (tier.status === 'passed') ok(line);
    else if (tier.status === 'failed') { fail(line); anyFailed = true; }
    else if (tier.status === 'gated') warn(line);
    else info(line);
  }
  return anyFailed ? 1 : 0;
}

/**
 * @param {{ positionals?: string[], flags?: any, env?: NodeJS.ProcessEnv,
 *   consent?: { recordedHashFor(name:string): string|null, recordConsent(name:string, hash:string): void, revokeConsent(name:string): boolean },
 *   reader?: (source: string) => Promise<any>, ask?: (question: string) => Promise<boolean>,
 *   isTTY?: boolean, cfg?: any, runTieredConformance?: (options: any) => Promise<any>,
 *   consentFile?: string, grantsFile?: string }} [args]
 */
export async function run({
  positionals = [], flags = {}, env = process.env,
  consent = consentStore, reader = defaultReader, ask = defaultAsk,
  isTTY = process.stdin.isTTY === true, cfg,
  runTieredConformance = defaultRunTieredConformance, consentFile, grantsFile,
} = {}) {
  const sub = positionals[0] ?? 'list';
  const name = positionals[1];

  // Revocation is fail-safe and stays reachable regardless of the
  // experimental flag: an operator who turns the flag OFF must still be
  // able to withdraw a standing consent or grant record, or it silently
  // reactivates the next time the flag is turned back on. `list`/`trust`/
  // `conformance`/`grant`/`gate`/`status` stay gated — they're the surface
  // that reads/records new trust, evidence, or capability.
  if (sub === 'revoke') return revoke({ name, consent });
  if (sub === 'revoke-grant') return revokeGrant({ name, capability: positionals[2], grantsFile });

  if (!flagEnabled(env)) {
    fail(`experimental host-adapter surface is disabled — set ${FLAG_ENV_VAR}=1`);
    return 2;
  }

  const resolvedCfg = cfg ?? loadKitConfig();

  if (sub === 'list') return list({ cfg: resolvedCfg, consent, reader });
  if (sub === 'trust') {
    return trust({
      name, cfg: resolvedCfg, consent, reader, ask, isTTY,
      yes: !!flags.yes, expectHash: flags['expect-hash'],
    });
  }
  if (sub === 'conformance') {
    return conformance({
      name, cfg: resolvedCfg, reader, runTiered: runTieredConformance, consentFile, grantsFile, flags,
    });
  }
  // F-8 (security review, ADR-0031-accurate naming): `bless` is the alias —
  // §3 calls this exact out-of-tree grant path a "Blessed external adapter";
  // "Promoted built-in" is the separate manual registry PR this command does
  // NOT do. `grant` stays the primary spelling; `promote` was dropped.
  if (sub === 'grant' || sub === 'bless') {
    return grantCap({
      name, capability: positionals[2], cfg: resolvedCfg, consent, reader, ask, isTTY,
      yes: !!flags.yes, grantsFile,
    });
  }
  if (sub === 'gate') {
    return gateTier({
      name, tier: positionals[2], ref: positionals[3], cfg: resolvedCfg, reader, grantsFile,
    });
  }
  if (sub === 'status') return statusReport({ name, cfg: resolvedCfg, reader, grantsFile });

  fail(`unknown host adapters subcommand: ${sub} (list|trust|revoke|conformance|grant|bless|gate|status|revoke-grant)`);
  return 2;
}
