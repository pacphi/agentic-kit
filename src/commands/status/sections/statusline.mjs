// Three related statusline surfaces, none of which had their own try/catch in
// the original monolith: the project footer, the Codex native line, and an
// opencode informational note. Grouped in one
// section (they share the "statusline" family of subsystem tags) but split
// into small functions so each stays readable and under the CC budget.
import fs from 'node:fs';
import * as paths from '../../../lib/paths.mjs';
import {
  fixStatusline, commandUsesLoader, statuslineVersionAhead,
  helperRefreshBlocker, bakedVersionManualFix,
} from '../../../lib/statusline.mjs';
import { readJson } from '../../../lib/settings.mjs';
import { statuslineDrift } from '../../../lib/codex-statusline.mjs';
import { row } from '../row.mjs';

function footerRows(cwd) {
  const sl = paths.projectStatusline(cwd);
  if (!fs.existsSync(sl)) {
    return [row('statusline', 'info', 'no project statusline here (created by setup)')];
  }
  // Ruflo 3.51+ signs statusline.cjs and restores any edit to it, so the kit's footer lives in
  // a loader beside it. Drift is "would a sync CHANGE anything?", which fixStatusline's dry run
  // answers exactly: a missing or stale loader or footer, an older injection still inside the
  // signed helper, or a Ruflo-owned statusLine command that does not run the loader yet.
  let wouldChange = true;
  try { wouldChange = fixStatusline(cwd, { dryRun: true }).applied; } catch { /* report drift */ }
  const rows = [wouldChange ? driftRow(sl) : wiredRow(cwd)];
  rows.push(...versionRows(cwd));
  return rows;
}

const FIX = 'sync installs the kit loader, restores Ruflo\'s helper and points statusLine at it';

function driftRow(sl) {
  const injected = /ruflo-(seg|bin):BEGIN/.test(fs.readFileSync(sl, 'utf8'));
  return row('statusline', 'warn',
    injected
      ? 'footer was injected into Ruflo\'s signed helper, which Ruflo restores on its next call'
      : 'statusline present but footer missing',
    FIX);
}

// Converged files are not enough: a custom statusLine command never runs the loader.
function wiredRow(cwd) {
  const command = readJson(paths.projectSettings(cwd))?.statusLine?.command;
  if (commandUsesLoader(command)) return row('statusline', 'ok', 'activation footer present and current');
  return row('statusline', 'warn',
    'the footer loader is installed, but this project\'s statusLine command does not run it',
    'point statusLine.command in .claude/settings.json at .claude/helpers/ak-statusline.cjs', { repair: 'manual' });
}

// Ruflo's helper renders the HIGHEST of its baked floor and every install it
// finds, so a baked version above everything installed shows a Ruflo version
// that is not installed, forever. Sync repairs it only through Ruflo's own
// helper refresh; when that refresh cannot run here the repair is manual.
function versionRows(cwd) {
  let ahead = null;
  try { ahead = statuslineVersionAhead(cwd); } catch { /* best-effort */ }
  if (!ahead) return [];
  const shows = `statusline shows Ruflo v${ahead.baked}, but installed ruflo is v${ahead.installed}`;
  const blocker = helperRefreshBlocker(cwd);
  if (blocker) {
    return [row('statusline', 'warn', `${shows}; ruflo's helper refresh cannot regenerate it (${blocker})`,
      bakedVersionManualFix(ahead.installed), { repair: 'manual' })];
  }
  return [row('statusline', 'warn', shows,
    'sync regenerates the helper through ruflo\'s own refresh, then re-injects the footer')];
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
