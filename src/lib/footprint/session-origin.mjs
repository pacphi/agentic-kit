// Explicit host declarations only. The same Desktop origin can belong to any
// Git repository/worktree/folder. SDK, app-server and vscode are ambiguous.
const CLAUDE_DESKTOP = new Set(['claude-desktop', 'claude-desktop-3p', 'remote_desktop']);
const CODEX_DESKTOP = new Set(['Codex Desktop', 'codex_work_desktop']);

/** Classify one bounded transcript head; never retain arbitrary metadata. */
export function transcriptSessionOrigin(lines, host) {
  for (const line of lines ?? []) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    if (host === 'codex' && record.type === 'session_meta') {
      const value = record.payload?.originator;
      return CODEX_DESKTOP.has(value)
        ? { origin: 'codex-desktop', evidence: `session_meta.originator:${value}` }
        : { origin: 'unknown', evidence: 'desktop-origin-not-declared' };
    }
    if (host === 'claude' && typeof record.entrypoint === 'string') {
      return CLAUDE_DESKTOP.has(record.entrypoint)
        ? { origin: 'claude-desktop', evidence: `entrypoint:${record.entrypoint}` }
        : { origin: 'unknown', evidence: 'desktop-origin-not-declared' };
    }
  }
  return { origin: 'unknown', evidence: 'desktop-origin-not-declared' };
}
