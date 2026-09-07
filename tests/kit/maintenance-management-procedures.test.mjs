// ADR-0048 Procedures, recipes, and package-manager capability tests
// (MNT-ACT-007..020, J8). Nothing here spawns a process; `refreshRecipes`
// takes an injected `fetchImpl`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isProhibitedLabel } from '../../src/lib/maintenance/management/model.mjs';
import {
  allPackageManagerCapabilities, isWithinTestedContract, packageManagerCapabilities,
  releaseModel, supportedRange,
} from '../../src/lib/maintenance/management/package-managers.mjs';
import { createChecklistStore, describeCopy, renderProcedure } from '../../src/lib/maintenance/management/procedures.mjs';
import {
  BUILTIN_PUBLISHER_ID, BUILTIN_RECIPES, createRecipeStore, findCompatibleRecipes, signRecipe, verifyRecipe,
} from '../../src/lib/maintenance/management/recipes.mjs';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-mgmt-recipes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// ── Built-in catalogue ───────────────────────────────────────────────────────

test('every built-in recipe verifies against the bundled publisher key', () => {
  for (const recipe of BUILTIN_RECIPES) {
    assert.equal(recipe.publisher, BUILTIN_PUBLISHER_ID);
    assert.equal(verifyRecipe(recipe).ok, true);
  }
});

test('required built-in recipes exist: lightpanda reinstall, Claude MCP removal, Codex/npm/pnpm update, Ollama pull, elevated apt', () => {
  const ids = new Set(BUILTIN_RECIPES.map((r) => r.recipeId));
  for (const required of [
    'reinstall-lightpanda-homebrew', 'reinstall-lightpanda-npm', 'claude-mcp-remove-registration',
    'codex-plugin-update-steps', 'npm-global-update-steps', 'pnpm-global-update-steps',
    'ollama-model-pull-update-steps', 'apt-elevated-example-steps',
  ]) assert.ok(ids.has(required), `missing built-in recipe: ${required}`);
});

test('an elevated recipe never solicits a password (MNT-ACT-009)', () => {
  const elevated = BUILTIN_RECIPES.filter((r) => r.privilegeRequirement === 'elevated');
  assert.ok(elevated.length > 0);
  for (const recipe of elevated) assert.equal(recipe.solicitsPassword, false);
});

test('signRecipe/verifyRecipe round-trip and detect a tampered field', () => {
  const signed = signRecipe({
    schema: 'maintenance-procedure-recipe/v1', recipeId: 'custom-recipe', recipeVersion: '1',
    publisher: BUILTIN_PUBLISHER_ID, sourceAuthority: 'Test', shell: 'bash', operation: 'update',
    privilegeRequirement: 'none', networkRequirement: 'none', expectedEffect: 'Does a thing.',
    preservedResources: [], verification: 'true',
  });
  assert.equal(verifyRecipe(signed).ok, true);
  const tampered = { ...signed, expectedEffect: 'Does a DIFFERENT thing.' };
  assert.equal(verifyRecipe(tampered).ok, false);
});

test('an unknown publisher fails verification (allowlist enforcement)', () => {
  const recipe = { ...BUILTIN_RECIPES[0], publisher: 'someone-else' };
  assert.equal(verifyRecipe(recipe).ok, false);
});

// ── findCompatibleRecipes ────────────────────────────────────────────────────

test('findCompatibleRecipes matches the lightpanda dependency on macOS and excludes an unrelated dependency', () => {
  const compatible = findCompatibleRecipes(BUILTIN_RECIPES, {
    placement: { kind: 'mcp-registration', consumerHosts: ['claude'] },
    environment: { kind: 'macos', osFamily: 'darwin' },
    resourceKind: 'mcp-registration', condition: 'missing-verified-dependency', dependencyRequirement: 'lightpanda',
  });
  assert.ok(compatible.some((r) => r.recipeId === 'reinstall-lightpanda-homebrew'));
  const unrelated = findCompatibleRecipes(BUILTIN_RECIPES, {
    placement: { kind: 'mcp-registration', consumerHosts: ['claude'] },
    resourceKind: 'mcp-registration', condition: 'missing-verified-dependency', dependencyRequirement: 'some-other-tool',
  });
  assert.equal(unrelated.some((r) => r.recipeId.startsWith('reinstall-lightpanda')), false);
});

test('a withdrawn recipe is excluded from findCompatibleRecipes (MNT-ACT-020)', () => {
  const withdrawn = { ...BUILTIN_RECIPES[0], state: 'withdrawn' };
  const compatible = findCompatibleRecipes([withdrawn], {
    resourceKind: withdrawn.resourceKind, condition: withdrawn.triggerCondition, dependencyRequirement: withdrawn.dependencyRequirement,
  });
  assert.equal(compatible.length, 0);
});

test('host-scoped recipes only match a placement whose consumerHosts include that host', () => {
  const codexOnly = BUILTIN_RECIPES.find((r) => r.recipeId === 'codex-plugin-update-steps');
  const forCodex = findCompatibleRecipes([codexOnly], {
    placement: { kind: 'plugin', consumerHosts: ['codex'] }, resourceKind: 'plugin', condition: 'update-candidate-present',
  });
  assert.equal(forCodex.length, 1);
  const forClaude = findCompatibleRecipes([codexOnly], {
    placement: { kind: 'plugin', consumerHosts: ['claude'] }, resourceKind: 'plugin', condition: 'update-candidate-present',
  });
  assert.equal(forClaude.length, 0);
});

// ── renderProcedure: the nine-part panel + shell escaping ──────────────────

test('renderProcedure produces the nine-part panel with a copyable, never-executed command', () => {
  const recipe = BUILTIN_RECIPES.find((r) => r.recipeId === 'reinstall-lightpanda-homebrew');
  const rendered = renderProcedure(recipe, {});
  assert.equal(rendered.outcome, recipe.expectedEffect);
  assert.equal(rendered.source.recipeVersion, recipe.recipeVersion);
  assert.ok(rendered.compatibility);
  assert.equal(rendered.privilege, 'none');
  assert.equal(rendered.network, 'required');
  assert.ok(Array.isArray(rendered.preserved) && rendered.preserved.length > 0);
  assert.equal(typeof rendered.command.text, 'string');
  assert.equal(rendered.verification.text, recipe.verification);
  assert.ok(Array.isArray(rendered.checklist) && rendered.checklist.length > 0);
  assert.equal(rendered.nextStepLabel, 'Verify after completing these steps');
  assert.equal(isProhibitedLabel(rendered.outcome), false);
});

test('shell precedence: explicit shell > preferredShell > recipe default (MNT-ACT-017)', () => {
  const recipe = BUILTIN_RECIPES.find((r) => r.recipeId === 'reinstall-lightpanda-homebrew'); // recipe.shell === 'zsh'
  assert.equal(renderProcedure(recipe, {}).command.shell, 'zsh');
  assert.equal(renderProcedure(recipe, { preferredShell: 'bash' }).command.shell, 'bash');
  assert.equal(renderProcedure(recipe, { shell: 'powershell', preferredShell: 'bash' }).command.shell, 'powershell');
});

test('an unknown shell is rejected', () => {
  const recipe = BUILTIN_RECIPES[0];
  assert.throws(() => renderProcedure(recipe, { shell: 'fish' }), TypeError);
});

function withPackage(recipe, value) {
  return { ...recipe, typedArguments: { ...recipe.typedArguments, package: value } };
}

test('a discovered "$(rm -rf ~)" value can never become executable syntax in bash/zsh (single-quoted, inert)', () => {
  const recipe = BUILTIN_RECIPES.find((r) => r.recipeId === 'reinstall-lightpanda-homebrew');
  const evil = withPackage(recipe, '$(rm -rf ~)');
  const text = renderProcedure(evil, { shell: 'bash' }).command.text;
  // The dangerous payload must be fully wrapped in a single-quoted token —
  // single quotes disable ALL expansion in POSIX shells, so $(...) is inert.
  assert.match(text, /'\$\(rm -rf ~\)'/);
});

test('a discovered "; whoami" value stays inside one quoted token in every shell rendering', () => {
  const recipe = BUILTIN_RECIPES.find((r) => r.recipeId === 'reinstall-lightpanda-homebrew');
  const evil = withPackage(recipe, 'x; whoami');
  assert.match(renderProcedure(evil, { shell: 'bash' }).command.text, /'x; whoami'/);
  assert.match(renderProcedure(evil, { shell: 'zsh' }).command.text, /'x; whoami'/);
  assert.match(renderProcedure(evil, { shell: 'powershell' }).command.text, /'x; whoami'/);
  assert.match(renderProcedure(evil, { shell: 'cmd' }).command.text, /"x; whoami"/);
});

test('an embedded quote character is escaped rather than closing the token early', () => {
  const recipe = BUILTIN_RECIPES.find((r) => r.recipeId === 'reinstall-lightpanda-homebrew');
  const evil = withPackage(recipe, "it's-a-test");
  const bash = renderProcedure(evil, { shell: 'bash' }).command.text;
  // POSIX escape for an embedded ' inside a '...'-quoted token is '\''.
  assert.match(bash, /'it'\\''s-a-test'/);
  const cmd = renderProcedure(withPackage(recipe, 'a"b'), { shell: 'cmd' }).command.text;
  assert.match(cmd, /"a""b"/);
});

test('describeCopy names what was copied and never contains a path', () => {
  assert.equal(describeCopy('command'), 'Command copied.');
  assert.equal(describeCopy('verification'), 'Verification command copied.');
  assert.doesNotMatch(describeCopy('command'), /[/\\]/);
});

// ── Checklist store ──────────────────────────────────────────────────────────

test('checklist state persists per guidanceId across store instances', (t) => {
  const root = tempRoot(t);
  const first = createChecklistStore({ root, now: () => new Date('2026-09-05T12:00:00Z') });
  first.setStepDone('gid_1', 'review', true);
  const second = createChecklistStore({ root });
  assert.deepEqual(second.getChecklist('gid_1').done, { review: true });
});

test('an unset checklist returns an empty, well-shaped default', (t) => {
  const root = tempRoot(t);
  const store = createChecklistStore({ root });
  assert.deepEqual(store.getChecklist('gid_never_seen'), { done: {}, updatedAt: null });
});

// ── Package managers (MNT-ACT-018, N-3) ─────────────────────────────────────

test('every PACKAGE_MANAGERS entry has a capability row with a release model', () => {
  const rows = allPackageManagerCapabilities();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.id, packageManagerCapabilities(row.id).id);
    assert.ok(['semver', 'os-coupled', 'rolling'].includes(releaseModel(row.id)));
  }
});

test('semver N-3: current major plus three preceding majors are supported, older majors are not', () => {
  assert.equal(isWithinTestedContract('npm', '17.0.0', { current: '20.0.0' }), true);
  assert.equal(isWithinTestedContract('npm', '20.0.0', { current: '20.0.0' }), true);
  assert.equal(isWithinTestedContract('npm', '16.0.0', { current: '20.0.0' }), false);
  assert.equal(isWithinTestedContract('npm', '21.0.0', { current: '20.0.0' }), false);
});

test('os-coupled N-3 uses the supplied release-family order, not raw version numbers', () => {
  const familyOrder = ['ubuntu-18.04', 'ubuntu-20.04', 'ubuntu-22.04', 'ubuntu-24.04'];
  assert.equal(isWithinTestedContract('apt', 'ubuntu-18.04', { current: 'ubuntu-24.04', familyOrder }), true);
  const result = supportedRange('apt', 'debian-11', { current: 'ubuntu-24.04', familyOrder });
  assert.equal(result.supported, null); // unknown family: never assumed supported
});

test('rolling managers compare against a documented minimum tested version', () => {
  assert.equal(isWithinTestedContract('homebrew', '4.2.0', { minimumTested: '4.0.0' }), true);
  assert.equal(isWithinTestedContract('homebrew', '3.9.0', { minimumTested: '4.0.0' }), false);
});

test('an undeterminable range reports supported: null rather than assuming compatibility', () => {
  assert.equal(supportedRange('npm', '18.0.0', {}).supported, null);
  assert.equal(isWithinTestedContract('npm', '18.0.0', {}), false);
});

test('an unknown package manager is rejected', () => {
  assert.throws(() => packageManagerCapabilities('nonexistent'), TypeError);
});

// ── J8: recipe refresh, diff, acceptance, withdrawal ────────────────────────

function fakeFetch(responses) {
  let call = 0;
  return async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return response;
  };
}

test('J8: a refresh that adds elevation surfaces the diff but keeps the previous recipe active until acceptance', async (t) => {
  const root = tempRoot(t);
  const store = createRecipeStore({ root, now: () => new Date('2026-09-05T12:00:00Z') });
  const current = { ...BUILTIN_RECIPES[0] };
  const elevated = signRecipe({ ...current, privilegeRequirement: 'elevated', recipeVersion: '2' });
  const fetchImpl = fakeFetch([{ redirected: false, byteLength: 1024, bodyText: JSON.stringify({ recipes: [elevated] }) }]);

  const { diff, pending } = await store.refreshRecipes({
    fetchImpl, registry: { url: 'https://recipes.agentic-kit.dev/v1.json', allowlist: ['recipes.agentic-kit.dev'], publisherId: BUILTIN_PUBLISHER_ID }, current: [current],
  });

  assert.equal(diff.length, 1);
  assert.equal(diff[0].addsPrivilege, true);
  assert.equal(diff[0].addsNetwork, false);
  assert.equal(pending[0].state, 'pending-acceptance');
  // Not yet active: findCompatibleRecipes over the STORE's list still excludes it.
  assert.equal(store.listRecipes().find((r) => r.recipeVersion === '2').state, 'pending-acceptance');

  const accepted = store.acceptRecipe({ recipeId: elevated.recipeId, recipeVersion: '2' });
  assert.equal(accepted.state, 'active');
});

test('J8: withdrawing a recipe keeps it in history but findCompatibleRecipes excludes it', (t) => {
  const root = tempRoot(t);
  const store = createRecipeStore({ root });
  const custom = signRecipe({
    schema: 'maintenance-procedure-recipe/v1', recipeId: 'custom-withdraw-test', recipeVersion: '1',
    publisher: BUILTIN_PUBLISHER_ID, sourceAuthority: 'Test', shell: 'bash', operation: 'update',
    resourceKind: 'executable', privilegeRequirement: 'none', networkRequirement: 'none',
    expectedEffect: 'x', preservedResources: [], verification: 'true',
  });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'recipes.json'), JSON.stringify({ schemaVersion: 'maintenance-recipe-store/v1', recipes: [custom], events: [] }));
  const withdrawn = store.withdrawRecipe({ recipeId: custom.recipeId, recipeVersion: custom.recipeVersion });
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal(store.listRecipes().length, 1); // still present in history
  const compatible = findCompatibleRecipes(store.listRecipes(), { resourceKind: 'executable' });
  assert.equal(compatible.length, 0);
});

test('refreshRecipes rejects a non-allowlisted host', async (t) => {
  const root = tempRoot(t);
  const store = createRecipeStore({ root });
  await assert.rejects(() => store.refreshRecipes({
    fetchImpl: fakeFetch([]), registry: { url: 'https://evil.example.com/v1.json', allowlist: ['recipes.agentic-kit.dev'], publisherId: BUILTIN_PUBLISHER_ID }, current: [],
  }));
});

test('refreshRecipes rejects a non-HTTPS registry URL', async (t) => {
  const root = tempRoot(t);
  const store = createRecipeStore({ root });
  await assert.rejects(() => store.refreshRecipes({
    fetchImpl: fakeFetch([]), registry: { url: 'http://recipes.agentic-kit.dev/v1.json', allowlist: ['recipes.agentic-kit.dev'], publisherId: BUILTIN_PUBLISHER_ID }, current: [],
  }));
});

test('refreshRecipes rejects a response over the byte-size bound', async (t) => {
  const root = tempRoot(t);
  const store = createRecipeStore({ root });
  const oversized = { redirected: false, byteLength: 10_000_000, bodyText: '{"recipes":[]}' };
  await assert.rejects(() => store.refreshRecipes({
    fetchImpl: fakeFetch([oversized]), registry: { url: 'https://recipes.agentic-kit.dev/v1.json', allowlist: ['recipes.agentic-kit.dev'], publisherId: BUILTIN_PUBLISHER_ID }, current: [], maxBytes: 1024,
  }));
});

test('refreshRecipes follows an allowlisted redirect but rejects a redirect off the allowlist', async (t) => {
  const root = tempRoot(t);
  const store = createRecipeStore({ root });
  const target = signRecipe({ ...BUILTIN_RECIPES[0], recipeVersion: '9' });
  const goodChain = fakeFetch([
    { redirected: true, url: 'https://recipes.agentic-kit.dev/v2.json' },
    { redirected: false, byteLength: 512, bodyText: JSON.stringify({ recipes: [target] }) },
  ]);
  const { pending } = await store.refreshRecipes({
    fetchImpl: goodChain, registry: { url: 'https://recipes.agentic-kit.dev/v1.json', allowlist: ['recipes.agentic-kit.dev'], publisherId: BUILTIN_PUBLISHER_ID }, current: [],
  });
  assert.equal(pending[0].recipeId, target.recipeId);

  const badChain = fakeFetch([{ redirected: true, url: 'https://evil.example.com/v2.json' }]);
  await assert.rejects(() => store.refreshRecipes({
    fetchImpl: badChain, registry: { url: 'https://recipes.agentic-kit.dev/v1.json', allowlist: ['recipes.agentic-kit.dev'], publisherId: BUILTIN_PUBLISHER_ID }, current: [],
  }));
});

test('refreshRecipes rejects a recipe signed by a publisher other than the registry\'s declared publisher', async (t) => {
  const root = tempRoot(t);
  const store = createRecipeStore({ root });
  const wrongPublisher = { ...signRecipe({ ...BUILTIN_RECIPES[0], recipeVersion: '9' }), publisher: 'someone-else' };
  await assert.rejects(() => store.refreshRecipes({
    fetchImpl: fakeFetch([{ redirected: false, byteLength: 512, bodyText: JSON.stringify({ recipes: [wrongPublisher] }) }]),
    registry: { url: 'https://recipes.agentic-kit.dev/v1.json', allowlist: ['recipes.agentic-kit.dev'], publisherId: BUILTIN_PUBLISHER_ID }, current: [],
  }));
});
