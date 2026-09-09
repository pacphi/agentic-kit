// Native per-model clamp is verified on 0.153.4. An API maximum is not a
// Codex allocation. New host versions need their own native contract evidence.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { run } from './exec.mjs';
import { contextHome, positiveTokens, readContextConfig, replaceContextWindow,
  writeContextConfig, validateCodexContextIntent } from './codex-context-config.mjs';

export const VERIFIED_CODEX_CONTEXT_VERSIONS = Object.freeze(['0.153.4']);
export const CONTEXT_CACHE_MAX_AGE_MS = 7 * 86400000;

export function contextCapacity(raw, request = null) {
  const nativeWindow = positiveTokens(raw.context_window) ? raw.context_window : null;
  const maximumWindow = positiveTokens(raw.max_context_window) ? raw.max_context_window : nativeWindow;
  const percent = Number.isInteger(raw.effective_context_window_percent)
    && raw.effective_context_window_percent > 0 && raw.effective_context_window_percent <= 100
    ? raw.effective_context_window_percent : null;
  const allocatedWindow = request === null ? nativeWindow : maximumWindow === null ? null : Math.min(request, maximumWindow);
  return { model: raw.slug, nativeWindow, maximumWindow, requestedWindow: request, allocatedWindow,
    effectivePercent: percent, effectiveWindow: allocatedWindow !== null && percent !== null
      ? Math.floor(allocatedWindow * percent / 100) : null };
}

function readEvidence(home, now) {
  const file = path.join(home, 'config.toml');
  const config = readContextConfig(fs.readFileSync(file, 'utf8'));
  if (config.provider && config.provider !== 'openai') throw new Error('native maximum requires the OpenAI Codex provider');
  if (config.catalog) throw new Error('custom model catalog requires separate capacity conformance');
  const raw = fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8');
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('Codex model cache exceeds inspection bound');
  const cache = JSON.parse(raw);
  const age = now - Date.parse(cache.fetched_at);
  if (!Number.isFinite(age) || age < -300000 || age > CONTEXT_CACHE_MAX_AGE_MS) {
    throw new Error('Codex model cache is stale or undated; run codex debug models to refresh');
  }
  if (!VERIFIED_CODEX_CONTEXT_VERSIONS.includes(cache.client_version)) {
    throw new Error('Codex version has no verified per-model context clamp profile');
  }
  if (!Array.isArray(cache.models) || cache.models.length === 0 || cache.models.length > 1000) throw new Error('invalid Codex model catalog');
  const models = cache.models.filter(m => !['hide', 'hidden'].includes(m.visibility));
  if (!models.length || models.some(m => typeof m.slug !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(m.slug)
    || !positiveTokens(m.context_window) || !positiveTokens(m.max_context_window)
    || m.max_context_window < m.context_window || contextCapacity(m).effectivePercent === null)) {
    throw new Error('Codex catalog lacks valid native capacity bounds');
  }
  return { file, config, cache, models, requestedWindow: Math.max(...models.map(m => m.max_context_window)),
    cacheSha256: createHash('sha256').update(raw).digest('hex') };
}

function checkScope(cfg, home) {
  validateCodexContextIntent(cfg.codexContext);
  if (cfg.codexContext && cfg.codexContext.file !== path.join(home, 'config.toml')) {
    throw new Error('Codex context ownership scope differs from the current CODEX_HOME');
  }
}

export function inspectCodexContext(cfg, { home = contextHome(), now = Date.now() } = {}) {
  const owned = !!cfg.codexContext;
  try {
    checkScope(cfg, home);
    const evidence = readEvidence(home, now);
    return { owned, available: true, drifted: owned && evidence.config.window !== evidence.requestedWindow,
      enabled: cfg.integrations?.hosts?.codex === true,
      file: evidence.file, requestedWindow: evidence.requestedWindow, configuredWindow: evidence.config.window,
      autoCompactTokenLimit: evidence.config.autoCompact, clientVersion: evidence.cache.client_version,
      evidence: 'native-catalog-and-user-config', runtimeVerified: false,
      models: evidence.models.map(m => contextCapacity(m, evidence.config.window)) };
  } catch (error) {
    return { owned, available: false, drifted: false, reason: error.message, models: [], runtimeVerified: false };
  }
}

async function persistIntent(cfg, intent, persist) {
  await persist({ ...cfg, codexContext: intent });
  cfg.codexContext = intent;
}

export async function manageCodexContext(cfg, {
  enable = false, home = contextHome(), now = Date.now(), runner = run, persist = /** @type {((cfg: any) => any) | undefined} */ (undefined),
} = {}) {
  if (!enable && !cfg.codexContext) return { changed: false };
  if (!cfg.integrations?.hosts?.codex) throw new Error('enable the Codex host before managing its context');
  if (typeof persist !== 'function') throw new Error('ownership persistence is required');
  checkScope(cfg, home);
  const evidence = readEvidence(home, now);
  const version = await runner('codex', ['--version'], { timeout: 5000 });
  if (version.code !== 0 || version.stdout.trim() !== `codex-cli ${evidence.cache.client_version}`) {
    throw new Error('running Codex version differs from the verified model cache');
  }
  const { config, file, requestedWindow, cacheSha256 } = evidence;
  const originalLine = cfg.codexContext?.originalLine ?? (cfg.codexContext ? null
    : config.span ? config.source.slice(config.span.start, config.span.end) : null);
  const pending = { mode: 'max', file, originalLine,
    lastProjection: config.window !== null && config.window === cfg.codexContext?.pendingProjection
      ? config.window : cfg.codexContext?.lastProjection ?? null, pendingProjection: requestedWindow,
    clientVersion: evidence.cache.client_version, cacheSha256 };
  await persistIntent(cfg, pending, persist); // intent survives interrupted native writes
  const result = writeContextConfig(file, config.source, replaceContextWindow(config, requestedWindow));
  await persistIntent(cfg, { ...pending, lastProjection: requestedWindow, pendingProjection: null }, persist);
  return result;
}

export async function releaseCodexContext(cfg, { home = contextHome(), persist = /** @type {((cfg: any) => any) | undefined} */ (undefined) } = {}) {
  if (!cfg.codexContext) return { changed: false };
  checkScope(cfg, home);
  if (typeof persist !== 'function') throw new Error('ownership persistence is required');
  const { file, originalLine, lastProjection, pendingProjection } = cfg.codexContext;
  let result = { changed: false };
  if (fs.existsSync(file)) {
    const config = readContextConfig(fs.readFileSync(file, 'utf8'));
    if (config.window !== null && [lastProjection, pendingProjection].includes(config.window)) {
      result = writeContextConfig(file, config.source, replaceContextWindow(config, null, originalLine));
    }
  }
  await persistIntent(cfg, null, persist);
  return result;
}
