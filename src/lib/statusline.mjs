// Statusline healing — port of ruflo-fix-statusline-version:
//   (a) refresh the hard-coded fallback version string (3.28+ resolves live
//       versions itself, #2221; any legacy kit probe marker is stripped),
//   (b) inject/re-inject the kit's activation footer (ruflo-seg block),
//   (c) legacy repoint: projects initialized under aqe <3.12.1 may still have
//       settings.json statusLine aimed at the minimal statusline-v3.cjs.
// CRLF-safe: operates on normalized text, re-emits the file's dominant ending.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { projectStatusline, projectSettings, rufloCliDist, rufloNodeModules } from './paths.mjs';
import { installedVersion, cmpVersions } from './versions.mjs';
import { readJson, writeJsonWithBackup } from './settings.mjs';

const FOOTER_TEMPLATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'statusline-footer.cjs');

const eol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

// Security overlay wrapper. Wraps getStatuslineData() rather than patching
// applyLocalOverlays(), because applyLocalOverlays is NOT on every path: the
// fresh-cache early return (`if (cache.fresh && cache.promoFresh) return
// overlayMemoPromo(cache.data)`) bypasses it, so for the 60s TTL a patched
// applyLocalOverlays is simply never called and the fabricated count renders
// anyway (verified empirically — the overlay had no effect until this wrapper).
// Wrapping the single entry point covers all four return paths (CLI delegation,
// fresh cache, stale-while-revalidate, local fallback) with one injection.
//
// Relies on function-declaration hoisting: `function getStatuslineData()` is
// initialized before any top-level code runs, so this block — injected near the
// top of the file — can reassign the binding, and the later declaration does not
// re-execute and clobber it. The typeof guard keeps it inert on any template that
// lacks the function (e.g. the minimal statusline-v3.cjs).
const SEC_WRAP = [
  '/* ruflo-sec:BEGIN */',
  'try {',
  '  if (typeof getStatuslineData === "function") {',
  '    var _rufloOrigGetStatuslineData = getStatuslineData;',
  '    getStatuslineData = function(){',
  '      var d = _rufloOrigGetStatuslineData.apply(this, arguments);',
  '      try {',
  '        if (d) {',
  '          d.security = rufloLocalSecurity(process.cwd(), d.security);',
  '          d.promo = rufloHonestInsight(d.promo, d.security);',
  '        }',
  '      } catch(e){}',
  '      return d;',
  '    };',
  '  }',
  '} catch(e){}',
  '/* ruflo-sec:END */',
].join('\n');
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
// Unlike the security overlay there is deliberately NO retirement gate: the wrapper
// only PREPENDS bins verified to exist on disk (rufloRealCliBins, injected with the
// footer) and keeps upstream's own candidates as the tail, so on a fixed upstream it
// converges to the same delegation instead of fighting it. A gate would be one more
// proxy-probe that can misfire — the CVE gate watched the global install while the
// render path executed a stale npx copy. Same function-declaration-hoisting
// mechanism as the security wrapper; typeof-guarded so it is inert on templates
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

/** Upstream defect: ruvnet/ruflo#2694.
 *  True while ruflo's getSecurityStatus() still FABRICATES the CVE count — i.e. the
 *  installed CLI still has `const totalCves = 3` (a hardcoded constant naming ruflo's
 *  own v3 roadmap items, not the rendered project's risk) with cvesFixed derived from
 *  scans.length (a FILE count, not findings). Read-only probe of the installed CLI.
 *
 *  This is the stopgap's self-retirement gate, mirroring improvement-eval's --cli-check
 *  (#2222): detect the defect in shipped code rather than pinning a version number, so
 *  the kit stops patching the moment upstream fixes it — no release-tracking required.
 *  Unreadable/absent/changed => false (fail safe: never patch what we cannot verify is
 *  broken; the worst case is ruflo's own unmodified behavior). */
export function upstreamCveCounterFabricated() {
  try {
    const f = path.join(rufloCliDist(), 'funnel', 'local-signals.js');
    if (!fs.existsSync(f)) return false;
    const src = fs.readFileSync(f, 'utf8');
    return /const totalCves = 3\b/.test(src) && /scans\.length/.test(src);
  } catch { return false; }
}

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
  const mod = helperRefreshModule();
  if (!fs.existsSync(mod)) return false;
  try {
    // A failed import / rejecting refresh exits 1; a BLOCKED refresh — upstream
    // resolves {blocked:'…signature invalid'} rather than rejecting when the
    // signed-manifest gate refuses to copy — exits 2. Both surface as false:
    // "true = the refresh ran unblocked", never "a child spawned". (A resolved
    // {refreshed:false} without blocked is a current-stamp no-op — success.)
    execFileSync(process.execPath, ['-e',
      'import(process.argv[2]).then((m)=>m.autoRefreshHelpersIfStale(process.argv[1],{alsoRefreshGlobal:true})).then((r)=>{if(r&&r.blocked)process.exit(2)},()=>process.exit(1))',
      root, pathToFileURL(mod).href,
    ], { stdio: 'ignore', timeout: timeoutMs });
    return true;
  } catch { return false; }
}

export function fixStatusline(root = process.cwd(), { dryRun = false } = {}) {
  const file = projectStatusline(root);
  if (!fs.existsSync(file)) return { file, applied: false, reason: 'no statusline.cjs (created by ruflo init)' };

  // Order matters: refresh ruflo's helpers BEFORE reading, so we inject onto the
  // freshly-stamped copy and nothing rewrites it until the next ruflo upgrade
  // (where sync repeats this, again under its own control). dryRun (status) must
  // stay read-only — helperStampStale() reports the armed wipe there instead.
  if (!dryRun) refreshRufloHelpers(root);

  const raw = fs.readFileSync(file, 'utf8');
  const ending = eol(raw);
  let s = raw.replace(/\r\n/g, '\n');

  // (a) legacy probe strip + fallback version refresh
  s = s.replace(/ \/\* agentic-kit: global-install version probe \*\/ require\("path"\)\.join\(require\("path"\)\.dirname\(process\.execPath\),"\.\.","lib","node_modules","ruflo","package\.json"\),/, '');
  const ver = installedVersion('ruflo');
  if (ver) s = s.replace(/(let (?:ver|pkgVersion) = )(["'])\d+\.\d+(?:\.\d+)?\2/, `$1$2${ver}$2`);

  // (b) footer injection: strip any prior block/wrap, re-inject after shebang
  const footer = fs.readFileSync(FOOTER_TEMPLATE, 'utf8').replace(/\r\n/g, '\n').trim();
  s = s.replace(/\/\* ruflo-seg:BEGIN \*\/[\s\S]*?\/\* ruflo-seg:END \*\/\n?/, '');
  s = s.replace(/ \+ rufloActivationSegments\(process\.cwd\(\)\)/g, '');
  // (d) security overlay: stripped unconditionally BEFORE the gate is consulted, so the
  //     stopgap retires itself on the first sync after upstream fixes getSecurityStatus.
  s = s.replace(SEC_WRAP_STRIP, '');
  // (e) bin wrapper: stripped unconditionally like the others, re-injected always —
  //     no gate (see BIN_WRAP), it self-neutralizes on a template it doesn't fit.
  s = s.replace(BIN_WRAP_STRIP, '');
  const securityOverlay = upstreamCveCounterFabricated();
  const lines = s.split('\n');
  const at = lines[0]?.startsWith('#!') ? 1 : 0;
  const blocks = [footer];
  if (securityOverlay) blocks.push(SEC_WRAP);
  blocks.push(BIN_WRAP);
  lines.splice(at, 0, blocks.join('\n'));
  s = lines.join('\n');
  s = s.replace(/console\.log\(generateStatusline\(\)\)/, 'console.log(generateStatusline() + rufloActivationSegments(process.cwd()))');

  const out = ending === '\r\n' ? s.replace(/\n/g, '\r\n') : s;
  if (out !== raw && !dryRun) {
    fs.writeFileSync(file, out);
    // syntax gate — a broken statusline is worse than an unpatched one
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' });
    } catch {
      fs.writeFileSync(file, raw); // roll back
      return { file, applied: false, reason: 'injected file failed node --check — rolled back' };
    }
  }

  // (c) legacy statusLine repoint (aqe <3.12.1 era)
  const settingsFile = projectSettings(root);
  const settings = readJson(settingsFile);
  const cmd = settings?.statusLine?.command ?? '';
  let repointed = false;
  if (cmd.includes('statusline-v3.cjs') && !cmd.includes('helpers/statusline.cjs')) {
    if (!dryRun) {
      settings.statusLine = {
        type: 'command',
        command: 'sh -c \'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/statusline.cjs" 2>/dev/null || node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/statusline-v3.cjs" 2>/dev/null || echo "▊ RuFlo + Agentic QE v3"\'',
        refreshMs: settings.statusLine?.refreshMs ?? 5000,
        enabled: true,
      };
      writeJsonWithBackup(settingsFile, settings);
    }
    repointed = true;
  }

  return { file, applied: out !== raw, repointed, version: ver, securityOverlay };
}
