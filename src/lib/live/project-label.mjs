import { createHash } from 'node:crypto';

/** Derive a display label from an explicit cwd without retaining path segments. */
export function safeProjectLabel(cwd) {
  if (typeof cwd !== 'string' || !cwd) return 'unknown';
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  const label = normalized.split('/').pop();
  if (!label || label === '.' || label === '..') return 'unknown';
  return label.replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 96) || 'unknown';
}

/** Opaque, deterministic identity derived only from the already-safe display label. */
export function stableProjectKey(project) {
  const label = safeProjectLabel(project);
  const canonical = label.normalize('NFKC').toLocaleLowerCase('en-US');
  return `project:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

/** Host qualification prevents Claude and Codex sessions with the same native id colliding. */
export function canonicalSessionKey(host, sessionId) {
  return `${host}:${sessionId}`;
}
