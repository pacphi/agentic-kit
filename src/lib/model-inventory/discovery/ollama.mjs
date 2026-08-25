import { run } from '../../exec.mjs';
import {
  MAX_COMMAND_BYTES, MAX_MODELS, diagnostic, modelRecord, sourceRecord,
} from './index.mjs';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/;

export function discoverOllama({ raw, capturedAt, scope = {}, scopeKey } = /** @type {any} */ ({})) {
  const text = String(raw ?? '');
  const source = sourceRecord({ id: 'ollama-catalog', owner: 'ollama', scope, scopeKey, capturedAt, complete: true, schema: 'ollama-ls-v1' });
  if (Buffer.byteLength(text) > MAX_COMMAND_BYTES) {
    source.complete = false;
    source.status = 'unsupported';
    source.diagnostics = ['output-too-large'];
    return { status: 'unsupported', source, models: [], diagnostics: [diagnostic('output-too-large', `output exceeds ${MAX_COMMAND_BYTES}`)] };
  }
  const diagnostics = [];
  const models = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    if (index === 0 && /^NAME\s+ID\s+/i.test(line)) continue;
    const [modelId, digest] = line.trim().split(/\s+/);
    if (!TOKEN.test(modelId ?? '') || !/^[a-f0-9]{6,128}$/i.test(digest ?? '')) {
      diagnostics.push(diagnostic('invalid-model-row', `line ${index + 1} is invalid`));
      continue;
    }
    if (models.length >= MAX_MODELS) break;
    models.push(modelRecord({
      host: null, provider: 'ollama', modelId, scopeId: source.scopeId, source,
      variant: { digest }, states: { discoverable: true, entitled: 'unknown', routable: 'unknown' },
    }));
  }
  const complete = diagnostics.length === 0 && models.length < MAX_MODELS;
  source.complete = complete;
  source.status = complete ? 'complete' : 'partial';
  source.diagnostics = diagnostics.map(({ code }) => code);
  return { status: complete ? 'complete' : 'partial', source, models, diagnostics };
}

export async function collectOllama({
  runner = run, capturedAt, scope = {}, scopeKey, timeout = 15_000,
} = /** @type {any} */ ({})) {
  const result = await runner('ollama', ['ls'], { timeout, maxBuffer: MAX_COMMAND_BYTES, shell: false });
  if (result.code !== 0) {
    const source = sourceRecord({ id: 'ollama-catalog', owner: 'ollama', scope, scopeKey, capturedAt, complete: false, status: 'unavailable', schema: 'ollama-ls-v1', diagnostics: ['command-failed'] });
    return { status: 'unavailable', source, models: [], diagnostics: [diagnostic('command-failed', result.stderr || 'ollama list failed')] };
  }
  return discoverOllama({ raw: result.stdout, capturedAt, scope, scopeKey });
}
