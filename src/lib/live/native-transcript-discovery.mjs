import fs from 'node:fs';
import path from 'node:path';

const safeEntries = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
};

/**
 * @param {string} root
 * @param {{ maxDepth: number, maxFiles: number, accept: (name: string) => boolean,
 *           sinceMs?: number|null }} options sinceMs, when given, drops any file whose
 *   mtime is older than that epoch-ms cutoff — used for date-windowed history scans.
 *   Omit/null (the default) preserves the unfiltered recency-only behavior every
 *   existing caller (the live tailer, project-discovery) relies on.
 */
export function discoverJsonl(root, { maxDepth, maxFiles, accept, sinceMs = null }) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth || found.length >= 4096) return;
    for (const entry of safeEntries(dir)) {
      if (found.length >= 4096) break;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && accept(entry.name)) {
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* no ordering evidence */ }
        if (sinceMs != null && mtimeMs < sinceMs) continue;
        found.push({ file, mtimeMs });
      }
    }
  };
  visit(root, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles).map((entry) => entry.file);
}

/**
 * Read bounded transcript head and tail windows, then keep only identity and
 * runtime metadata records. Message content never leaves the adapter boundary.
 */
export function bootstrapRecords(file, adapter) {
  let source;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const total = fs.fstatSync(fd).size;
      const headSize = Math.min(total, 64 * 1024);
      const tailSize = Math.min(total, 128 * 1024);
      const head = Buffer.alloc(headSize);
      const tail = Buffer.alloc(tailSize);
      fs.readSync(fd, head, 0, headSize, 0);
      fs.readSync(fd, tail, 0, tailSize, Math.max(0, total - tailSize));
      source = `${head.toString('utf8')}\n${tail.toString('utf8')}`;
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const records = [];
  const lines = source.split('\n');
  for (const line of [...lines.slice(0, 256), ...lines.slice(-256)]) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (adapter === 'codex' && ['session_meta', 'turn_context'].includes(record?.type)) {
      records.push(record);
    } else if (adapter === 'claude'
      && ['user', 'assistant'].includes(record?.type)
      && (record.sessionId || record.cwd || record.message?.model)) {
      records.push(record);
    }
  }
  const deduped = new Map();
  for (const record of records) {
    const key = `${record.type}|${record.sessionId ?? record.payload?.id ?? ''}|${record.timestamp ?? ''}`;
    deduped.set(key, record);
  }
  const values = [...deduped.values()];
  return values.length <= 32 ? values : [...values.slice(0, 16), ...values.slice(-16)];
}

export function codexTranscriptId(file) {
  return path.basename(file, '.jsonl')
    .replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '');
}
