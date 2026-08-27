// guidance-file blocks (dry-run reconcile = drift report). Three targets
// (guidanceTargets): machine-wide ~/.claude/CLAUDE.md (claude), the project
// <cwd>/AGENTS.md (agents), and — only when ~/.codex exists — machine-wide
// ~/.codex/AGENTS.md (agents-user). The dual-mode block is gated on both hosts
// being enabled (flag detector), so the agents targets stay unmanaged/quiet
// until dual mode is on. retiredForTarget force-strips re-scoped blocks (the
// migration path that clears the dual block from any project AGENTS.md).
import path from 'node:path';
import * as paths from '../../../lib/paths.mjs';
import { registry, syncBlocks, blocksForTarget, retiredForTarget, guidanceTargets } from '../../../lib/blocks.mjs';
import { bothHostsEnabled } from '../../../lib/providers.mjs';
import { row } from '../row.mjs';

export default {
  id: 'blocks',
  async collect({ cfg, cwd, pkgRoot }) {
    const rows = [];
    try {
      const rowsReg = registry(cfg.customBlocks);
      const resolve = (r) => (r.custom
        ? (r.template.startsWith('~/') ? path.join(paths.home, r.template.slice(2)) : r.template)
        : path.join(pkgRoot, 'claude', r.template));
      const ctx = { flags: { dualMode: bothHostsEnabled(cfg), opencodeEnabled: !!cfg.integrations?.hosts?.opencode } };
      for (const t of guidanceTargets({ cwd, cfg })) {
        const treg = [...blocksForTarget(rowsReg, t.name), ...retiredForTarget(rowsReg, t.name)];
        const res = await syncBlocks(t.file, treg, resolve, { dryRun: true, context: ctx });
        const drift = res.filter((r) => r.action === 'upserted' || r.action === 'stripped');
        const missing = res.filter((r) => r.action === 'missing-template');
        // The agents targets are unmanaged on single-host setups — stay quiet
        // unless there's actual drift (e.g. a block to strip after disabling dual
        // mode) or a missing template. Only the claude target always reports.
        if (t.name !== 'claude' && drift.length === 0 && missing.length === 0) continue;
        if (drift.length) {
          rows.push(row('blocks', 'warn',
            `${drift.length} ${t.label} block(s) drifted: ${drift.map((d) => `${d.slug}→${d.action.replace('ped', 'p')}`).join(', ')}`,
            'sync reconciles blocks'));
        } else {
          rows.push(row('blocks', 'ok', `${t.label} managed blocks in sync (${res.length} in registry)`));
        }
        for (const m of missing) rows.push(row('blocks', 'warn', `template missing for block '${m.slug}'`));
      }
    } catch (e) {
      rows.push(row('blocks', 'warn', `block check unavailable: ${e.message}`));
    }
    return rows;
  },
};
