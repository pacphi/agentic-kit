// Passive adaptation of vidaunited's Node resolution hook:
// https://github.com/ruvnet/ruflo/issues/2885#issuecomment-5867331087
// Enable only with an explicit absolute TRACE_ORT_LOG and NODE_OPTIONS=--import=<this file>.
import * as moduleApi from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'ruvnet/ruflo#2885:issuecomment-5867331087';
const log = process.env.TRACE_ORT_LOG;
const seen = new Set();
let warned = false;

function warn(message) {
  if (warned) return;
  warned = true;
  try { process.stderr.write(`[trace-ort] ${message}\n`); } catch { /* observation is best effort */ }
}

function append(record) {
  try {
    fs.appendFileSync(log, `${JSON.stringify({ schema: 1, pid: process.pid, ...record })}\n`, { flag: 'a' });
  } catch {
    warn('log unavailable; trace artifact is incomplete');
  }
}

function packageAt(file) {
  const parts = path.normalize(file).split(path.sep);
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] !== 'node_modules') continue;
    const first = parts[i + 1];
    const scoped = first === '@huggingface' || first === '@xenova';
    const name = scoped ? `${first}/${parts[i + 2]}` : first;
    if (!['@huggingface/transformers', '@xenova/transformers', 'onnxruntime-node'].includes(name)) continue;
    const end = i + (scoped ? 3 : 2);
    if (parts.length <= end) continue;
    return { name, root: parts.slice(0, end).join(path.sep) || path.sep };
  }
  return null;
}

function versionAt(root) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return typeof metadata.version === 'string' && metadata.version.length <= 128 && metadata.version.length > 0
      ? metadata.version : 'unknown';
  } catch { return 'unknown'; }
}

function note(url) {
  if (!url?.startsWith('file:')) return;
  const found = packageAt(fileURLToPath(url));
  if (!found || seen.has(found.root)) return;
  seen.add(found.root);
  const rootTruncated = found.root.length > 4096;
  append({ type: 'package', name: found.name, version: versionAt(found.root),
    root: found.root.slice(0, 4096), ...(rootTruncated ? { rootTruncated: true } : {}) });
}

if (typeof log !== 'string' || !path.isAbsolute(log)) {
  warn('log target missing or relative; set absolute TRACE_ORT_LOG');
} else if (typeof moduleApi.registerHooks !== 'function') {
  warn('Node module.registerHooks unavailable; requires Node 22.15 or newer');
} else {
  append({ type: 'start', hook: 'trace-ort/1', source: SOURCE, node: process.version,
    platform: process.platform, arch: process.arch });
  try {
    moduleApi.registerHooks({
      resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        try { note(result.url); } catch { warn('resolution observation failed; trace artifact is incomplete'); }
        return result;
      },
    });
  } catch { warn('hook registration failed; trace artifact is incomplete'); }
}
