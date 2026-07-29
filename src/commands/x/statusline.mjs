import { loadKitConfig, saveKitConfig } from '../../lib/config.mjs';
import {
  PRESETS, applyCodexStatusline, inspectCodexStatusline, projectionFor, removeCodexStatusline,
  statuslineDrift,
} from '../../lib/codex-statusline.mjs';
import { ok, info, warn } from '../../lib/output.mjs';

export const options = {
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

export const help = `ak x statusline — manage native host status lines

Codex's native status line is user-scoped and applies to newly started
sessions. It cannot display command-backed ruflo/SONA/AQE segments.

Usage:
  ak x statusline status
  ak x statusline codex native
  ak x statusline codex extended
  ak x statusline codex off

Options:
  --dry-run   describe the change without writing config.toml or kit.json
  --json      emit status as JSON

Examples:
  ak x statusline codex native
  ak x statusline status
  ak x statusline codex off --dry-run`;

export async function run({ flags, positionals }) {
  const cfg = loadKitConfig();
  const [target = 'status', choice] = positionals;
  if (target === 'status') {
    const current = inspectCodexStatusline();
    const drift = statuslineDrift(cfg);
    const result = { ownership: cfg.statusline?.codex ?? null, current, drifted: drift.drifted };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else if (cfg.statusline?.codex) {
      info(`codex: managed ${cfg.statusline.codex.preset} preset (${!current.valid ? current.error : drift.drifted ? 'drifted' : 'current'})`);
    } else {
      info(`codex: unmanaged${current.values?.status_line ? ' native status line detected' : ''}`);
    }
    return 0;
  }
  if (target !== 'codex' || !choice) {
    warn('usage: ak x statusline status | codex native | codex extended | codex off');
    return 2;
  }
  if (choice === 'off') {
    if (!cfg.statusline?.codex) { info('codex status line is not managed by agentic-kit'); return 0; }
    if (flags['dry-run']) { info('[dry-run] release Codex status-line ownership and remove unchanged managed keys'); return 0; }
    let result;
    try { result = removeCodexStatusline(cfg.statusline.codex.lastProjection); }
    catch (error) {
      warn(`Codex config was not changed; ownership retained: ${error.message}`);
      return 1;
    }
    cfg.statusline.codex = null;
    saveKitConfig(cfg);
    ok(`codex status-line management disabled${result.changed ? '; unchanged managed keys removed' : '; user-modified keys preserved'}`);
    return 0;
  }
  if (!PRESETS[choice]) { warn(`unknown preset '${choice}' (expected native, extended, or off)`); return 2; }
  if (flags['dry-run']) { info(`[dry-run] apply Codex ${choice} preset at user scope`); return 0; }
  // Persist ownership first. If the TOML merge then fails, sync retains enough
  // intent to report/retry it; the inverse ordering could mutate config.toml
  // and then lose ownership when saving kit.json fails.
  cfg.statusline.codex = { preset: choice, lastProjection: projectionFor(choice) };
  saveKitConfig(cfg);
  let result;
  try { result = applyCodexStatusline(choice); }
  catch (error) {
    warn(`Codex status-line ownership recorded, but config was not changed: ${error.message}`);
    return 1;
  }
  ok(`codex ${choice} status line ${result.changed ? 'applied' : 'already current'} — restart Codex sessions to see it`);
  return 0;
}
