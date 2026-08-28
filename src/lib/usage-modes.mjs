// usage-modes.mjs — the cross-host permission-posture taxonomy (ADR-0038).
// One closed vocabulary; every mapping is a recorded judgment call pinned by
// tests. An unmapped raw value is null (not recorded), NEVER a guess.
export const MODES = ['guarded', 'auto-edit', 'plan', 'unrestricted'];

const CC = { default: 'guarded', acceptEdits: 'auto-edit', auto: 'auto-edit', dontAsk: 'auto-edit', plan: 'plan', bypassPermissions: 'unrestricted' };
const OC = { build: 'auto-edit', plan: 'plan' };

function codexMode(approval, sandbox) {
  if (sandbox === 'read-only') return 'plan';
  if (approval === 'never' && sandbox === 'danger-full-access') return 'unrestricted';
  if (approval === 'never' && sandbox === 'workspace-write') return 'auto-edit';
  // Approval evidence alone is sufficient for 'guarded' — human-in-the-loop is the posture;
  // sandbox evidence is not required (ADR-0038 ruling).
  if (['on-request', 'on-failure', 'untrusted'].includes(approval)) return 'guarded';
  return null;
}

export function normalizeMode({ host, permissionMode, approvalPolicy, sandboxPolicy, opencodeMode } = {}) {
  if (host === 'claude' && typeof permissionMode === 'string') {
    return { mode: CC[permissionMode] ?? null, raw: permissionMode };
  }
  if (host === 'codex' && (approvalPolicy || sandboxPolicy)) {
    const raw = [approvalPolicy, sandboxPolicy].filter(Boolean).join('/');
    return { mode: codexMode(approvalPolicy, sandboxPolicy), raw };
  }
  if (host === 'opencode' && typeof opencodeMode === 'string') {
    return { mode: OC[opencodeMode] ?? null, raw: opencodeMode };
  }
  return { mode: null, raw: null };
}
