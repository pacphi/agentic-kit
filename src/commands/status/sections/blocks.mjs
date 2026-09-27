// guidance-file blocks (dry-run reconcile = drift report). Three targets
// (guidanceTargets): machine-wide ~/.claude/CLAUDE.md (claude), the project
// <cwd>/AGENTS.md (agents), and — only when ~/.codex exists — machine-wide
// ~/.codex/AGENTS.md (agents-user). The dual-mode block is gated on both hosts
// being enabled (flag detector), so the agents targets stay unmanaged/quiet
// until dual mode is on. retiredForTarget force-strips re-scoped blocks (the
// migration path that clears the dual block from any project AGENTS.md).
//
// Drift is read from the writer's own dry run (blocks.mjs reconcileGuidance
// with sync's exact context), never from a re-built loop: a status reader that
// evaluates detectors with less kit.json intent than sync reports drift sync
// will never act on (#237).
import { reconcileGuidance } from '../../../lib/blocks.mjs';
import { guidanceContext } from '../../../lib/providers.mjs';
import { row } from '../row.mjs';

export default {
  id: 'blocks',
  async collect({ cfg, cwd, pkgRoot }) {
    const rows = [];
    try {
      for (const t of await reconcileGuidance({ cwd, cfg, pkgRoot, context: guidanceContext(cfg), dryRun: true })) {
        const drift = t.results.filter((r) => r.action === 'upserted' || r.action === 'stripped');
        const missing = t.results.filter((r) => r.action === 'missing-template');
        // The agents targets are unmanaged on single-host setups — stay quiet
        // unless there's actual drift (e.g. a block to strip after disabling dual
        // mode) or a missing template. Only the claude target always reports.
        if (t.name !== 'claude' && drift.length === 0 && missing.length === 0) continue;
        if (drift.length) {
          rows.push(row('blocks', 'warn',
            `${drift.length} ${t.label} block(s) drifted: ${drift.map((d) => `${d.slug}→${d.action}`).join(', ')}`,
            'sync reconciles blocks'));
        } else {
          rows.push(row('blocks', 'ok', `${t.label} managed blocks in sync (${t.results.length} in registry)`));
        }
        for (const m of missing) rows.push(row('blocks', 'warn', `template missing for block '${m.slug}'`));
      }
    } catch (e) {
      rows.push(row('blocks', 'warn', `block check unavailable: ${e.message}`));
    }
    return rows;
  },
};
