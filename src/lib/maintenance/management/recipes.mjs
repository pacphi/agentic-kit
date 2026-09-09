// ADR-0048 procedure recipes: schema, built-in signed catalogue, trust chain,
// compatibility matching, and the owner-private accepted/pending/withdrawn
// store (MNT-ACT-017..020, MNT-DSC "Guided" level, J8).
//
// A recipe is typed data, never an arbitrary command string. `renderProcedure`
// (procedures.mjs) is the only place typed fields become a shell rendering.
// This module never spawns a process and never fetches network content on its
// own; `refreshRecipes` takes an injected `fetchImpl`.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

import { writePrivateFileAtomic } from '../../file-write.mjs';
import {
  NETWORK_REQUIREMENTS, PRIVILEGE_REQUIREMENTS, RECIPE_SCHEMA, RECIPE_STATES, SHELLS,
  canonicalJson,
} from './model.mjs';

const MAX_RECIPE_STORE_BYTES = 2 * 1024 * 1024;
const RECIPE_STORE_SCHEMA = 'maintenance-recipe-store/v1';

/** The bundled HMAC key for built-in recipes. This is tamper-evidence for the
 *  local owner-private store (matching scan-store.mjs/transaction-store.mjs's
 *  sha256 integrity seal), not a secrecy boundary against a reader of this
 *  source file — the same posture as `opaqueId`'s installation key. */
export const BUILTIN_PUBLISHER_ID = 'agentic-kit-builtin';
const BUILTIN_PUBLISHER_KEY = 'agentic-kit-builtin-recipe-key-v1-2c5a7e4b1d9f8036';

function assertRecipeShape(recipe) {
  if (!recipe || typeof recipe !== 'object') throw new TypeError('recipe must be an object');
  if (recipe.schema !== RECIPE_SCHEMA) throw new TypeError(`recipe.schema must be ${RECIPE_SCHEMA}`);
  for (const field of ['recipeId', 'recipeVersion', 'publisher', 'sourceAuthority', 'operation']) {
    if (typeof recipe[field] !== 'string' || !recipe[field]) throw new TypeError(`recipe.${field} is required`);
  }
  if (!SHELLS.includes(recipe.shell)) throw new TypeError(`recipe.shell must be one of ${SHELLS.join(', ')}`);
  if (!PRIVILEGE_REQUIREMENTS.includes(recipe.privilegeRequirement)) throw new TypeError('recipe.privilegeRequirement is invalid');
  if (!NETWORK_REQUIREMENTS.includes(recipe.networkRequirement)) throw new TypeError('recipe.networkRequirement is invalid');
  if (typeof recipe.expectedEffect !== 'string' || !recipe.expectedEffect) throw new TypeError('recipe.expectedEffect is required');
  if (!Array.isArray(recipe.preservedResources)) throw new TypeError('recipe.preservedResources must be an array');
  if (typeof recipe.verification !== 'string' || !recipe.verification) throw new TypeError('recipe.verification is required');
  if (recipe.privilegeRequirement === 'elevated' && recipe.solicitsPassword) {
    throw new TypeError('an elevated recipe must never solicit a password (MNT-ACT-009)');
  }
}

function withoutTrust(recipe) {
  const { contentDigest: _d, signatureChain: _s, ...rest } = recipe;
  return rest;
}

/**
 * Sign a recipe body. Only the bundled built-in key is supported directly;
 * a provider-owned key is passed explicitly via `key` (still HMAC-SHA256, per
 * ORCHESTRATION's "chain with a bundled publisher key id + content digest").
 */
export function signRecipe(recipe, { key = BUILTIN_PUBLISHER_KEY } = {}) {
  assertRecipeShape({ ...recipe, contentDigest: 'placeholder', signatureChain: 'placeholder' });
  const body = withoutTrust(recipe);
  const contentDigest = createHmac('sha256', key).update(canonicalJson(body)).digest('hex');
  const signatureChain = createHmac('sha256', key).update(`${recipe.publisher}:${contentDigest}`).digest('hex');
  return Object.freeze({ ...recipe, contentDigest, signatureChain });
}

/** Verify a signed recipe's digest and signature chain against a publisher
 *  key registry. `publisherKeys` defaults to only the bundled built-in key;
 *  a registry refresh supplies the exact expected `publisherId`'s key. */
export function verifyRecipe(recipe, { publisherKeys = { [BUILTIN_PUBLISHER_ID]: BUILTIN_PUBLISHER_KEY } } = {}) {
  if (!recipe || recipe.schema !== RECIPE_SCHEMA) return { ok: false, reason: 'unexpected recipe schema' };
  const key = publisherKeys[recipe.publisher];
  if (!key) return { ok: false, reason: 'unknown or unallowlisted publisher' };
  const body = withoutTrust(recipe);
  const expectedDigest = createHmac('sha256', key).update(canonicalJson(body)).digest('hex');
  if (expectedDigest !== recipe.contentDigest) return { ok: false, reason: 'content digest mismatch' };
  const expectedSignature = createHmac('sha256', key).update(`${recipe.publisher}:${recipe.contentDigest}`).digest('hex');
  if (expectedSignature !== recipe.signatureChain) return { ok: false, reason: 'signature chain mismatch' };
  return { ok: true };
}

function buildBuiltin(fields) {
  const recipe = {
    schema: RECIPE_SCHEMA, publisher: BUILTIN_PUBLISHER_ID, state: 'active',
    architecture: null, hostAndVersionRange: null, packageManagerAndRange: null,
    typedArguments: {}, invalidationInputs: [], triggerCondition: null, dependencyRequirement: null,
    solicitsPassword: false,
    ...fields,
  };
  return signRecipe(recipe);
}

// ── Built-in signed catalogue ───────────────────────────────────────────────

export const BUILTIN_RECIPES = Object.freeze([
  buildBuiltin({
    recipeId: 'reinstall-lightpanda-homebrew', recipeVersion: '1',
    sourceAuthority: 'Agentic Kit built-in recipe', osAndVersionRange: 'macOS 13+',
    resourceKind: 'mcp-registration', packageManagerAndRange: 'homebrew (any tested version)',
    shell: 'zsh', operation: 'reinstall-dependency', triggerCondition: 'missing-verified-dependency',
    dependencyRequirement: 'lightpanda',
    typedArguments: { manager: 'brew', verb: 'install', package: 'lightpanda' },
    expectedEffect: 'Installs the lightpanda executable; the MCP registration itself is unchanged.',
    preservedResources: ['The MCP registration', 'Claude configuration'],
    verification: 'lightpanda --version',
    privilegeRequirement: 'none', networkRequirement: 'required',
  }),
  buildBuiltin({
    recipeId: 'reinstall-lightpanda-npm', recipeVersion: '1',
    sourceAuthority: 'Agentic Kit built-in recipe', osAndVersionRange: null,
    resourceKind: 'mcp-registration', packageManagerAndRange: 'npm (any tested version)',
    shell: 'bash', operation: 'reinstall-dependency', triggerCondition: 'missing-verified-dependency',
    dependencyRequirement: 'lightpanda',
    typedArguments: { manager: 'npm', verb: 'install', flag: '--global', package: 'lightpanda' },
    expectedEffect: 'Installs the lightpanda executable globally through npm.',
    preservedResources: ['The MCP registration', 'Claude configuration'],
    verification: 'lightpanda --version',
    privilegeRequirement: 'none', networkRequirement: 'required',
  }),
  buildBuiltin({
    recipeId: 'claude-mcp-remove-registration', recipeVersion: '1',
    sourceAuthority: 'Agentic Kit built-in recipe', osAndVersionRange: null,
    resourceKind: 'mcp-registration', packageManagerAndRange: null,
    shell: 'bash', operation: 'remove-registration', triggerCondition: 'missing-verified-dependency',
    dependencyRequirement: null,
    typedArguments: { command: 'claude', verb: 'mcp remove' },
    expectedEffect: 'Removes only the exact named MCP registration at its scope; every other registration is unchanged.',
    preservedResources: ['Every other MCP registration', 'Claude configuration'],
    verification: 'claude mcp list',
    privilegeRequirement: 'none', networkRequirement: 'none',
  }),
  buildBuiltin({
    recipeId: 'codex-plugin-update-steps', recipeVersion: '1',
    sourceAuthority: 'Agentic Kit built-in recipe', osAndVersionRange: null, hostAndVersionRange: 'codex',
    resourceKind: 'plugin', packageManagerAndRange: null,
    shell: 'bash', operation: 'update', triggerCondition: 'update-candidate-present',
    typedArguments: { command: 'codex', verb: 'plugin update' },
    expectedEffect: 'Updates the named Codex plugin to its reported candidate version.',
    preservedResources: ['Other Codex plugins', 'Codex configuration'],
    verification: 'codex plugin list',
    privilegeRequirement: 'none', networkRequirement: 'required',
  }),
  buildBuiltin({
    recipeId: 'npm-global-update-steps', recipeVersion: '1',
    sourceAuthority: 'Agentic Kit built-in recipe', osAndVersionRange: null,
    resourceKind: 'executable', packageManagerAndRange: 'npm (any tested version)',
    shell: 'bash', operation: 'update', triggerCondition: 'update-candidate-present',
    typedArguments: { manager: 'npm', verb: 'update', flag: '--global' },
    expectedEffect: 'Updates the named globally installed npm package to its latest matching version.',
    preservedResources: ['Other globally installed packages'],
    verification: 'npm --global list --depth=0',
    privilegeRequirement: 'none', networkRequirement: 'required',
  }),
  buildBuiltin({
    recipeId: 'pnpm-global-update-steps', recipeVersion: '1',
    sourceAuthority: 'Agentic Kit built-in recipe', osAndVersionRange: null,
    resourceKind: 'executable', packageManagerAndRange: 'pnpm (any tested version)',
    shell: 'bash', operation: 'update', triggerCondition: 'update-candidate-present',
    typedArguments: { manager: 'pnpm', verb: 'update', flag: '--global' },
    expectedEffect: 'Updates the named globally installed pnpm package to its latest matching version.',
    preservedResources: ['Other globally installed packages'],
    verification: 'pnpm list --global --depth=0',
    privilegeRequirement: 'none', networkRequirement: 'required',
  }),
  buildBuiltin({
    recipeId: 'ollama-model-pull-update-steps', recipeVersion: '1',
    sourceAuthority: 'Agentic Kit built-in recipe', osAndVersionRange: null,
    resourceKind: 'model', packageManagerAndRange: null,
    shell: 'bash', operation: 'pull', triggerCondition: 'update-candidate-present',
    typedArguments: { command: 'ollama', verb: 'pull' },
    expectedEffect: 'Downloads the named model’s latest tag; the currently installed revision is replaced only after the pull succeeds.',
    preservedResources: ['Other installed models', 'Ollama configuration'],
    verification: 'ollama list',
    privilegeRequirement: 'none', networkRequirement: 'required',
  }),
  buildBuiltin({
    recipeId: 'apt-elevated-example-steps', recipeVersion: '1',
    sourceAuthority: 'Agentic Kit built-in recipe', osAndVersionRange: 'Debian/Ubuntu families',
    resourceKind: 'executable', packageManagerAndRange: 'apt (current supported family)',
    shell: 'bash', operation: 'update', triggerCondition: 'update-candidate-present',
    typedArguments: { manager: 'apt-get', verb: 'install', flag: '--only-upgrade' },
    expectedEffect: 'Upgrades the named package using the system package manager.',
    preservedResources: ['Other installed packages'],
    verification: 'apt-cache policy',
    privilegeRequirement: 'elevated', networkRequirement: 'required',
  }),
]);

// ── Compatibility matching ─────────────────────────────────────────────────

function environmentCompatible(recipe, environment) {
  if (!recipe.osAndVersionRange || !environment?.osFamily) return true;
  return recipe.osAndVersionRange.toLowerCase().includes(String(environment.osFamily).toLowerCase())
    || recipe.osAndVersionRange.toLowerCase().includes(String(environment.kind ?? '').toLowerCase());
}

function hostCompatible(recipe, placement) {
  if (!recipe.hostAndVersionRange) return true;
  const hosts = placement?.consumerHosts ?? [];
  return hosts.some((host) => recipe.hostAndVersionRange.toLowerCase().includes(host));
}

function conditionCompatible(recipe, condition) {
  return recipe.triggerCondition == null || recipe.triggerCondition === condition;
}

function dependencyCompatible(recipe, dependencyRequirement) {
  return recipe.dependencyRequirement == null || recipe.dependencyRequirement === dependencyRequirement;
}

function resourceKindCompatible(recipe, resourceKind) {
  return recipe.resourceKind == null || recipe.resourceKind === resourceKind;
}

function packageManagerCompatible(recipe, packageManagers) {
  if (!recipe.packageManagerAndRange) return true;
  if (!Array.isArray(packageManagers) || !packageManagers.length) return true;
  return packageManagers.some((manager) => recipe.packageManagerAndRange.toLowerCase().includes(String(manager).toLowerCase()));
}

export function recipeCommandReady(recipe) {
  const args = recipe.typedArguments ?? {};
  // These templates have no source-bound target yet. Never offer a global
  // update or removal while promising to preserve unrelated installations.
  if (['update', 'remove-registration'].includes(recipe.operation) && !args.package) return false;
  return !/\s/.test(args.verb ?? '');
}

/**
 * Find every active, verified, compatible recipe for one placement's
 * condition. `recipes` is the candidate catalogue (built-ins plus any
 * accepted store entries the caller composed); only `state === 'active'`
 * recipes are considered (MNT-ACT-020: withdrawn creates no new Guidance).
 * @param {any[]} recipes
 * @param {{ placement?: any, environment?: any, packageManagers?: string[], resourceKind?: string, condition?: string, dependencyRequirement?: string|null }} [query]
 */
export function findCompatibleRecipes(recipes, {
  placement, environment, packageManagers = [], resourceKind, condition, dependencyRequirement = null,
} = /** @type {any} */ ({})) {
  return (recipes ?? []).filter((recipe) => recipe.state === 'active'
    && recipeCommandReady(recipe)
    && verifyRecipe(recipe).ok
    && resourceKindCompatible(recipe, resourceKind ?? placement?.kind)
    && conditionCompatible(recipe, condition)
    && dependencyCompatible(recipe, dependencyRequirement)
    && environmentCompatible(recipe, environment)
    && hostCompatible(recipe, placement)
    && packageManagerCompatible(recipe, packageManagers));
}

// ── Owner-private recipe store (accepted/pending/withdrawn) ────────────────

function storeFile(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('recipe store root must be a dedicated absolute directory');
  }
  return path.join(path.normalize(root), 'recipes.json');
}

function readStore(root, fsImpl) {
  const file = storeFile(root);
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: RECIPE_STORE_SCHEMA, recipes: [], events: [] };
    throw error;
  }
  const envelope = JSON.parse(raw);
  if (envelope.schemaVersion !== RECIPE_STORE_SCHEMA) throw new Error('recipe store schema mismatch');
  return envelope;
}

function writeStore(root, envelope, fsImpl) {
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(bytes) > MAX_RECIPE_STORE_BYTES) throw new Error('recipe store exceeds size limit');
  writePrivateFileAtomic(storeFile(root), bytes, { fsImpl });
}

function diffOne(from, to) {
  return {
    recipeId: to.recipeId,
    from: from ? { recipeVersion: from.recipeVersion, privilegeRequirement: from.privilegeRequirement, networkRequirement: from.networkRequirement, operation: from.operation } : null,
    to: { recipeVersion: to.recipeVersion, privilegeRequirement: to.privilegeRequirement, networkRequirement: to.networkRequirement, operation: to.operation },
    addsPrivilege: (from?.privilegeRequirement ?? 'none') !== 'elevated' && to.privilegeRequirement === 'elevated',
    addsNetwork: (from?.networkRequirement ?? 'none') !== 'required' && to.networkRequirement === 'required',
    addsOperation: !from || from.operation !== to.operation,
  };
}

/**
 * Create the owner-private recipe store rooted at `root` (the facade passes
 * `<maintenanceControlDir()>/management`). Holds accepted/withdrawn recipes
 * plus a pending queue from the last `refreshRecipes`.
 * @param {{ root: string, fsImpl?: any, now?: () => Date, publisherKeys?: Record<string, string> }} options
 */
export function createRecipeStore({
  root, fsImpl = fs, now = () => new Date(),
  publisherKeys = { [BUILTIN_PUBLISHER_ID]: BUILTIN_PUBLISHER_KEY },
} = /** @type {any} */ ({})) {
  function list() {
    return readStore(root, fsImpl).recipes;
  }

  function events() {
    return readStore(root, fsImpl).events;
  }

  function record(mutate) {
    const envelope = readStore(root, fsImpl);
    mutate(envelope);
    writeStore(root, envelope, fsImpl);
    return envelope;
  }

  /**
   * Verify + stage recipes from a registry refresh. Never activates anything.
   * @param {{ fetchImpl: (url: string) => Promise<any>, registry: { url: string, allowlist: string[], publisherId: string }, current?: any[], maxBytes?: number, maxRedirects?: number }} options
   */
  async function refreshRecipes({
    fetchImpl, registry, current = [], maxBytes = 256 * 1024, maxRedirects = 3,
  } = /** @type {any} */ ({})) {
    const url = new URL(registry?.url ?? '');
    if (url.protocol !== 'https:') throw new Error('recipe registry must be HTTPS');
    if (!Array.isArray(registry?.allowlist) || !registry.allowlist.includes(url.hostname)) {
      throw new Error(`recipe registry host is not allowlisted: ${url.hostname}`);
    }
    const response = await followRedirects(fetchImpl, url.toString(), maxRedirects, registry.allowlist);
    if (response.byteLength > maxBytes) throw new Error('recipe registry response exceeds size limit');
    const payload = JSON.parse(response.bodyText);
    if (!Array.isArray(payload.recipes)) throw new Error('recipe registry response has an invalid schema');
    const incoming = payload.recipes.map((recipe) => verifyIncomingRecipe(recipe, registry.publisherId, publisherKeys));
    const currentById = new Map(current.map((recipe) => [recipe.recipeId, recipe]));
    const diff = incoming.map((recipe) => diffOne(currentById.get(recipe.recipeId), recipe));
    const pending = incoming.map((recipe) => ({ ...recipe, state: 'pending-acceptance' }));
    record((envelope) => {
      envelope.events.push({ kind: 'refresh', at: now().toISOString(), pendingIds: pending.map((r) => r.recipeId) });
      envelope.recipes = mergeRecipes(envelope.recipes, pending);
    });
    return { diff, pending };
  }

  function acceptRecipe({ recipeId, recipeVersion }) {
    return record((envelope) => {
      const recipe = envelope.recipes.find((r) => r.recipeId === recipeId && r.recipeVersion === recipeVersion);
      if (!recipe) throw new Error(`no pending recipe found: ${recipeId}@${recipeVersion}`);
      recipe.state = 'active';
      envelope.events.push({ kind: 'accept', recipeId, recipeVersion, at: now().toISOString() });
    }).recipes.find((r) => r.recipeId === recipeId && r.recipeVersion === recipeVersion);
  }

  function withdrawRecipe({ recipeId, recipeVersion }) {
    return record((envelope) => {
      const recipe = envelope.recipes.find((r) => r.recipeId === recipeId && r.recipeVersion === recipeVersion);
      if (!recipe) throw new Error(`no recipe found to withdraw: ${recipeId}@${recipeVersion}`);
      recipe.state = 'withdrawn';
      envelope.events.push({ kind: 'withdraw', recipeId, recipeVersion, at: now().toISOString() });
    }).recipes.find((r) => r.recipeId === recipeId && r.recipeVersion === recipeVersion);
  }

  return { listRecipes: list, listRecipeEvents: events, refreshRecipes, acceptRecipe, withdrawRecipe };
}

function mergeRecipes(existing, incoming) {
  const byKey = new Map(existing.map((recipe) => [`${recipe.recipeId}@${recipe.recipeVersion}`, recipe]));
  for (const recipe of incoming) byKey.set(`${recipe.recipeId}@${recipe.recipeVersion}`, recipe);
  return [...byKey.values()];
}

function verifyIncomingRecipe(recipe, expectedPublisherId, publisherKeys) {
  assertRecipeShape(recipe);
  if (recipe.publisher !== expectedPublisherId) throw new Error(`recipe publisher mismatch: ${recipe.recipeId}`);
  const verified = verifyRecipe(recipe, { publisherKeys });
  if (!verified.ok) throw new Error(`recipe failed trust verification (${recipe.recipeId}): ${verified.reason}`);
  return recipe;
}

async function followRedirects(fetchImpl, url, maxRedirects, allowlist) {
  let target = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetchImpl(target);
    if (!response.redirected) return response;
    const nextUrl = new URL(response.url ?? '');
    if (nextUrl.protocol !== 'https:' || !allowlist.includes(nextUrl.hostname)) {
      throw new Error('recipe registry redirected outside the allowlist');
    }
    if (hop === maxRedirects) throw new Error('recipe registry exceeded the redirect bound');
    target = nextUrl.toString();
  }
  throw new Error('recipe registry exceeded the redirect bound');
}

/** A stable placeholder token so a caller can generate a fresh nonce for
 *  test fixtures without depending on this module's internal RNG. */
export function randomToken() {
  return randomBytes(8).toString('hex');
}

export const RECIPE_STATE_LIST = RECIPE_STATES;
