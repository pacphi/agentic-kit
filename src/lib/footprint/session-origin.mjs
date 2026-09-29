import { classifySessionSurface } from '../session-surface.mjs';

// Compatibility origin is retained for existing project and usage consumers.
// It only names a local desktop application; remote_desktop is a cloud session.
const desktopOrigin = (surface) => surface === 'claude-desktop' ? 'claude-desktop'
  : surface === 'chatgpt-desktop-codex' || surface === 'chatgpt-desktop-work' ? 'codex-desktop' : 'unknown';

function adapted(classification, evidence) {
  const origin = desktopOrigin(classification.surface);
  const legacy = { origin, evidence: origin === 'unknown' ? 'desktop-origin-not-declared' : evidence };
  // Accessors expose the new dimensions without changing the serialized legacy
  // sessionOrigin shape (or the usage cache) before parser integration.
  for (const [key, value] of Object.entries(classification)) {
    Object.defineProperty(legacy, key, { value, enumerable: false });
  }
  return legacy;
}

/** Classify one bounded transcript head; never retain arbitrary metadata. */
export function transcriptSessionOrigin(lines, host) {
  for (const line of lines ?? []) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    if (host === 'codex' && record.type === 'session_meta') {
      const payload = record.payload ?? {};
      return adapted(classifySessionSurface({ host, originator: payload.originator,
        source: payload.source, threadSource: payload.thread_source }),
      `session_meta.originator:${payload.originator}`);
    }
    if (host === 'claude' && typeof record.entrypoint === 'string') {
      return adapted(classifySessionSurface({ host, entrypoint: record.entrypoint,
        sessionKind: record.sessionKind }), `entrypoint:${record.entrypoint}`);
    }
  }
  return adapted(classifySessionSurface({ host }), 'desktop-origin-not-declared');
}
