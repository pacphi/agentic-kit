// OpenRouter account analytics (issue #59).
//
// Network access is EXPLICIT: only refreshOpenRouterActivity() calls the
// management API. Every dashboard/status read uses the private local cache.
// The upstream response is grouped by endpoint, but endpoint ids are neither
// useful nor necessary for the scorecard, so normalization aggregates them
// away. The resulting account-level evidence must never be joined to local
// sessions: the API supplies no session, host, project, or task correlation.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './paths.mjs';

export const OPENROUTER_ACTIVITY_URL = 'https://openrouter.ai/api/v1/activity';
export const OPENROUTER_ACTIVITY_SCHEMA = 1;
export const OPENROUTER_ACTIVITY_DAYS = 30;
export const OPENROUTER_ACTIVITY_MAX_BYTES = 4 * 1024 * 1024;
export const openRouterActivityFile = () => path.join(configDir(), 'openrouter-activity.json');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const METRICS = [
  'requests', 'promptTokens', 'completionTokens', 'reasoningTokens',
  'usage', 'byokUsageInference',
];

function requiredNumber(row, key, index, { integer = false } = {}) {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
    || (integer && !Number.isInteger(value))) {
    throw new TypeError(`OpenRouter activity row ${index} has invalid ${key}`);
  }
  return value;
}

function requiredText(row, key, index, max = 256) {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new TypeError(`OpenRouter activity row ${index} has invalid ${key}`);
  }
  return value;
}

function blankMetrics() {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    usage: 0,
    byokUsageInference: 0,
  };
}

function addMetrics(target, row) {
  for (const key of METRICS) target[key] += row[key];
  return target;
}

function rounded(metrics) {
  return {
    ...metrics,
    usage: Math.round(metrics.usage * 1e9) / 1e9,
    byokUsageInference: Math.round(metrics.byokUsageInference * 1e9) / 1e9,
  };
}

function normalizeRow(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError(`OpenRouter activity row ${index} must be an object`);
  }
  const date = requiredText(row, 'date', index, 10);
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (!DATE_RE.test(date) || Number.isNaN(parsedDate.valueOf())
    || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new TypeError(`OpenRouter activity row ${index} has invalid date`);
  }
  const model = requiredText(row, 'model', index);
  // Validate the endpoint id because it is required by the supported schema,
  // then intentionally discard it before the cache shape is constructed.
  requiredText(row, 'endpoint_id', index, 512);
  return {
    date,
    model,
    modelPermaslug: requiredText(row, 'model_permaslug', index),
    providerName: requiredText(row, 'provider_name', index),
    requests: requiredNumber(row, 'requests', index, { integer: true }),
    promptTokens: requiredNumber(row, 'prompt_tokens', index, { integer: true }),
    completionTokens: requiredNumber(row, 'completion_tokens', index, { integer: true }),
    reasoningTokens: requiredNumber(row, 'reasoning_tokens', index, { integer: true }),
    usage: requiredNumber(row, 'usage', index),
    byokUsageInference: requiredNumber(row, 'byok_usage_inference', index),
  };
}

function groupedRows(rows, keyOf, describe) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    let group = groups.get(key);
    if (!group) {
      group = { ...describe(row), ...blankMetrics() };
      groups.set(key, group);
    }
    addMetrics(group, row);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, ...rounded(group) }))
    .sort((a, b) => (
      b.requests - a.requests
      || b.usage - a.usage
      || b.byokUsageInference - a.byokUsageInference
      || String(a.model ?? a.providerName).localeCompare(String(b.model ?? b.providerName))
    ));
}

function completedUtcWindow(now) {
  const through = new Date(now);
  through.setUTCHours(0, 0, 0, 0);
  through.setUTCDate(through.getUTCDate() - 1);
  const from = new Date(through);
  from.setUTCDate(from.getUTCDate() - (OPENROUTER_ACTIVITY_DAYS - 1));
  return {
    completedUtcDays: OPENROUTER_ACTIVITY_DAYS,
    from: from.toISOString().slice(0, 10),
    through: through.toISOString().slice(0, 10),
  };
}

/**
 * Convert the management API response into the credential-free cache shape.
 * Endpoint ids and any unknown upstream fields are deliberately discarded.
 */
export function normalizeOpenRouterActivity(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.data)) {
    throw new TypeError('OpenRouter activity response must contain data[]');
  }
  const rows = raw.data.map((row, index) => normalizeRow(row, index));

  // Multiple upstream endpoint rows can describe the same date/model/provider.
  // Collapse them so the cache cannot retain endpoint identifiers by accident.
  const daily = groupedRows(
    rows,
    (row) => JSON.stringify([row.date, row.model, row.modelPermaslug, row.providerName]),
    (row) => ({
      date: row.date,
      model: row.model,
      modelPermaslug: row.modelPermaslug,
      providerName: row.providerName,
    }),
  ).sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model));

  const totals = rounded(daily.reduce((sum, row) => addMetrics(sum, row), blankMetrics()));
  const dates = [...new Set(daily.map((row) => row.date))].sort();
  return {
    schemaVersion: OPENROUTER_ACTIVITY_SCHEMA,
    provider: 'openrouter',
    source: 'management-api/activity',
    fetchedAt: new Date(now).toISOString(),
    coverage: completedUtcWindow(now),
    activitySpan: {
      from: dates[0] ?? null,
      through: dates.at(-1) ?? null,
    },
    totals,
    byModel: groupedRows(
      daily,
      (row) => JSON.stringify([row.model, row.modelPermaslug]),
      (row) => ({ model: row.model, modelPermaslug: row.modelPermaslug }),
    ),
    byProvider: groupedRows(
      daily,
      (row) => row.providerName,
      (row) => ({ providerName: row.providerName }),
    ),
    rows: daily,
  };
}

function cacheShape(value) {
  return value
    && value.schemaVersion === OPENROUTER_ACTIVITY_SCHEMA
    && value.provider === 'openrouter'
    && typeof value.fetchedAt === 'string'
    && value.totals && typeof value.totals === 'object'
    && Array.isArray(value.byModel)
    && Array.isArray(value.byProvider)
    && Array.isArray(value.rows);
}

/** Pure offline read. Missing, corrupt, or unknown-schema cache → null. */
export function readOpenRouterActivity({ cacheFile = openRouterActivityFile() } = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return cacheShape(value) ? value : null;
  } catch {
    return null;
  }
}

function writeCache(cacheFile, value) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, cacheFile);
    try { fs.chmodSync(cacheFile, 0o600); } catch { /* best effort on Windows/exotic fs */ }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

async function boundedResponseText(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`OpenRouter activity response exceeds ${maxBytes} bytes`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const body = await response.text();
    if (Buffer.byteLength(body) > maxBytes) {
      throw new Error(`OpenRouter activity response exceeds ${maxBytes} bytes`);
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new Error(`OpenRouter activity response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Explicit network refresh. Requires a management key—not an inference key—
 * and persists only the normalized credential-free cache.
 */
export async function refreshOpenRouterActivity({
  key = process.env.OPENROUTER_MANAGEMENT_KEY,
  cacheFile = openRouterActivityFile(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  maxBytes = OPENROUTER_ACTIVITY_MAX_BYTES,
  now = Date.now(),
} = {}) {
  if (!key) {
    throw new Error('OPENROUTER_MANAGEMENT_KEY is required (an inference API key is not sufficient)');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is unavailable');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(OPENROUTER_ACTIVITY_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw new Error(`OpenRouter activity refresh failed (HTTP ${response?.status ?? 'unknown'})`);
    }
    const body = await boundedResponseText(response, maxBytes);
    let raw;
    try { raw = JSON.parse(body); } catch { throw new Error('OpenRouter activity response was not valid JSON'); }
    const value = normalizeOpenRouterActivity(raw, { now });
    writeCache(cacheFile, value);
    return value;
  } finally {
    clearTimeout(timer);
  }
}
