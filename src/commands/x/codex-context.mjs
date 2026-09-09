import { loadKitConfig, saveKitConfig } from '../../lib/config.mjs';
import { inspectCodexContext, manageCodexContext, releaseCodexContext } from '../../lib/codex-context.mjs';
import { info, ok, warn } from '../../lib/output.mjs';

export const options = { 'dry-run': { type: 'boolean', default: false }, json: { type: 'boolean', default: false } };
export const help = `ak x codex-context — manage Codex's native per-model context capacities

Usage: ak x codex-context [status|max|off] [--dry-run] [--json]

max opts in to the fresh native catalog's maximum request. Codex caps that
request for each selected model and reserves its native effective percentage.
Setup and sync maintain this preference. off restores the prior scalar only
while the managed value is unchanged. No native model catalog is rewritten.
Start a new Codex session after applying; API maxima are separate evidence.

Examples:
  ak x codex-context max --dry-run
  ak x codex-context max
  ak x codex-context status --json
  ak x codex-context off`;

export async function run({ flags, positionals, contextOptions = {} }) {
  const choice = positionals[0] ?? 'status';
  if (!['status', 'max', 'off'].includes(choice) || positionals.length > 1) { warn(help); return 2; }
  const cfg = loadKitConfig();
  const status = inspectCodexContext(cfg, contextOptions);
  if (choice === 'status' || flags['dry-run']) {
    if (flags.json) console.log(JSON.stringify({ ...status, plannedAction: choice, dryRun: !!flags['dry-run'] }, null, 2));
    else {
      info(`Codex context: ${status.owned ? 'managed native maximum' : 'unmanaged'}${status.drifted ? ' (drifted)' : ''}`);
      if (!status.available) warn(status.reason);
      for (const m of status.models) info(`${m.model}: ${m.effectiveWindow} effective; native maximum ${m.maximumWindow}`);
      if (choice !== 'status') info(`[dry-run] ${choice}: ${choice === 'max' ? `request ${status.requestedWindow} tokens` : 'restore unchanged owned scalar'}`);
    }
    return choice === 'max' && (!status.available || !cfg.integrations?.hosts?.codex) ? 1 : 0;
  }
  try {
    const result = choice === 'off'
      ? await releaseCodexContext(cfg, { ...contextOptions, persist: saveKitConfig })
      : await manageCodexContext(cfg, { ...contextOptions, enable: true, persist: saveKitConfig });
    if (flags.json) console.log(JSON.stringify({ ...result, status: inspectCodexContext(cfg, contextOptions) }, null, 2));
    else ok(`Codex context ${choice === 'off' ? 'ownership released' : 'native maximum configured'}${result.changed ? ' (config updated)' : ''}; start new Codex sessions`);
    return 0;
  } catch (error) { warn(`Codex context operation incomplete: ${error.message}`); return 1; }
}
