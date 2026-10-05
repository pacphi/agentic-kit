// Statusline healing — port of ruflo-fix-statusline-version:
//   (a) strip the legacy kit version-probe marker. The version itself is
//       Ruflo's: its helper bakes `let ver` as a floor and shows the HIGHEST
//       version it finds at render time (3.28+, #2221), so ak never writes it —
//       a value ak wrote too high could never self-correct. A baked value above
//       every install is repaired by clearing the helper stamp so Ruflo's own
//       refresh regenerates the helper (refreshHelpersBeforeInjection),
//   (b) inject/re-inject the kit's activation footer (ruflo-seg block),
//   (c) legacy repoint: projects initialized under aqe <3.12.1 may still have
//       settings.json statusLine aimed at the minimal statusline-v3.cjs.
// CRLF-safe: operates on normalized text, re-emits the file's dominant ending.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  projectStatusline, projectStatuslineLoader, projectStatuslineFooter, projectSettings, rufloCliDist, rufloNodeModules,
} from './paths.mjs';
import { installedVersion, cmpVersions } from './versions.mjs';
import { readJson, writeJsonWithBackup } from './settings.mjs';

const FOOTER_TEMPLATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'statusline-footer.cjs');

const eol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

// Retired security overlay (ruvnet/ruflo#2694). An earlier ak wrapped
// getStatuslineData() between these markers to replace Ruflo's fabricated CVE
// count; Ruflo fixed getSecurityStatus in 3.32.2, below the support window's
// floor (ADR-0041 §7), so ak no longer injects it. The strip stays for one
// release so a statusline patched by an older ak is cleaned on the next sync:
// remove SEC_WRAP_STRIP and its use in fixStatusline after one release.
const SEC_WRAP_STRIP = /\/\* ruflo-sec:BEGIN \*\/[\s\S]*?\/\* ruflo-sec:END \*\/\n?/g;

// (e) Bin-resolution wrapper. Upstream's resolveCliBinCandidates probes filenames
// that no shipped package ships: ruflo's bin map is {"ruflo": "bin/ruflo.js"} (no
// cli.js), and @claude-flow/cli — which DOES ship bin/cli.js — is ruflo's nested
// dependency, not a top-level global install. Every candidate therefore misses and
// the statusline silently falls through to `npx --prefer-offline @claude-flow/cli`,
// i.e. whatever stale version the npx cache holds. That is how a machine whose
// installed 3.32.2 carried the CVE-counter fix still rendered the fabricated
// "⚠ 1 CVE" / perpetual "scanning…" from a cached 3.28.0.
//
// Unlike the retired security overlay there is deliberately NO retirement gate: the wrapper
// only PREPENDS bins verified to exist on disk (rufloRealCliBins, injected with the
// footer) and keeps upstream's own candidates as the tail, so on a fixed upstream it
// converges to the same delegation instead of fighting it. A gate would be one more
// proxy-probe that can misfire — the CVE gate watched the global install while the
// render path executed a stale npx copy. Relies on function-declaration hoisting:
// the resolver is initialized before any top-level code runs, so this block can
// reassign the binding. Typeof-guarded so it is inert on templates
// without the function (e.g. the minimal statusline-v3.cjs). The inner try around
// the CWD read absorbs the TDZ ReferenceError if a future template declares CWD
// with let/const after this block yet calls the resolver during top-level eval.
const BIN_WRAP = [
  '/* ruflo-bin:BEGIN */',
  'try {',
  '  if (typeof resolveCliBinCandidates === "function") {',
  '    var _rufloOrigResolveCliBins = resolveCliBinCandidates;',
  '    resolveCliBinCandidates = function(){',
  '      var orig = [];',
  '      try { orig = _rufloOrigResolveCliBins.apply(this, arguments) || []; } catch(e){}',
  '      try {',
  '        var cwd = process.cwd();',
  '        try { if (typeof CWD === "string" && CWD) cwd = CWD; } catch(e){}',
  '        var real = (typeof rufloRealCliBins === "function") ? rufloRealCliBins(cwd) : [];',
  '        return real.concat(orig.filter(function(p){ return real.indexOf(p) === -1; }));',
  '      } catch(e){ return orig; }',
  '    };',
  '  }',
  '} catch(e){}',
  '/* ruflo-bin:END */',
].join('\n');
const BIN_WRAP_STRIP = /\/\* ruflo-bin:BEGIN \*\/[\s\S]*?\/\* ruflo-bin:END \*\/\n?/g;

/** @claude-flow/cli's helper auto-refresh module (helper-refresh.js) — the
 *  writer that wiped the kit's footer between syncs. On EVERY ruflo CLI command
 *  it compares `.claude/helpers/.helpers-version` to the installed CLI version
 *  and, when the stamp lags, pristine-copies the CRITICAL_HELPERS (statusline.cjs
 *  among them) over ours. */
const helperRefreshModule = () => path.join(rufloCliDist(), 'init', 'helper-refresh.js');
const helperStampFile = (root) => path.join(root, '.claude', 'helpers', '.helpers-version');

/** Installed @claude-flow/cli version (the value ruflo stamps helpers with),
 *  or null. Versioned in lockstep with ruflo, but read from the cli package
 *  itself so a skewed tree can't fool the compare. */
function rufloCliVersion() {
  try {
    const pkg = path.join(rufloCliDist(), '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? null;
  } catch { /* fall through to resolver */ }
  // Resolver fallback: ruflo finds its own version via require.resolve, which
  // can succeed where the fixed path.join fails (symlinked/relocated cli). The
  // two staleness oracles — ours and ruflo's — must not disagree: if we
  // under-report ("not stale") while ruflo would refresh, a providers-only
  // sync runs a ruflo command that wipes the footer with no re-inject planned.
  try {
    const req = createRequire(pathToFileURL(path.join(rufloNodeModules(), 'noop.js')));
    return JSON.parse(fs.readFileSync(req.resolve('@claude-flow/cli/package.json'), 'utf8')).version ?? null;
  } catch { return null; }
}

/** True when ruflo's helper stamp lags the installed CLI — the armed state in
 *  which the NEXT ruflo command (in practice the daemon start) auto-refreshes
 *  the helpers and wipes the kit footer. Status uses this to flag the wipe
 *  BEFORE it happens; sync closes it via refreshRufloHelpers(). Missing stamp
 *  with a resolvable CLI counts as stale (first refresh hasn't run yet). */
export function helperStampStale(root = process.cwd()) {
  const installed = rufloCliVersion();
  if (!installed) return false; // no ruflo cli → nothing will refresh anything
  // Mirror ruflo's own precondition (helper-refresh.js refreshOneHelpersDir):
  // a directory without hook-handler.cjs is never refreshed, so there is no
  // armed wipe to report — e.g. ~/.claude or a project ruflo never initialized.
  if (!fs.existsSync(path.join(root, '.claude', 'helpers', 'hook-handler.cjs'))) return false;
  try {
    // Tolerate a `v` prefix: ruflo writes the stamp bare today, but a prefixed
    // stamp fed raw into cmpVersions goes NaN and reads as PERMANENTLY stale —
    // arming a pointless refresh on every status/sync forever. Genuine garbage
    // still reads stale BY DESIGN: the refresh it arms rewrites a clean stamp,
    // so the state self-corrects in one sync rather than sticking.
    const stamp = fs.readFileSync(helperStampFile(root), 'utf8').trim().replace(/^v/i, '');
    return cmpVersions(installed, stamp) > 0;
  } catch { return true; } // stamp unreadable/absent → first ruflo command will refresh
}

/** Run ruflo's helper auto-refresh NOW, under the kit's control, so the
 *  pristine-copy happens BEFORE footer injection instead of on the first ruflo
 *  command after an upgrade. Root cause of the recurring footer wipe (observed
 *  2026-07-18: daemon start at 12:20:35 rewrote statusline.cjs + .helpers-version
 *  the same second — sync had injected onto a stale-stamped helper, so the wipe
 *  was already armed). Subprocess, not in-process import: ruflo's ESM tree must
 *  never load into the kit's module graph. Best-effort — absent module or any
 *  failure returns false and injection proceeds on the file as-is (no worse
 *  than the pre-fix behavior). */
export function refreshRufloHelpers(root = process.cwd(), { timeoutMs = 30_000 } = {}) {
  return runHelperRefresh(root, { timeoutMs }) !== 'failed';
}

/** refreshRufloHelpers with the outcome kept: 'refreshed' when ruflo actually
 *  rewrote a helper set (project or global), 'current' when it ran unblocked
 *  and had nothing to write (stamp current, or no ruflo helpers in either
 *  location), 'failed' when the module is absent, rejected, hung or was
 *  blocked. Sync reports from this so a no-op never reads as a heal. */
export function runHelperRefresh(root = process.cwd(), { timeoutMs = 30_000 } = {}) {
  const mod = helperRefreshModule();
  if (!fs.existsSync(mod)) return 'failed';
  try {
    // exit 1 = import failed / refresh rejected; 2 = BLOCKED (upstream resolves
    // {blocked:'…signature invalid'} rather than rejecting when the
    // signed-manifest gate refuses to copy); 3 = ran unblocked, wrote nothing.
    execFileSync(process.execPath, ['-e',
      'import(process.argv[2]).then((m)=>m.autoRefreshHelpersIfStale(process.argv[1],{alsoRefreshGlobal:true})).then((r)=>{if(r&&r.blocked)process.exit(2);if(!(r&&(r.refreshed||(r.global&&r.global.refreshed))))process.exit(3)},()=>process.exit(1))',
      root, pathToFileURL(mod).href,
    ], { stdio: 'ignore', timeout: timeoutMs });
    return 'refreshed';
  } catch (error) { return error?.status === 3 ? 'current' : 'failed'; }
}

const BAKED_VERSION = /let (?:ver|pkgVersion) = (["'])(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\1/;

/** The version Ruflo baked into the project helper (`let ver = "…"`), or null. */
export function bakedStatuslineVersion(root = process.cwd()) {
  try { return fs.readFileSync(projectStatusline(root), 'utf8').match(BAKED_VERSION)?.[2] ?? null; } catch { return null; }
}

/** Highest installed ruflo: the @claude-flow/cli version Ruflo bakes and stamps
 *  with, and the ruflo package itself (versioned in lockstep). */
function installedRufloCeiling() {
  const found = [rufloCliVersion(), installedVersion('ruflo')].filter(Boolean);
  return found.length ? found.reduce((a, b) => (cmpVersions(a, b) >= 0 ? a : b)) : null;
}

/** Ruflo's helper shows the HIGHEST of its baked `let ver` floor and every
 *  install it finds at render time. A floor above everything installed (a test
 *  fixture's fake 9.9.9 once leaked into a real project this way) therefore
 *  pins the statusline to a version that is not installed, and nothing on the
 *  render path lowers it. Returns `{ baked, installed }` in exactly that case,
 *  else null. A higher runtime candidate (e.g. a marketplace checkout ahead of
 *  the global install) is Ruflo's by-design "highest wins" and is not compared.
 *  Read-only. */
export function statuslineVersionAhead(root = process.cwd()) {
  const baked = bakedStatuslineVersion(root);
  const installed = baked ? installedRufloCeiling() : null;
  if (!baked || !installed) return null;
  return cmpVersions(baked, installed) > 0 ? { baked, installed } : null;
}

/** Why Ruflo's helper refresh cannot regenerate this project's helpers, or null
 *  when it can. Mirrors helper-refresh.js's own gates (env opt-out, `.LOCKED`,
 *  no hook-handler.cjs) plus the module being present at all. A signature-gate
 *  refusal cannot be predicted; sync reports that one after trying. */
export function helperRefreshBlocker(root = process.cwd()) {
  const helpers = path.join(root, '.claude', 'helpers');
  if (/^(1|true|on|yes)$/i.test(String(process.env.RUFLO_HELPERS_LOCKED ?? ''))) return 'RUFLO_HELPERS_LOCKED is set';
  if (fs.existsSync(path.join(helpers, '.LOCKED'))) return '.claude/helpers/.LOCKED is present';
  if (!fs.existsSync(path.join(helpers, 'hook-handler.cjs'))) return 'no ruflo hook-handler.cjs in .claude/helpers';
  if (!fs.existsSync(helperRefreshModule())) return 'the installed ruflo has no helper-refresh module';
  return null;
}

/** The one-line manual remedy when sync cannot repair the baked version. */
export const bakedVersionManualFix = (installed) =>
  `edit \`let ver\` in .claude/helpers/statusline.cjs to v${installed} or lower`;

/** Refresh ruflo's helpers before injection (see fixStatusline). When the baked
 *  version is ahead of every install, first clear the helper stamp: Ruflo's
 *  refresh is forward-only and skips a current stamp, so this is what makes it
 *  regenerate the helper with ITS OWN baked value — ak never writes a version.
 *  Verified by re-reading the file; a refresh that did not lower the version
 *  gets its stamp back so no permanent "stale stamp" is left behind. When the
 *  refresh is known not to run here (helperRefreshBlocker) the stamp is not touched.
 *  @returns {{versionRepair: ('repaired'|'failed'|null), versionAhead: ({baked: string, installed: string}|null)}}
 *    versionRepair is null when no repair was needed; versionAhead is the state found before it */
function refreshHelpersBeforeInjection(root) {
  const ahead = statuslineVersionAhead(root);
  const clearStamp = ahead && !helperRefreshBlocker(root);
  const stampFile = helperStampFile(root);
  let stamp = null;
  if (clearStamp) {
    try { stamp = fs.readFileSync(stampFile, 'utf8'); } catch { /* absent: nothing to restore */ }
    // A folder ak cannot write leaves the stamp in place; Ruflo's refresh then
    // skips, and the repair is reported as failed below instead of aborting sync.
    try { fs.rmSync(stampFile, { force: true }); } catch { /* reported as a failed repair */ }
  }
  refreshRufloHelpers(root);
  if (!ahead) return { versionRepair: null, versionAhead: null };
  if (!statuslineVersionAhead(root)) return { versionRepair: 'repaired', versionAhead: ahead };
  if (stamp !== null && !fs.existsSync(stampFile)) {
    try { fs.writeFileSync(stampFile, stamp); } catch { /* best-effort restore */ }
  }
  return { versionRepair: 'failed', versionAhead: ahead };
}

const LOADER_TEMPLATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'statusline-loader.cjs');

// Ruflo's own statusLine command points at the signed helper; ours prefers the loader and
// falls back to that helper, so a project that loses the loader still renders stock.
export const LOADER_COMMAND = 'sh -c \'D="${CLAUDE_PROJECT_DIR:-.}"; if [ -f "$D/.claude/helpers/ak-statusline.cjs" ]; then exec node "$D/.claude/helpers/ak-statusline.cjs"; fi; [ -f "$D/.claude/helpers/statusline.cjs" ] || D="${HOME}"; exec node "$D/.claude/helpers/statusline.cjs"\'';

// What `ruflo init` writes; uninstall puts it back when it removes the loader.
export const RUFLO_STATUSLINE_COMMAND = 'sh -c \'D="${CLAUDE_PROJECT_DIR:-.}"; [ -f "$D/.claude/helpers/statusline.cjs" ] || D="${HOME}"; exec node "$D/.claude/helpers/statusline.cjs"\'';

const LOADER_MARK = 'ak-statusline.cjs';
const rufloOwnedCommand = (cmd) => cmd.includes('helpers/statusline.cjs') || cmd.includes('statusline-v3.cjs');

/** True when a statusLine command runs the kit loader. */
export const commandUsesLoader = (cmd) => typeof cmd === 'string' && cmd.includes(LOADER_MARK);

/** The text the loader splices into Ruflo's helper in memory: the footer plus the bin fix. */
export function footerSource() {
  const footer = fs.readFileSync(FOOTER_TEMPLATE, 'utf8').replace(/\r\n/g, '\n').trim();
  return `${[footer, BIN_WRAP].join('\n')}\n`;
}

const loaderSource = () => fs.readFileSync(LOADER_TEMPLATE, 'utf8').replace(/\r\n/g, '\n');

/** Strip everything an older ak injected into the signed helper, leaving Ruflo's text. */
export function stripInjected(raw) {
  let s = raw.replace(/\r\n/g, '\n');
  s = s.replace(/ \/\* agentic-kit: global-install version probe \*\/ require\("path"\)\.join\(require\("path"\)\.dirname\(process\.execPath\),"\.\.","lib","node_modules","ruflo","package\.json"\),/, '');
  s = s.replace(/\/\* ruflo-seg:BEGIN \*\/[\s\S]*?\/\* ruflo-seg:END \*\/\n?/, '');
  s = s.replace(/ \+ rufloActivationSegments\(process\.cwd\(\)\)/g, '');
  s = s.replace(SEC_WRAP_STRIP, '');
  s = s.replace(BIN_WRAP_STRIP, '');
  return eol(raw) === '\r\n' ? s.replace(/\n/g, '\r\n') : s;
}

function writeIfChanged(file, content, dryRun) {
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* absent */ }
  if (current === content) return false;
  if (!dryRun) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  }
  return true;
}

// Restores Ruflo's text in the signed helper; rolls back if the result does not parse.
function restoreSignedHelper(file, raw, dryRun) {
  const stock = stripInjected(raw);
  if (stock === raw) return { changed: false };
  if (dryRun) return { changed: true };
  fs.writeFileSync(file, stock);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' });
  } catch {
    fs.writeFileSync(file, raw);
    return { changed: false, failed: 'restored helper failed node --check — rolled back' };
  }
  return { changed: true };
}

// Points a Ruflo-owned statusLine command at the loader. A command someone else wrote is theirs.
function wireStatusLine(root, dryRun) {
  const settingsFile = projectSettings(root);
  const settings = readJson(settingsFile);
  const cmd = settings?.statusLine?.command ?? '';
  if (!rufloOwnedCommand(cmd) || commandUsesLoader(cmd)) return false;
  if (!dryRun) {
    settings.statusLine = { type: 'command', ...settings.statusLine, command: LOADER_COMMAND };
    writeJsonWithBackup(settingsFile, settings);
  }
  return true;
}

export function fixStatusline(root = process.cwd(), { dryRun = false } = {}) {
  const file = projectStatusline(root);
  if (!fs.existsSync(file)) {
    // No ruflo helpers directory at all = not a ruflo-initialized location
    // (e.g. ~/.claude): nothing to patch, which is not a defect.
    return { file, applied: false, absent: !fs.existsSync(path.dirname(file)),
      reason: 'no statusline.cjs (created by ruflo init)', versionRepair: null, versionAhead: null };
  }

  // Refresh Ruflo's helpers first so the signed copy is current and stamped. dryRun (status)
  // stays read-only — helperStampStale() and statuslineVersionAhead() report there.
  const version = dryRun ? { versionRepair: null, versionAhead: null } : refreshHelpersBeforeInjection(root);

  // Ruflo 3.51+ restores any edit to statusline.cjs (signed manifest), so the kit never writes
  // there: strip what an older ak injected, then install the loader and footer beside it.
  const restored = restoreSignedHelper(file, fs.readFileSync(file, 'utf8'), dryRun);
  if (restored.failed) return { file, applied: false, reason: restored.failed, ...version };
  let wroteFooter; let wroteLoader; let wired;
  try {
    wroteFooter = writeIfChanged(projectStatuslineFooter(root), footerSource(), dryRun);
    wroteLoader = writeIfChanged(projectStatuslineLoader(root), loaderSource(), dryRun);
    wired = wireStatusLine(root, dryRun);
  } catch (error) {
    // A helpers folder ak cannot write to must not abort sync: report it and keep going.
    return { file, applied: restored.changed, reason: `cannot write the kit statusline files (${error.code ?? error.message})`, ...version };
  }

  return { file, applied: restored.changed || wroteFooter || wroteLoader || wired, repointed: wired, ...version };
}
