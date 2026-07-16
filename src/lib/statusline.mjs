// Statusline healing — port of ruflo-fix-statusline-version:
//   (a) refresh the hard-coded fallback version string (3.28+ resolves live
//       versions itself, #2221; any legacy kit probe marker is stripped),
//   (b) inject/re-inject the kit's activation footer (ruflo-seg block),
//   (c) legacy repoint: projects initialized under aqe <3.12.1 may still have
//       settings.json statusLine aimed at the minimal statusline-v3.cjs.
// CRLF-safe: operates on normalized text, re-emits the file's dominant ending.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { projectStatusline, projectSettings, rufloCliDist } from './paths.mjs';
import { installedVersion } from './versions.mjs';
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

export function fixStatusline(root = process.cwd(), { dryRun = false } = {}) {
  const file = projectStatusline(root);
  if (!fs.existsSync(file)) return { file, applied: false, reason: 'no statusline.cjs (created by ruflo init)' };

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
  const securityOverlay = upstreamCveCounterFabricated();
  const lines = s.split('\n');
  const at = lines[0]?.startsWith('#!') ? 1 : 0;
  lines.splice(at, 0, securityOverlay ? footer + '\n' + SEC_WRAP : footer);
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
