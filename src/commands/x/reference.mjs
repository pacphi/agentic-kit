// x reference — inspect (diff) or reconcile (sync) every managed host-guidance target.
import { reconcileGuidance } from '../../lib/blocks.mjs';
import { loadKitConfig } from '../../lib/config.mjs';
import { ok, warn, dim } from '../../lib/output.mjs';

export const options = { json: { type: 'boolean', default: false } };

export const help = `ak x reference — inspect or reconcile managed host guidance

Subcommands:
  diff   (default) show what sync would change; touches nothing
  sync   upsert/strip the managed blocks to match the templates

Options:
  --json   emit the per-block result as JSON

Examples:
  ak x reference          preview drift
  ak x reference sync      write the blocks`;

export async function run({ flags, positionals, pkgRoot }) {
  const sub = positionals[0] ?? 'diff';
  const cfg = loadKitConfig();
  const dryRun = sub !== 'sync';
  const res = await reconcileGuidance({
    cwd: process.cwd(), cfg, pkgRoot, dryRun,
  });
  if (flags.json) { console.log(JSON.stringify(res, null, 2)); return 0; }
  for (const r of res) {
    const verb = r.changed ? (dryRun ? `would change: ${r.changed}` : r.changed) : 'in sync';
    (r.changed ? warn : ok)(`${r.label} ${dim('—')} ${verb}`);
  }
  return 0;
}
