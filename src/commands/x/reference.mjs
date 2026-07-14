// x reference — inspect (diff) or reconcile (sync) the managed CLAUDE.md blocks.
import path from 'node:path';
import { registry, syncBlocks } from '../../lib/blocks.mjs';
import { loadKitConfig } from '../../lib/config.mjs';
import { claudeMdPath, home } from '../../lib/paths.mjs';
import { ok, warn, dim } from '../../lib/output.mjs';

export const options = { json: { type: 'boolean', default: false } };

export async function run({ flags, positionals, pkgRoot }) {
  const sub = positionals[0] ?? 'diff';
  const cfg = loadKitConfig();
  const rows = registry(cfg.customBlocks);
  const resolve = (r) => (r.custom
    ? (r.template.startsWith('~/') ? path.join(home, r.template.slice(2)) : r.template)
    : path.join(pkgRoot, 'claude', r.template));

  const dryRun = sub !== 'sync';
  const res = await syncBlocks(claudeMdPath(), rows, resolve, { dryRun });
  if (flags.json) { console.log(JSON.stringify(res, null, 2)); return 0; }
  for (const r of res) {
    const verb = dryRun
      ? { upserted: 'would upsert', stripped: 'would strip', unchanged: 'in sync', 'missing-template': 'TEMPLATE MISSING' }[r.action]
      : { upserted: 'upserted', stripped: 'stripped', unchanged: 'in sync', 'missing-template': 'TEMPLATE MISSING' }[r.action];
    (r.action === 'unchanged' ? ok : warn)(`${r.slug} ${dim('—')} ${verb}`);
  }
  return 0;
}
