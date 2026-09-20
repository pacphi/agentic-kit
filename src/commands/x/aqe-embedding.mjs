import { loadKitConfig, saveKitConfig } from '../../lib/config.mjs';
import { embeddingIntentFromFlags, embeddingSetupDisclosure } from '../../lib/aqe-embedding-setup.mjs';
import { prepareAqeEmbedding, AQE_EMBEDDING_COACHING } from '../../lib/aqe-embedding-lifecycle.mjs';
import { inspectAqeEmbeddingProjections, reconcileAqeEmbeddingProjections } from '../../lib/aqe-embedding-projection.mjs';
import { reconcileOpencodeAqeEmbedding } from '../../lib/opencode-core.mjs';

export const options = {
  'aqe-embedding-mode': { type: 'string' }, 'aqe-embedding-endpoint': { type: 'string' },
  yes: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};
export const help = `ak x aqe-embedding — select, prepare and inspect AQE embeddings

Usage: ak x aqe-embedding [status|configure|prepare|verify] [options]

  configure    preview the selected backend; --yes saves and prepares it
  prepare      repair selected local model and project environment; requires --yes
  verify       synthetic backend proof only; no downloads or corpus writes
  status       offline intent and projection observations

Options:
  --aqe-embedding-mode local|endpoint|in-process|unmanaged
  --aqe-embedding-endpoint <url>   select existing HTTP(S)/Unix service
  --yes        accept the disclosed download/configuration plan
  --dry-run    preview only; no downloads or writes
  --json       machine-readable result (never tokens)

Local default: native Ollama running at http://127.0.0.1:11434; MiniLM ~45 MB.
No Docker or API key required. Install/start Ollama before local preparation.
In-process transformers remain an explicit upstream security opt-in.
Plain aqe uses the shell environment; Kit verification uses the saved choice.

Examples:
  ak x aqe-embedding configure --aqe-embedding-mode local --yes
  ak x aqe-embedding configure --aqe-embedding-endpoint https://embed.example --yes
  ak x aqe-embedding verify
  ak x aqe-embedding prepare --yes`;

/** @param {any} options */
export async function run({ flags = {}, positionals = [],
  load = loadKitConfig, save = saveKitConfig, prepare = prepareAqeEmbedding,
  reconcile = reconcileAqeEmbeddingProjections, inspect = inspectAqeEmbeddingProjections,
  reconcileOpenCode = reconcileOpencodeAqeEmbedding,
}) {
  const action = positionals[0] ?? 'status';
  if (!['status', 'configure', 'prepare', 'verify'].includes(action) || positionals.length > 1) return 2;
  const cfg = load();
  if (action === 'configure') {
    try { cfg.aqeEmbedding = embeddingIntentFromFlags(cfg, flags); }
    catch { console.error('Invalid embedding selection; run ak x aqe-embedding --help.'); return 2; }
  }
  const emit = value => console.log(flags.json ? JSON.stringify(value) : value.detail);
  const openCodeReady = (dryRun) => {
    if (cfg.aqe === false || !cfg.integrations?.hosts?.opencode) return true;
    const result = reconcileOpenCode(cfg, { dryRun });
    if (result.markersChanged) save(cfg);
    emit(result);
    return result.ok && (!dryRun || !result.changed);
  };
  if (action === 'status') {
    const projection = inspect(cfg, process.cwd());
    emit({ mode: cfg.aqeEmbedding?.mode ?? 'unmanaged', ...projection,
      detail: `${embeddingSetupDisclosure(cfg.aqeEmbedding ?? { mode: 'unmanaged' })} ${projection.detail}` });
    return openCodeReady(true) && projection.ok ? 0 : 1;
  }
  if (flags['dry-run'] || (action !== 'verify' && !flags.yes)) {
    emit({ status: 'preview', detail: `${embeddingSetupDisclosure(cfg.aqeEmbedding ?? { mode: 'unmanaged' })} Re-run with --yes to apply.` });
    return 0;
  }
  if (action === 'configure') save(cfg);
  const result = await prepare(cfg, { provision: action !== 'verify' });
  emit(result);
  if (!result.ok) return 1;
  if (action === 'verify') return result.status === 'skipped' ? 1 : 0;
  const projection = reconcile(cfg, process.cwd());
  emit(projection);
  if (!openCodeReady(false)) return 1;
  if (!flags.json) console.log(`New host sessions load the updated environment. For direct aqe, export AQE_EMBEDDER_ENDPOINT in your shell. ${AQE_EMBEDDING_COACHING}`);
  return projection.ok ? 0 : 1;
}
