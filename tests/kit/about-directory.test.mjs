// about-directory.test.mjs — the gate ADR-0026 §3 promises: "completeness is a gate, not a
// hope". The About area's cards are authored copy, and authored copy is exactly the kind of
// thing that quietly stops matching reality — a tool gets added to the kit, ships, and never
// grows a card, or a card outlives the tool it introduces. Review cannot catch that reliably;
// a test can.
//
// The parity gate below therefore reads the AUTHORITATIVE REGISTRIES, not a list kept here:
// the host registry (src/lib/adapters), the managed-tool catalog the System area measures
// (src/lib/footprint/install.mjs), and the maintainer contract's own tools table
// (docs/MANAGED-TOOLS.md). Three independent authorities, all of which a new tool must pass
// through, so no single omission can let it ship uncarded. The reverse direction is checked
// against ak's own source: a card for a package ak never installs, or a "configured surface"
// naming a command ak does not ship, is a lie the same gate fails on.
//
// The register-contract tests cover only the MECHANICAL half of the editorial rules
// (docs/ddd/component-directory.md). Tone, accuracy, and plain language stay a review duty —
// length, superlatives, and the chip-vocabulary boundary do not have to be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORY_ORDER, directoryEntries, entryById, entriesByCategory,
} from '../../src/lib/dashboard/about-directory.mjs';
import { HOST_REGISTRY } from '../../src/lib/adapters/index.mjs';
import { managedTools } from '../../src/lib/footprint/install.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODULE_PATH = path.join(ROOT, 'src/lib/dashboard/about-directory.mjs');
const MODULE_URL = new URL('../../src/lib/dashboard/about-directory.mjs', import.meta.url).href;

const ENTRIES = directoryEntries();
// The discriminator the directory itself uses: a configured surface is not a package, so it
// carries the status row its chip joins on and the command that changes it, never a version.
const isConfigured = (entry) => entry.category === 'configured';
const packagedEntries = () => ENTRIES.filter((entry) => !isConfigured(entry));

const words = (text) => String(text).split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word));

/** Every identity a card may legitimately be found by. A managed tool is named differently
 *  by each authority — the host registry knows `claude`, npm knows `@anthropic-ai/claude-code`,
 *  the directory calls the card `claude-code` — so resolution accepts any of the three rather
 *  than forcing one authority's spelling onto the editorial ids. */
function identityIndex() {
  const index = new Map();
  for (const entry of ENTRIES) {
    for (const key of [entry.id, entry.npmPackage, entry.detectionKey].filter(Boolean)) {
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(entry);
    }
  }
  return index;
}

const resolveEntries = (index, key) => [...(index.get(key) ?? [])];

/** The tool names in the managed-tools contract's own table. Parsed rather than transcribed:
 *  a transcript would drift the moment the table gains a row, which is the drift this gate
 *  exists to catch. An empty parse fails the test — a restructured doc must be re-read, not
 *  silently believed. */
function managedToolsDocRows() {
  const doc = readFileSync(path.join(ROOT, 'docs/MANAGED-TOOLS.md'), 'utf8');
  const section = doc.split(/^## /m).find((part) => part.startsWith('The tools'));
  assert.ok(section, 'docs/MANAGED-TOOLS.md must still have a "## The tools" section');
  return [...section.matchAll(/^\|\s*\*\*(.+?)\*\*/gm)].map((match) => match[1].trim());
}

/** Two rows in that table name something other than a package id: `hosts` is a family (it
 *  expands through the host registry, asserted separately) and `kit (self)` is ak reporting on
 *  itself under its status key. Every other row must resolve on its own name — an unrecognized
 *  row is a new managed tool and fails. */
const DOC_ROW_ALIASES = Object.freeze({ hosts: null, 'kit (self)': 'self' });

/** Every .mjs/.cjs line ak ships, minus the directory itself — the evidence that a packaged
 *  card names a package ak's own code actually installs, pins, or detects. */
function kitSource() {
  const chunks = [];
  const walk = (dir) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) walk(full);
      else if (/\.(mjs|cjs)$/.test(dirent.name) && full !== MODULE_PATH) {
        chunks.push(readFileSync(full, 'utf8'));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return chunks.join('\n');
}

/** The commands ak actually dispatches, read from the CLI's own dispatch tables so a renamed
 *  command surfaces here as a broken "yours to change" promise. */
function shippedCommands() {
  const bin = readFileSync(path.join(ROOT, 'bin/agentic-kit.mjs'), 'utf8');
  const table = (name) => {
    const start = bin.indexOf(`const ${name} = `);
    assert.notEqual(start, -1, `bin/agentic-kit.mjs must still declare ${name}`);
    const block = bin.slice(start, bin.indexOf('});', start));
    const keys = new Set([...block.matchAll(/^\s*'?([\w-]+)'?:\s*\(\)\s*=>/gm)].map((m) => m[1]));
    assert.ok(keys.size > 0, `${name} must parse to at least one command`);
    return keys;
  };
  return { porcelain: table('PORCELAIN'), plumbing: table('PLUMBING') };
}

// ---------------------------------------------------------------------------------------
// The parity gate (ADR-0026 §3, component-directory invariant 4)
//
// Scope: every assertion below walks HOST_REGISTRY / managedTools(), i.e. the BUILT-IN
// adapter set — there is no dynamic or third-party host concept yet (see
// src/lib/adapters/lifecycle-registry.mjs), so "built-in" and "the registry" are the same
// set today. That makes this gate built-in-scoped by construction: an externally-admitted
// adapter (wave-4 adapter-extension contract) is exempt from directory-card parity until
// that contract graduates it into a card-carrying citizen — it will not appear in
// HOST_REGISTRY / managedTools() until it does, so it cannot trip these assertions.
// ---------------------------------------------------------------------------------------

test('every managed tool has exactly one directory entry (registry → directory)', () => {
  const index = identityIndex();
  const missing = [];
  const duplicated = [];

  // Hosts resolve on their detection key, not their npm name, because the chip joins on
  // `hosts.<id>` — checking the key the renderer uses is what proves the card can be filled.
  for (const host of HOST_REGISTRY) {
    const matched = ENTRIES.filter((entry) => entry.detectionKey === `hosts.${host.id}`);
    if (!matched.length) missing.push(`host '${host.id}' (${host.label})`);
    if (matched.length > 1) duplicated.push(`host '${host.id}' → ${matched.map((e) => e.id)}`);
    if (matched.length === 1) {
      assert.equal(matched[0].npmPackage, host.install.npmPackage,
        `${matched[0].id} must name the package the host registry installs`);
    }
  }

  // The catalog the System area measures: anything with bytes on disk is a thing the user
  // can see occupying their machine, so it is a thing About owes an explanation for.
  for (const tool of managedTools()) {
    const key = tool.pkg ?? tool.id;
    const matched = resolveEntries(index, key);
    if (!matched.length) missing.push(`managed tool '${tool.id}' (${key})`);
    if (matched.length > 1) duplicated.push(`managed tool '${key}' → ${matched.map((e) => e.id)}`);
  }

  assert.deepEqual(missing, [],
    'these managed tools have no About card — add a directory entry before shipping them');
  assert.deepEqual(duplicated, [], 'a managed tool must map to exactly ONE card');
});

test('the managed-tools contract names no tool the directory omits', () => {
  const index = identityIndex();
  const rows = managedToolsDocRows();
  assert.ok(rows.length >= 5, `docs/MANAGED-TOOLS.md tools table parsed to ${rows.length} rows`);

  const missing = [];
  for (const row of rows) {
    if (row in DOC_ROW_ALIASES && DOC_ROW_ALIASES[row] === null) continue; // asserted above
    const key = DOC_ROW_ALIASES[row] ?? row;
    if (!resolveEntries(index, key).length) missing.push(`${row} (looked up as '${key}')`);
  }
  assert.deepEqual(missing, [],
    'MANAGED-TOOLS.md documents these tools but About introduces none of them');

  // The family row is the one that cannot resolve by name; prove it is covered by ids.
  assert.equal(
    ENTRIES.filter((entry) => entry.detectionKey?.startsWith('hosts.')).length,
    HOST_REGISTRY.length,
    'one host card per registered host, no more',
  );
});

test('every configured surface ADR-0026 promises has exactly one card', () => {
  // Configured surfaces have no package registry to be measured against — the ADR's own
  // layout is their authority, so it is what gets parsed. Both directions again: a surface
  // ak sets up but never explains is the same failure as a card for a surface ak never
  // touches, and deleting a card must not be able to pass quietly.
  const adr = readFileSync(path.join(ROOT, 'docs/adr/0026-about-component-directory.md'), 'utf8');
  const listed = adr.match(/Non-package surfaces:([\s\S]*?)—/);
  assert.ok(listed, 'ADR-0026 must still enumerate the non-package surfaces');
  // Singular/plural is a copy choice ("permission allowlists" / "Permission allowlist"), so
  // the comparison is on identity, not on the exact words the two documents chose.
  const norm = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
  const promised = listed[1].replace(/\s+/g, ' ').split(',').map((name) => name.trim())
    .filter(Boolean).map(norm);
  assert.ok(promised.length >= 5, `ADR-0026 parsed to ${promised.length} configured surfaces`);

  const carded = ENTRIES.filter(isConfigured).map((entry) => norm(entry.name));
  assert.deepEqual([...carded].sort(), [...promised].sort(),
    'the "Configured for you" cards and the surfaces ADR-0026 promises must be the same set');
});

test('no directory entry exists for something ak neither installs nor configures', () => {
  const source = kitSource();
  const { porcelain, plumbing } = shippedCommands();
  const unjustified = [];

  for (const entry of ENTRIES) {
    if (isConfigured(entry)) {
      // A configured surface's claim is "ak set this up and you can change it" — the second
      // half is falsifiable, so it is what gets checked.
      const [ak, first, second] = String(entry.manage).split(/\s+/);
      assert.equal(ak, 'ak', `${entry.id}: manage command must be an ak command`);
      const known = first === 'x' ? plumbing.has(second) : porcelain.has(first);
      if (!known) unjustified.push(`${entry.id}: '${entry.manage}' is not a command ak ships`);
      continue;
    }
    // A packaged card claims ak installs, pins, or detects that package. ak's own source is
    // the only place that could be true, so the package name has to appear in it — as a
    // literal, not as a substring of some unrelated path.
    const quoted = ['\'', '"', '`'].some((q) => source.includes(`${q}${entry.npmPackage}${q}`));
    if (!quoted) {
      unjustified.push(`${entry.id}: ak's source never names the package '${entry.npmPackage}'`);
    }
  }

  assert.deepEqual(unjustified, [],
    'About must not introduce components ak does not install or configure');
});

test('each entry is a package ak manages or a surface ak configures, never both', () => {
  const ids = ENTRIES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'directory ids must be unique');

  for (const entry of ENTRIES) {
    assert.ok(CATEGORY_ORDER.includes(entry.category), `${entry.id}: unknown category`);
    assert.match(entry.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${entry.id}: id must be kebab-case`);
    assert.ok(entry.name?.length, `${entry.id}: name is required`);
    if (isConfigured(entry)) {
      assert.ok(entry.subsystem?.length, `${entry.id}: configured surface needs a status row key`);
      assert.ok(entry.manage?.length, `${entry.id}: configured surface needs a manage command`);
      assert.equal(entry.detectionKey, undefined, `${entry.id}: a surface is not a package`);
      assert.equal(entry.npmPackage, undefined, `${entry.id}: a surface is not a package`);
    } else {
      assert.ok(entry.detectionKey?.length, `${entry.id}: packaged entry needs a detection key`);
      assert.ok(entry.npmPackage?.length, `${entry.id}: packaged entry needs its package name`);
      assert.equal(entry.subsystem, undefined, `${entry.id}: a package is not a configured row`);
    }
  }

  for (const field of ['detectionKey', 'npmPackage']) {
    const seen = packagedEntries().map((entry) => entry[field]);
    assert.equal(new Set(seen).size, seen.length, `two cards share a ${field} — one tool, one card`);
  }
  const subsystems = ENTRIES.filter(isConfigured).map((entry) => entry.subsystem);
  assert.equal(new Set(subsystems).size, subsystems.length,
    'two surfaces share a status row — one surface, one card');
});

// ---------------------------------------------------------------------------------------
// The register contract (docs/ddd/component-directory.md), mechanical half
// ---------------------------------------------------------------------------------------

test('taglines stay inside their ten-word budget and read as one line', () => {
  for (const entry of ENTRIES) {
    const count = words(entry.tagline).length;
    assert.ok(count <= 10, `${entry.id}: tagline is ${count} words (max 10) — "${entry.tagline}"`);
    assert.ok(count >= 3, `${entry.id}: tagline is too short to say anything`);
    assert.doesNotMatch(entry.tagline, /\n/, `${entry.id}: tagline must be one line`);
    assert.match(entry.tagline, /\.$/, `${entry.id}: tagline is a sentence and ends like one`);
  }
});

test('each paragraph is ONE paragraph inside the ~50-word band', () => {
  for (const entry of ENTRIES) {
    // The card's height is designed around this band (docs/assets/about-tab-mock.html); a
    // paragraph outside it either says nothing or turns the card back into documentation.
    const count = words(entry.paragraph).length;
    assert.ok(count >= 40 && count <= 58,
      `${entry.id}: paragraph is ${count} words, outside the 40–58 band around ~50`);
    assert.doesNotMatch(entry.paragraph, /\n/, `${entry.id}: paragraph must be a single paragraph`);
    assert.doesNotMatch(entry.paragraph, / {2,}/, `${entry.id}: collapsed whitespace only`);
    assert.match(entry.paragraph, /^["'A-Z]/, `${entry.id}: paragraph starts a sentence`);
    assert.match(entry.paragraph, /[.?]["']?$/, `${entry.id}: paragraph ends a sentence`);
  }
});

test('no marketing superlatives anywhere in the authored copy', () => {
  // Claims detection cannot back. The card's job is to say what the thing does for the user;
  // "blazing" is not a fact the dashboard could ever render a chip for. Exclamation marks are
  // banned by the same rule — warmth comes from clarity, not punctuation.
  const superlatives = new RegExp([
    'best', 'best-in-class', 'fastest', 'blazing(?:ly)?', 'world-class', 'industry-leading',
    'cutting-edge', 'state-of-the-art', 'next-generation', 'revolutionary', 'seamless(?:ly)?',
    'effortless(?:ly)?', 'powerful', 'unparalleled', 'unmatched', 'magical', 'amazing',
    'incredible', 'awesome', 'ultimate', 'supercharges?d?', 'game-changing', 'lightning-fast',
    'enterprise-grade', 'military-grade', 'robust', 'simply', 'just works', '10x',
  ].map((word) => `\\b${word}\\b`).join('|'), 'i');

  for (const entry of ENTRIES) {
    for (const [field, text] of [['tagline', entry.tagline], ['paragraph', entry.paragraph]]) {
      const hit = text.match(superlatives);
      assert.equal(hit, null, `${entry.id}.${field}: superlative "${hit?.[0]}" — say what it does`);
      assert.doesNotMatch(text, /!/, `${entry.id}.${field}: no exclamation marks`);
    }
  }
});

test('prose never claims runtime state — installed/running/healthy belong to the chip', () => {
  // The chip vocabulary, banned outright from the tagline (too short for any other reading)
  // and banned from the paragraph wherever it is PREDICATED of the component: "is installed",
  // "already running", "stays healthy". A causative sentence about what ak does for a
  // component ("keeps it healthy") is a statement of purpose that reads true on a machine
  // where the component is absent, which is the invariant's actual test (component-directory
  // invariant 3) — the ban exists so a card can never contradict its own honest chip.
  const chipWords = /\b(installed|running|healthy)\b/i;
  const predicated = new RegExp(
    '\\b(?:is|are|was|were|be|been|being|stays?|remains?|already|currently|now|not)\\s+'
    + '(?:\\w+\\s+){0,2}?(installed|running|healthy)\\b', 'i',
  );

  for (const entry of ENTRIES) {
    const inTagline = entry.tagline.match(chipWords);
    assert.equal(inTagline, null,
      `${entry.id}.tagline: "${inTagline?.[0]}" is a chip word, not editorial copy`);
    const claim = entry.paragraph.match(predicated);
    assert.equal(claim, null,
      `${entry.id}.paragraph: "${claim?.[0]}" claims runtime state the chip owns`);
    assert.doesNotMatch(entry.paragraph, /\bnot installed\b|\bup and running\b/i,
      `${entry.id}.paragraph: state phrasing belongs to the chip`);
  }
});

// ---------------------------------------------------------------------------------------
// Links, order, icons (invariants 5, 9, 10)
// ---------------------------------------------------------------------------------------

test('every link is https and carries kind, label, and url', () => {
  const kinds = new Set(['github', 'npm', 'docs']);
  for (const entry of ENTRIES) {
    assert.ok(Array.isArray(entry.links), `${entry.id}: links must be an array`);
    const seen = new Set();
    for (const link of entry.links) {
      const where = `${entry.id} link ${link.kind ?? '?'}`;
      assert.ok(kinds.has(link.kind), `${where}: unknown link kind`);
      assert.equal(seen.has(link.kind), false, `${where}: one pill per kind`);
      seen.add(link.kind);
      assert.ok(link.label?.length, `${where}: a pill needs a label`);
      assert.match(link.url, /^https:\/\//, `${where}: links are https, user-initiated`);
      const url = new URL(link.url);
      assert.ok(url.hostname.includes('.'), `${where}: needs a named host`);
      assert.equal(url.username, '', `${where}: no credentials in a shipped link`);
      assert.equal(link.url.trim(), link.url, `${where}: no stray whitespace`);
    }
  }
});

test('an npm pill points at the very package its chip reports on', () => {
  // The pill and the chip must be about the same artifact, or a user clicks through from
  // "installed v3.34.0" to a different package's page and the card has lied by juxtaposition.
  for (const entry of packagedEntries()) {
    const npm = entry.links.find((link) => link.kind === 'npm');
    if (!npm) continue;
    assert.equal(npm.url, `https://www.npmjs.com/package/${entry.npmPackage}`,
      `${entry.id}: npm pill must resolve to '${entry.npmPackage}'`);
  }
});

test('packaged cards link out; configured surfaces name a command instead', () => {
  for (const entry of packagedEntries()) {
    assert.ok(entry.links.length >= 1, `${entry.id}: a component card needs its receipts`);
    for (const kind of ['github', 'docs']) {
      assert.ok(entry.links.some((link) => link.kind === kind),
        `${entry.id}: no ${kind} link — the card is an introduction, depth lives behind it`);
    }
  }
  for (const entry of ENTRIES.filter(isConfigured)) {
    // A configured surface has no upstream of its own; the honest substitute for a link pill
    // is the command that changes it, which the parity gate already proved ak ships.
    assert.deepEqual(entry.links, [], `${entry.id}: a configured surface has nothing to link to`);
    assert.match(entry.manage, /^ak /, `${entry.id}: manage command names ak`);
  }
});

test('curated order is stable and follows the documented category sequence', () => {
  assert.deepEqual([...CATEGORY_ORDER], [
    'hosts', 'engine-memory', 'quality', 'safety', 'knowledge', 'kit', 'configured',
  ], 'the category sequence is a documented decision (ADR-0026 §1), not a preference');

  const rank = (entry) => CATEGORY_ORDER.indexOf(entry.category);
  for (let i = 1; i < ENTRIES.length; i += 1) {
    assert.ok(rank(ENTRIES[i]) >= rank(ENTRIES[i - 1]),
      `${ENTRIES[i].id} breaks the curated order — categories may not interleave`);
  }
  assert.equal(ENTRIES[0].category, 'hosts', 'the things a user already recognizes come first');
  assert.equal(ENTRIES.at(-1).category, 'configured', 'configured surfaces come last');
  assert.equal(ENTRIES.find((entry) => entry.category === 'kit').id, 'agentic-kit');

  // Hosts read in registry order so About, Observability, and `ak status` list them alike.
  assert.deepEqual(
    entriesByCategory('hosts').map((entry) => entry.detectionKey),
    HOST_REGISTRY.map((host) => `hosts.${host.id}`),
  );

  assert.deepEqual(entriesByCategory('nonsense'), [], 'an unknown category yields nothing');
  assert.equal(entryById('nope'), null, 'an unknown id is an absence, never a partial card');
  assert.equal(entryById('ruflo').name, 'ruflo');
});

test('official marks are used only for the three hosts; everything else is a monogram', () => {
  const hostIds = new Set(HOST_REGISTRY.map((host) => host.id));
  for (const entry of ENTRIES) {
    assert.ok(entry.icon, `${entry.id}: every card has an icon`);
    if (entry.icon.kind === 'official') {
      assert.equal(entry.category, 'hosts',
        `${entry.id}: only the hosts ship a genuinely official mark`);
      assert.ok(hostIds.has(entry.icon.ref),
        `${entry.id}: official ref must be a host id the dashboard already renders`);
    } else {
      assert.equal(entry.icon.kind, 'monogram', `${entry.id}: icons are official or monogram`);
      assert.match(entry.icon.ref, /^[A-Za-z]{1,2}$/, `${entry.id}: a monogram is its initials`);
      assert.match(entry.icon.hue, /^--[a-z-]+$/, `${entry.id}: hue names a CSS token`);
    }
  }
  assert.equal(ENTRIES.filter((entry) => entry.icon.kind === 'official').length, hostIds.size,
    'no fabricated brand assets, and no host left without its real one');
});

// ---------------------------------------------------------------------------------------
// Purity (invariants 1 and 2: authored, versioned, never generated or fetched)
// ---------------------------------------------------------------------------------------

test('the directory is data: two module instances agree and nothing is rebuilt', async () => {
  // A second, cache-busted instantiation of the same source. Equal data from an independent
  // evaluation proves the catalog is not assembled from anything ambient.
  const twice = await import(`${MODULE_URL}?instance=2`);
  assert.deepEqual(twice.directoryEntries(), ENTRIES);
  assert.notStrictEqual(twice.directoryEntries(), ENTRIES, 'the two instances must be distinct');
  assert.strictEqual(directoryEntries(), ENTRIES, 'accessors return the frozen catalog itself');

  assert.ok(Object.isFrozen(ENTRIES), 'the catalog is frozen');
  for (const entry of ENTRIES) {
    assert.ok(Object.isFrozen(entry), `${entry.id}: entry must be frozen`);
    assert.ok(Object.isFrozen(entry.links), `${entry.id}: links must be frozen`);
    assert.ok(Object.isFrozen(entry.icon), `${entry.id}: icon must be frozen`);
    for (const link of entry.links) assert.ok(Object.isFrozen(link), `${entry.id}: link frozen`);
  }
});

test('the directory module reads nothing — no I/O surface exists in it at all', () => {
  // Editorial content is authored and versioned WITH THE RELEASE (invariant 1) and the
  // directory collects nothing of its own (invariant 2). Both hold structurally as long as
  // this module has no way to reach a filesystem, a network, a clock, or an environment —
  // so the gate is on the source, where the capability would have to appear first.
  const source = readFileSync(MODULE_PATH, 'utf8');
  const forbidden = [
    [/from\s+'node:/, 'imports a node builtin'],
    [/\brequire\s*\(/, 'uses require()'],
    [/\bimport\s*\(/, 'imports dynamically'],
    [/\bprocess\.[a-z]/i, 'reads process state'],
    [/\bfetch\s*\(/, 'fetches'],
    [/new Date\b|Date\.now\b/, 'reads the clock'],
    [/Math\.random\b/, 'is nondeterministic'],
  ];
  for (const [pattern, why] of forbidden) {
    assert.doesNotMatch(source, pattern, `about-directory.mjs ${why} — it must stay pure data`);
  }
});
