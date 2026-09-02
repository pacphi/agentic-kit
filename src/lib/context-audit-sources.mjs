// Bounded, local-only evidence acquisition for `ak audit context`. Public
// helpers return aggregate numbers and fixed reason codes only; raw contents,
// names, commands, secrets, and paths remain inside this module.
import fs from 'node:fs';
import path from 'node:path';

import {
  BUILTIN_BLOCKS, blocksForTarget, detect, guidanceContextFromConfig,
  guidanceFootprint, templateResolver,
} from './blocks.mjs';
import { estimateTokensFromBytes } from './context-budget.mjs';
import { modelWindowFromDiscovery } from './context-audit.mjs';
import { readBoundedFile } from './hook-audit/common.mjs';
import { discoverClaude } from './model-inventory/discovery/claude.mjs';
import { discoverCodex } from './model-inventory/discovery/codex.mjs';
import * as paths from './paths.mjs';

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_MODEL_CACHE_BYTES = 2 * 1024 * 1024;
const SCOPE_KEY = 'context-audit-local-v1';
const GUIDANCE_TARGET = Object.freeze({
  claude: 'claude', codex: 'agents-user', opencode: 'agents-opencode',
});

const normalize = (value) => String(value ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '\n');

function blockText(content, slug) {
  const begin = `<!-- BEGIN ${slug} -->`;
  const end = `<!-- END ${slug} -->`;
  const start = content.indexOf(begin);
  if (start < 0) return null;
  const finish = content.indexOf(end, start + begin.length);
  if (finish < 0) return null;
  return content.slice(start, finish + end.length);
}

/** Compare only managed sentinels and exact managed bytes. User-authored text
 * is neither copied nor hashed into the public report. */
export function inspectManagedGuidance(raw, expected = []) {
  if (raw == null || raw === '') {
    return {
      status: 'complete', state: 'absent', managedBlocks: 0,
      expectedBlocks: expected.length, duplicateBlocks: 0, staleBlocks: 0,
      missingBlocks: expected.length, upstreamOwned: [],
    };
  }
  const content = normalize(raw);
  const aqeBlocks = [...content.matchAll(/<!-- BEGIN AGENTIC-QE CODEX -->[\s\S]*?<!-- END AGENTIC-QE CODEX -->/g)]
    .map((match) => match[0]);
  const aqeBegins = [...content.matchAll(/<!-- BEGIN AGENTIC-QE CODEX -->/g)].length;
  const aqeBytes = aqeBlocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0);
  const aqeEstimate = estimateTokensFromBytes(aqeBytes);
  const aqeState = aqeBegins > 1 ? 'duplicate-managed'
    : aqeBegins > aqeBlocks.length ? 'orphaned-managed'
      : aqeBegins === 1 ? 'single-managed' : null;
  const upstreamOwned = aqeState ? [{
    owner: 'agentic-qe', blocks: aqeBegins, bytes: aqeBytes,
    estimatedTokens: {
      tokens: aqeEstimate.tokens, unit: aqeEstimate.unit, method: aqeEstimate.method,
    },
    state: aqeState,
  }] : [];
  const occurrences = [...content.matchAll(/<!-- BEGIN ([a-z][a-z0-9-]{0,127}) -->/g)]
    .map((match) => match[1]);
  if (!occurrences.length) {
    return {
      status: aqeState === 'orphaned-managed' ? 'partial' : 'complete',
      state: aqeState === 'duplicate-managed' ? 'duplicate-managed'
        : aqeState === 'orphaned-managed' ? 'stale-managed'
          : aqeState === 'single-managed' ? 'upstream-managed-only' : 'user-authored-only',
      managedBlocks: 0,
      expectedBlocks: expected.length, duplicateBlocks: 0, staleBlocks: 0,
      missingBlocks: expected.length, upstreamOwned,
    };
  }
  const expectedBySlug = new Map(expected.map((entry) => [entry.slug, normalize(entry.text).trimEnd()]));
  let duplicateBlocks = 0;
  let staleBlocks = 0;
  let missingBlocks = 0;
  for (const [slug, wanted] of expectedBySlug) {
    const count = occurrences.filter((value) => value === slug).length;
    if (count === 0) { missingBlocks += 1; continue; }
    duplicateBlocks += Math.max(0, count - 1);
    const observed = blockText(content, slug);
    if (observed == null || normalize(observed).trimEnd() !== wanted) staleBlocks += 1;
  }
  staleBlocks += occurrences.filter((slug) => !expectedBySlug.has(slug)).length;
  const state = duplicateBlocks > 0 || aqeState === 'duplicate-managed' ? 'duplicate-managed'
    : staleBlocks > 0 || missingBlocks > 0 ? 'stale-managed' : 'canonical-managed';
  return {
    status: 'complete', state, managedBlocks: occurrences.length,
    expectedBlocks: expected.length, duplicateBlocks, staleBlocks, missingBlocks, upstreamOwned,
  };
}

/** Bounded metadata census. SKILL.md contents are deliberately never opened:
 * host-rendered description bytes are not recorded by the host, so returning a
 * guessed token contribution would be misleading. */
export function boundedSkillMetadata({
  roots = [], maxEntries = 2_048, maxDepth = 4, fsImpl = fs,
} = {}) {
  const queue = [...new Set(roots.filter((root) => typeof root === 'string'))]
    .slice(0, 8).map((root) => ({ root, depth: 0 }));
  let visited = 0;
  let count = 0;
  let capped = roots.length > 8;
  let depthOmitted = 0;
  let unavailable = false;
  while (queue.length && !capped) {
    const current = queue.shift();
    let entries;
    try { entries = fsImpl.readdirSync(current.root, { withFileTypes: true }); }
    catch (error) {
      if (error?.code !== 'ENOENT') unavailable = true;
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) { capped = true; break; }
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && entry.name === 'SKILL.md') count += 1;
      else if (entry.isDirectory()) {
        if (current.depth < maxDepth) {
          queue.push({ root: path.join(current.root, entry.name), depth: current.depth + 1 });
        } else depthOmitted += 1;
      }
    }
  }
  return {
    status: unavailable ? 'unavailable' : 'partial',
    count,
    metadataBytes: null,
    omitted: capped ? 1 : depthOmitted,
    reason: capped ? 'skill-census-entry-cap'
      : unavailable ? 'skill-census-unavailable'
        : depthOmitted ? 'skill-census-depth-cap' : 'host-rendered-metadata-not-recorded',
  };
}

/** Parse only registration cardinality. Configuration bytes are measurable;
 * tool schema bytes are not present in these host config documents. */
export function inspectMcpConfig(host, raw) {
  if (host === 'external') return {
    status: 'unsupported', registrations: null, configBytes: null, schemaBytes: null,
    reason: 'external-contract-v1-no-mcp-observability',
  };
  if (raw == null || raw === '') return {
    status: 'not-recorded', registrations: null, configBytes: null, schemaBytes: null,
    reason: 'mcp-config-not-recorded',
  };
  const text = String(raw);
  const configBytes = Buffer.byteLength(text);
  if (configBytes > MAX_CONFIG_BYTES) return {
    status: 'unavailable', registrations: null, configBytes: null, schemaBytes: null,
    reason: 'mcp-config-size-cap',
  };
  try {
    let registrations;
    if (host === 'codex') {
      registrations = [...text.matchAll(/^\s*\[mcp_servers\.(?:"[^"\n]+"|[A-Za-z0-9_-]+)\]\s*$/gm)].length;
    } else {
      const document = JSON.parse(text);
      const table = host === 'claude' ? document?.mcpServers : document?.mcp;
      if (!table || typeof table !== 'object' || Array.isArray(table)) registrations = 0;
      else registrations = Object.keys(table).length;
    }
    return {
      status: 'partial', registrations, configBytes, schemaBytes: null,
      reason: 'tool-schemas-not-recorded',
    };
  } catch {
    return {
      status: 'unavailable', registrations: null, configBytes, schemaBytes: null,
      reason: 'mcp-config-format-unsupported',
    };
  }
}

function readText(file, containmentRoot, maxBytes = MAX_CONFIG_BYTES) {
  const result = readBoundedFile(file, containmentRoot, maxBytes);
  return result.status === 'valid' ? result.text : null;
}

function skillRoots(host, cwd) {
  if (host === 'claude') return [paths.claudeSkillsDir(), path.join(cwd, '.claude', 'skills')];
  if (host === 'codex') return [
    path.join(paths.home, '.agents', 'skills'), path.join(paths.codexDir(), 'skills'),
    path.join(cwd, '.agents', 'skills'),
  ];
  if (host === 'opencode') return [paths.opencodeSkillsDir(), path.join(cwd, '.agents', 'skills')];
  return [];
}

function mcpRaw(host) {
  if (host === 'claude') return readText(paths.claudeUserMcpPath(), paths.home);
  if (host === 'codex') return readText(paths.codexConfigPath(), paths.codexDir());
  if (host === 'opencode') return readText(paths.opencodeConfigPath(), paths.opencodeDir());
  return null;
}

function boundedNamedDirectory({ root, name, maxEntries = 2_048, maxDepth = 4 }) {
  const queue = [{ root, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.root, { withFileTypes: true }); }
    catch (error) { return error?.code === 'ENOENT' ? { status: 'complete', found: false } : { status: 'unavailable', found: false }; }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) return { status: 'partial', found: false };
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name === name) return { status: 'complete', found: true };
      if (current.depth < maxDepth) queue.push({ root: path.join(current.root, entry.name), depth: current.depth + 1 });
    }
  }
  return { status: 'complete', found: false };
}

async function expectedBlocksFor(target, context, resolve) {
  const blocks = [];
  for (const row of blocksForTarget(BUILTIN_BLOCKS, target)) {
    if (!await detect(row.detector, context)) continue;
    const file = resolve(row);
    const text = readText(file, path.dirname(file));
    if (text != null) blocks.push({ slug: row.slug, text });
  }
  return blocks;
}

function targetFile(host) {
  if (host === 'claude') return { scope: 'machine', file: paths.claudeMdPath(), root: paths.claudeDir() };
  if (host === 'codex') return { scope: 'machine', file: paths.codexAgentsMdPath(), root: paths.codexDir() };
  if (host === 'opencode') return { scope: 'machine', file: paths.opencodeAgentsMdPath(), root: paths.opencodeDir() };
  return null;
}

async function guidanceEvidence(host, { cfg, pkgRoot, cwd }) {
  if (host === 'external') return {
    status: 'unsupported', reason: 'external-contract-v1-no-native-guidance',
  };
  const target = GUIDANCE_TARGET[host];
  const superpowers = boundedNamedDirectory({
    root: path.join(paths.claudeDir(), 'plugins', 'cache'), name: 'superpowers',
  });
  const context = guidanceContextFromConfig(cfg, {
    flags: { superpowersEnabled: superpowers.found },
  });
  const resolve = templateResolver(pkgRoot);
  const footprint = await guidanceFootprint(BUILTIN_BLOCKS, target, resolve, { context });
  if (superpowers.status !== 'complete' && host === 'claude') {
    footprint.unknown.push({ slug: 'ruflo-superpowers-reference', reason: 'detector-evidence-incomplete' });
  }
  const expected = await expectedBlocksFor(target, context, resolve);
  const actual = targetFile(host);
  const machineRaw = actual ? readText(actual.file, actual.root) : null;
  const installations = [{ scope: 'machine', ...inspectManagedGuidance(machineRaw, expected) }];
  if (host === 'codex') {
    const projectRaw = readText(path.join(cwd, 'AGENTS.md'), cwd);
    installations.push({
      scope: 'project', ...inspectManagedGuidance(projectRaw, []),
    });
  }
  return {
    ...footprint,
    status: footprint.unknown.length ? 'partial' : 'complete',
    target,
    installations,
  };
}

function modelEvidence(host, environment) {
  if (host === 'external') return {
    status: 'unsupported', reason: 'external-contract-v1-no-context-observability',
  };
  if (host === 'opencode') return {
    status: 'not-recorded', reason: 'bounded-local-model-window-cache-not-recorded',
  };
  const capturedAt = new Date().toISOString();
  if (host === 'codex') {
    const cacheRaw = readText(path.join(paths.codexDir(), 'models_cache.json'), paths.codexDir(), MAX_MODEL_CACHE_BYTES);
    if (cacheRaw == null) return { status: 'not-recorded', reason: 'codex-model-cache-not-recorded' };
    const result = discoverCodex({
      cacheRaw,
      configRaw: readText(paths.codexConfigPath(), paths.codexDir()),
      capturedAt, scopeKey: SCOPE_KEY,
    });
    return modelWindowFromDiscovery(host, result);
  }
  const environmentModels = Object.fromEntries([
    'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ].filter((key) => typeof environment?.[key] === 'string').map((key) => [key, environment[key]]));
  const managedPath = paths.claudeManagedSettingsPath();
  const result = discoverClaude({
    settingsRaw: readText(paths.claudeSettingsPath(), paths.claudeDir()),
    managedSettingsRaw: managedPath ? readText(managedPath, path.dirname(managedPath)) : null,
    environment: environmentModels,
    capturedAt, scopeKey: SCOPE_KEY,
  });
  return modelWindowFromDiscovery(host, result);
}

/** Acquire every non-hook source locally. The hook audit is passed in by the
 * command so the canonical static collector runs only once. */
export async function collectContextEvidence({
  hosts, cfg, pkgRoot, cwd = process.cwd(), hookAudit, environment = process.env,
} = {}) {
  const guidance = {};
  const windows = {};
  const skills = {};
  const mcp = {};
  for (const host of hosts) {
    guidance[host] = await guidanceEvidence(host, { cfg, pkgRoot, cwd });
    windows[host] = modelEvidence(host, environment);
    skills[host] = host === 'external' ? {
      status: 'unsupported', count: null, metadataBytes: null, omitted: 0,
      reason: 'external-contract-v1-no-skill-observability',
    } : boundedSkillMetadata({ roots: skillRoots(host, cwd) });
    mcp[host] = inspectMcpConfig(host, mcpRaw(host));
  }
  return { guidance, windows, skills, mcp, hookAudit };
}
