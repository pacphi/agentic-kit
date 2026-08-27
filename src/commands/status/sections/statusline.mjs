// Four related statusline surfaces, none of which had their own try/catch in
// the original monolith: the project footer + its CVE-counter overlay, the
// Codex native line, and an opencode informational note. Grouped in one
// section (they share the "statusline" family of subsystem tags) but split
// into small functions so each stays readable and under the CC budget.
import fs from 'node:fs';
import * as paths from '../../../lib/paths.mjs';
import { upstreamCveCounterFabricated, fixStatusline, helperStampStale } from '../../../lib/statusline.mjs';
import { statuslineDrift } from '../../../lib/codex-statusline.mjs';
import { row } from '../row.mjs';

function footerRows(cwd) {
  const sl = paths.projectStatusline(cwd);
  if (!fs.existsSync(sl)) {
    return [row('statusline', 'info', 'no project statusline here (created by setup)')];
  }
  const slSrc = fs.readFileSync(sl, 'utf8');
  const hasFooter = slSrc.includes('ruflo-seg:BEGIN');
  // Drift is "would a sync CHANGE this file?", which fixStatusline's dry run answers
  // exactly. A marker-presence test alone cannot see CONTENT drift: after a kit upgrade
  // revises the footer or the security overlay, the marker is still there, this row
  // reports 'ok', and — because sync builds its plan from rows carrying a `fix` — the
  // re-injection never runs and the stale block survives indefinitely. Observed live:
  // an updated overlay silently failed to land for exactly this reason.
  let wouldChange = !hasFooter;
  try { wouldChange = fixStatusline(cwd, { dryRun: true }).applied; } catch { /* keep marker fallback */ }
  // Armed wipe: the footer can be present AND current while ruflo's helper
  // stamp lags the installed CLI — the next ruflo command (in practice the
  // daemon start) then pristine-copies statusline.cjs over ours. That is how
  // the footer kept vanishing BETWEEN syncs. Surface it as the same drift
  // story; sync closes it by refreshing the helpers before re-injecting.
  let stampStale = false;
  try { stampStale = helperStampStale(cwd); } catch { /* best-effort */ }
  const rows = [row('statusline', (wouldChange || stampStale) ? 'warn' : 'ok',
    wouldChange
      ? (hasFooter ? 'injected blocks are out of date' : 'statusline present but footer missing')
      : stampStale
        ? 'footer present but ruflo helper stamp is stale — next ruflo command wipes it'
        : 'activation footer present and current',
    (wouldChange || stampStale) ? 'sync refreshes helpers, then re-injects the footer' : null)];
  // The CVE-counter overlay is tracked SEPARATELY from the footer: a footer-only
  // check reports 'ok' while the statusline still renders ruflo's fabricated
  // "⚠ 3 CVEs" (hardcoded totalCves, cvesFixed from a file count). Only warn while
  // the upstream defect is actually present — once ruflo fixes getSecurityStatus
  // the overlay is intentionally absent, and this row must go quiet on its own
  // rather than nag for a patch that is no longer wanted.
  if (upstreamCveCounterFabricated()) {
    const patched = slSrc.includes('ruflo-sec:BEGIN');
    rows.push(row('statusline/cve', patched ? 'ok' : 'warn',
      patched
        ? 'CVE counter overlaid with real scan results'
        : 'statusline shows ruflo\'s fabricated CVE count (upstream defect)',
      patched ? null : 'sync injects the security overlay'));
  }
  return rows;
}

// Codex has a native user-scoped line, but no command-backed rich renderer.
function codexStatuslineRows(cfg) {
  if (!(cfg.integrations?.hosts?.codex || cfg.statusline?.codex)) return [];
  const codexLine = statuslineDrift(cfg);
  if (!codexLine.owned) {
    return [row('codex-statusline', 'info',
      'Codex native status line is unmanaged — opt in with `ak x statusline codex native`')];
  }
  if (codexLine.drifted) {
    return [row('codex-statusline', 'warn',
      `managed Codex ${codexLine.preset} status line has drifted`,
      'sync restores the selected native preset')];
  }
  return [row('codex-statusline', 'ok',
    `managed Codex ${codexLine.preset} native status line is current (rich ruflo/SONA/AQE segments remain Claude-only)`)];
}

export default {
  id: 'statusline',
  async collect({ cfg, cwd }) {
    const rows = [...footerRows(cwd), ...codexStatuslineRows(cfg)];
    if (cfg.integrations?.hosts?.opencode) {
      rows.push(row('statusline', 'info',
        'opencode has no statusline surface; its ruflo lifecycle ships via the plugins/ bridge + AGENTS.md'));
    }
    return rows;
  },
};
