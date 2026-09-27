// Local-drift nudge — the cheap, spawn-free complement to the npm version
// nudge in bin/agentic-kit.mjs. The npm nudge (driftReport) only sees package
// drift; the artifacts ak *renders* — guidance blocks in CLAUDE.md/AGENTS.md,
// the Claude↔Codex MCP registrations, the statusline footer — can drift with
// no version change at all (e.g. a merged PR edits a claude/*.md template on
// an npm-linked dev kit, or a tool re-init rewrites a managed file). Those sat
// silent until `ak status`/`ak sync`; this probe surfaces them after any
// command, in one dim line.
//
// Contract: LOCAL ONLY (file reads + the same declarative detectors status
// uses — no network, no --version spawns), best-effort (every probe is
// individually try/caught; an unreadable file yields no line, never a crash),
// and read-only. Mirrors the exact drift definitions in
// src/commands/status.mjs so the nudge can never disagree with `ak status`.
import fs from 'node:fs';
import * as paths from './paths.mjs';
import { reconcileGuidance, guidanceTargets } from './blocks.mjs';
import { loadKitConfig } from './config.mjs';
import { guidanceContext } from './providers.mjs';
import { codexMcpStatus, rufloCodexMcpStatus } from './mcp.mjs';
import { fixStatusline, helperStampStale, statuslineVersionAhead, helperRefreshBlocker } from './statusline.mjs';

/**
 * Probe the locally-rendered artifacts for drift.
 * @param {{ pkgRoot?: string, cwd?: string,
 *           cfg?: { customBlocks?: any[], providers?: any, integrations?: { hosts?: Record<string, boolean> } },
 *           targets?: Array<{name: string, label: string, file: string}> }} [opts]
 *   `cfg` and `targets` are injectable for tests; defaults read the real
 *   kit.json and the real CLAUDE.md/AGENTS.md targets.
 * @returns {Promise<string[]>} human phrases, empty when nothing drifted.
 */
export async function localDrift({ pkgRoot, cwd = process.cwd(), cfg, targets } = {}) {
  const lines = [];
  try { cfg = cfg ?? loadKitConfig(); } catch { return lines; }

  // guidance blocks: the writer's own dry run (blocks.mjs reconcileGuidance
  // with sync's exact context) — the same source `ak status` reads, so the
  // nudge can never report drift sync would not act on (#237). kit.json intent
  // also answers the `enabled` detectors, so no PATH probe runs here.
  try {
    const tgs = targets ?? guidanceTargets({ cwd, cfg });
    for (const t of await reconcileGuidance({
      cwd, cfg, pkgRoot, context: guidanceContext(cfg), dryRun: true, targets: tgs,
    })) {
      const n = t.results.filter((r) => r.action === 'upserted' || r.action === 'stripped').length;
      if (n) lines.push(`${n} ${t.label} block(s)`);
    }
  } catch { /* best-effort */ }

  // Cross-host integration (spawn-free file reads). The retired Claude→Codex
  // MCP is drift only when still present; Ruflo-in-Codex remains required.
  try {
    if (cfg.integrations?.hosts?.codex) {
      if (codexMcpStatus(cfg, cwd).registered) lines.push('deprecated codex MCP registered');
      if (!rufloCodexMcpStatus(cfg).registered) lines.push('ruflo→codex MCP unregistered');
    }
  } catch { /* best-effort */ }

  // statusline footer (dry run skips the helper-refresh subprocess)
  try {
    if (fs.existsSync(paths.projectStatusline(cwd))) {
      let wouldChange = false, stampStale = false;
      try { wouldChange = fixStatusline(cwd, { dryRun: true }).applied; } catch { /* keep false */ }
      try { stampStale = helperStampStale(cwd); } catch { /* keep false */ }
      if (wouldChange) lines.push('statusline footer');
      else if (stampStale) lines.push('statusline helper stamp');
      // Only while sync can repair it: with Ruflo's refresh blocked the fix is a manual edit.
      try { if (statuslineVersionAhead(cwd) && !helperRefreshBlocker(cwd)) lines.push('statusline Ruflo version'); } catch { /* keep quiet */ }
    }
  } catch { /* best-effort */ }

  return lines;
}
