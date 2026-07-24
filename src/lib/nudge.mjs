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
import path from 'node:path';
import * as paths from './paths.mjs';
import { registry, syncBlocks, blocksForTarget } from './blocks.mjs';
import { loadKitConfig } from './config.mjs';
import { bothHostsEnabled } from './providers.mjs';
import { codexMcpStatus, rufloCodexMcpStatus } from './mcp.mjs';
import { fixStatusline, helperStampStale } from './statusline.mjs';

/**
 * Probe the locally-rendered artifacts for drift.
 * @param {{ pkgRoot?: string, cwd?: string,
 *           cfg?: { customBlocks?: any[], providers?: any },
 *           targets?: Array<{name: string, label: string, file: string}> }} [opts]
 *   `cfg` and `targets` are injectable for tests; defaults read the real
 *   kit.json and the real CLAUDE.md/AGENTS.md targets.
 * @returns {Promise<string[]>} human phrases, empty when nothing drifted.
 */
export async function localDrift({ pkgRoot, cwd = process.cwd(), cfg, targets } = {}) {
  const lines = [];
  try { cfg = cfg ?? loadKitConfig(); } catch { return lines; }

  // guidance blocks (dry-run reconcile == status.mjs's drift definition)
  try {
    const rowsReg = registry(cfg.customBlocks);
    const resolve = (r) => (r.custom
      ? (r.template.startsWith('~/') ? path.join(paths.home, r.template.slice(2)) : r.template)
      : path.join(pkgRoot, 'claude', r.template));
    const ctx = { flags: { dualMode: bothHostsEnabled(cfg) } };
    const tgs = targets ?? [
      { name: 'claude', label: 'CLAUDE.md', file: paths.claudeMdPath() },
      { name: 'agents', label: 'AGENTS.md', file: path.join(cwd, 'AGENTS.md') },
    ];
    for (const t of tgs) {
      const res = await syncBlocks(t.file, blocksForTarget(rowsReg, t.name), resolve, { dryRun: true, context: ctx });
      const n = res.filter((r) => r.action === 'upserted' || r.action === 'stripped').length;
      if (n) lines.push(`${n} ${t.label} block(s)`);
    }
  } catch { /* best-effort */ }

  // Claude↔Codex MCP bridge (both directions; spawn-free file reads)
  try {
    if (cfg.providers?.hosts?.codex) {
      if (!codexMcpStatus(cfg, cwd).registered) lines.push('codex MCP unregistered');
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
    }
  } catch { /* best-effort */ }

  return lines;
}
