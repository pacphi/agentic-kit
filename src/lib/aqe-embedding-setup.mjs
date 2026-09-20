import { LOCAL_AQE_ENDPOINT, selectAqeEmbeddingIntent, validateAqeEmbeddingIntent } from './aqe-embedding-config.mjs';

/** Shared selection for setup and the narrow embedding configuration command. */
export function embeddingIntentFromFlags(cfg, flags = {}, env = process.env) {
  const mode = flags['aqe-embedding-mode'];
  const endpoint = flags['aqe-embedding-endpoint'];
  if (mode !== undefined && !['local', 'endpoint', 'in-process', 'unmanaged'].includes(mode)) {
    throw new TypeError('--aqe-embedding-mode must be local, endpoint, in-process, or unmanaged');
  }
  if (endpoint && mode && mode !== 'endpoint') throw new TypeError('An endpoint requires endpoint mode');
  if (mode === 'endpoint' && !endpoint) throw new TypeError('Endpoint mode requires --aqe-embedding-endpoint');
  if (endpoint) return validateAqeEmbeddingIntent({ mode: 'endpoint', endpoint, provisioning: 'external' });
  if (mode === 'local') return { mode: 'endpoint', endpoint: LOCAL_AQE_ENDPOINT, provisioning: 'ollama' };
  if (mode) return { mode };
  return selectAqeEmbeddingIntent(cfg, env);
}

export function embeddingSetupDisclosure(intent) {
  if (intent.mode === 'unmanaged') return 'AQE embeddings remain unmanaged; semantic learning is not verified.';
  if (intent.mode === 'in-process') return 'Use explicitly opted-in local transformers; no package is installed automatically. Verify its security and prepare its model cache before setup.';
  if (intent.provisioning === 'ollama') return 'Local semantic learning: use Ollama on loopback, download all-minilm:22m (about 45 MB), create the AQE model alias if absent, and configure enabled hosts. No API key; existing vectors are preserved. Ollama must already be installed and running.';
  return 'Use your selected embedding endpoint and configure enabled hosts. Verification sends synthetic text; normal AQE use may send project text. No model download or corpus migration.';
}
