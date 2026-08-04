import fs from 'node:fs';
import path from 'node:path';
import { safeProjectKey, safeProjectLabel } from './project-label.mjs';

const SESSION_KEY = /^(?:claude|codex|opencode):[A-Za-z0-9._:@-]{1,256}$/;
const WORKSPACE_KEY = /^workspace:[a-f0-9]{16}$/;
const SECRET_SHAPE = /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:secret|token|password|api[_-]?key)[=:][^/\s]{8,})/gi;
const text = (value, max) => typeof value === 'string' && value
  ? value.slice(0, max) : null;
const number = (value) => Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
const identifier = (value) => typeof value === 'string'
  && /^[A-Za-z0-9._:@-]{1,256}$/.test(value) ? value : null;
const clone = (value) => JSON.parse(JSON.stringify(value));
const workspaceText = (value, max, { pathLike = false, leaf = false } = {}) => {
  if (typeof value !== 'string') return null;
  const clean = [...value].filter((character) => {
    const code = character.codePointAt(0);
    return code != null && code > 31 && code !== 127;
  }).join('').replace(SECRET_SHAPE, '…redacted').trim();
  if (!clean || (leaf && /[/\\]/.test(clean))) return null;
  if (pathLike && (/^(?:[/\\]|[A-Za-z]:[/\\])/.test(clean)
    || clean.split(/[/\\]/).includes('..'))) return null;
  return clean.slice(0, max);
};

function safeWorkspace(value) {
  if (!value || typeof value !== 'object') return null;
  const capturedMs = Date.parse(value.capturedAt ?? '');
  if (!Number.isFinite(capturedMs)) return null;
  const capturedAt = new Date(capturedMs).toISOString();
  const changes = value.changes && typeof value.changes === 'object' ? {
    additions: number(value.changes.additions), deletions: number(value.changes.deletions),
    files: number(value.changes.files), binaryFiles: number(value.changes.binaryFiles),
    basis: value.changes.basis === 'tracked-vs-head' ? value.changes.basis : null,
    completeness: text(value.changes.completeness, 80),
    capturedAt: Number.isFinite(Date.parse(value.changes.capturedAt ?? ''))
      ? new Date(value.changes.capturedAt).toISOString() : capturedAt,
  } : null;
  return {
    key: WORKSPACE_KEY.test(value.key ?? '') ? value.key : null,
    repositoryLabel: workspaceText(value.repositoryLabel, 96, { leaf: true }),
    directoryLabel: workspaceText(value.directoryLabel, 180, { pathLike: true }),
    branchLabel: workspaceText(value.branchLabel, 160, { pathLike: true }),
    branchState: ['attached', 'detached', 'unborn', 'unknown'].includes(value.branchState)
      ? value.branchState : 'unknown',
    changes, capturedAt, source: text(value.source, 48),
    confidence: ['observed', 'configured', 'correlated', 'inferred', 'unknown']
      .includes(value.confidence) ? value.confidence : 'unknown',
  };
}

function safeRecord(value) {
  if (!value || typeof value !== 'object' || !SESSION_KEY.test(value.sessionKey ?? '')) return null;
  const workspace = safeWorkspace(value.workspace);
  if (!workspace) return null;
  return {
    sessionKey: value.sessionKey, sessionId: identifier(value.sessionId),
    parentSessionId: identifier(value.parentSessionId),
    host: ['claude', 'codex', 'opencode'].includes(value.host) ? value.host : null,
    project: safeProjectLabel(value.project),
    projectKey: safeProjectKey(value.projectKey, value.project), workspace,
  };
}

/** Last recorded safe workspace snapshot per session, persisted with mode 0600. */
export class WorkspaceSnapshotStore {
  #file;
  #limit;
  #records = new Map();

  constructor(file, { limit = 500 } = {}) {
    this.#file = file;
    this.#limit = Math.max(1, limit);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { parsed = null; }
    for (const raw of Array.isArray(parsed?.sessions) ? parsed.sessions : []) {
      const record = safeRecord(raw);
      if (record) this.#records.set(record.sessionKey, record);
    }
  }

  records() { return clone([...this.#records.values()]); }

  remember(record) {
    const safe = safeRecord(record);
    if (!safe) return false;
    const prior = this.#records.get(safe.sessionKey);
    const fingerprint = (value) => JSON.stringify({
      ...value.workspace, capturedAt: null,
      changes: value.workspace.changes
        ? { ...value.workspace.changes, capturedAt: null } : null,
    });
    if (prior && fingerprint(prior) === fingerprint(safe)) return false;
    this.#records.set(safe.sessionKey, safe);
    while (this.#records.size > this.#limit) {
      const oldest = [...this.#records.values()].sort((a, b) =>
        Date.parse(a.workspace.capturedAt) - Date.parse(b.workspace.capturedAt))[0];
      if (!oldest) break;
      this.#records.delete(oldest.sessionKey);
    }
    this.#flush();
    return true;
  }

  forget(sessionKey) {
    if (!this.#records.delete(sessionKey)) return false;
    this.#flush();
    return true;
  }

  #flush() {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      const sessions = [...this.#records.values()].map(safeRecord).filter(Boolean);
      fs.writeFileSync(temporary, `${JSON.stringify({
        schemaVersion: 1, sessions,
      }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.#file);
      fs.chmodSync(this.#file, 0o600);
    } catch { /* persistence is advisory; live telemetry continues */ }
  }
}
