// The stack registry and the detection built on it: which languages hold a
// project's lines, which frameworks/SDKs/tools it declares, and everything the
// registry could not name.
//
// Three properties carry the whole design, and each is asserted rather than
// assumed:
//
//   LINES BELONG TO LANGUAGES ONLY. A framework/sdk/tool entry must never carry
//   a line count anywhere — in the registry or in a detection payload. react
//   does not own lines, the .tsx files do, and a bar that stacked both would
//   count the same bytes twice.
//
//   THE UNRECOGNIZED TAIL IS REAL AND RANKED. An extension the registry does
//   not know is never counted as lines and never silently dropped: it is tallied
//   by name so "Other" is a to-do list a release can close.
//
//   MANIFESTS ARE READ SHALLOWLY. A vendored or deeply nested dependency's own
//   manifest must not be mistaken for the project's declarations — on a real
//   machine nearly every Cargo.toml belongs to a registry cache, not a project.
//
// Every fixture lives under mkdtempSync; the registry half needs no filesystem
// at all, which is the point of it being pure data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COLOR_SLOTS, ECOSYSTEMS, MANIFEST_KINDS, NON_SOURCE_EXTENSIONS, REGISTRY_CONFLICTS,
  STACK_REGISTRY, STACK_REGISTRY_VERSION, dependencyEntry, isNonSourceExtension,
  languageForExtension, languageForFilename, manifestKindFor, registryStats,
  signatureEntries, stackEntries, stackEntryById,
} from '../../src/lib/footprint/stack-registry.mjs';
import {
  EXCLUDED_DIRS, EXCLUDED_FILES, MANIFEST_MAX_DEPTH, STACK_EXCLUSIONS,
  detectStack, parseManifestDependencies, stackProvenance,
  isCloudPlaceholder,
} from '../../src/lib/footprint/stack-detect.mjs';

function fixture(t, name) {
  // realpathSync.NATIVE, matching what the collectors canonicalise with. The JS
  // realpath leaves a Windows 8.3 short name alone (C:\Users\RUNNER~1\...) while the
  // native one resolves it to the long form the code under test produces
  // (C:\Users\runneradmin\...). Same directory, two spellings — and every path
  // assertion in this file compared one against the other on Windows only.
  const real = fs.realpathSync.native ?? fs.realpathSync;
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), `ak-fp-stack-${name}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const ids = (rows) => rows.map((row) => row.id);

// ── the registry as pure data ─────────────────────────────────────────────────

test('the registry indexes cleanly — no shadowed entry, no double-decided extension', () => {
  assert.deepEqual(REGISTRY_CONFLICTS, [],
    `duplicate registry keys: ${JSON.stringify(REGISTRY_CONFLICTS)}`);
  assert.equal(new Set(STACK_REGISTRY.map((e) => e.id)).size, STACK_REGISTRY.length);
  assert.match(STACK_REGISTRY_VERSION, /^\d{4}\.\d{2}\.\d+$/);
});

test('every entry stays inside the closed vocabularies it declares against', () => {
  for (const entry of STACK_REGISTRY) {
    assert.ok(ECOSYSTEMS.includes(entry.ecosystem), `${entry.id}: ecosystem ${entry.ecosystem}`);
    assert.ok(['language', 'framework', 'sdk', 'tool'].includes(entry.kind), `${entry.id}`);
    assert.ok(Object.isFrozen(entry), `${entry.id} must be frozen data`);
    if (entry.match.by === 'dependency') {
      for (const manifest of entry.match.manifests) {
        assert.ok(MANIFEST_KINDS.includes(manifest), `${entry.id}: manifest ${manifest}`);
      }
    }
  }
});

test('a framework, sdk or tool NEVER owns lines — only languages do', () => {
  for (const entry of STACK_REGISTRY) {
    if (entry.kind === 'language') {
      assert.equal(entry.match.by, 'extension', `${entry.id} is a language but not extension-matched`);
      assert.ok(COLOR_SLOTS.includes(entry.colorSlot), `${entry.id}: slot ${entry.colorSlot}`);
      assert.ok(entry.match.extensions.length || entry.match.filenames.length, entry.id);
      continue;
    }
    // The structural guarantee: a non-language entry has no extensions and no
    // colour slot, so there is nothing for a renderer to put on a lines bar.
    assert.notEqual(entry.match.by, 'extension', `${entry.id} must not claim extensions`);
    assert.equal(entry.match.extensions, undefined, `${entry.id} must not carry extensions`);
    assert.equal(entry.colorSlot, undefined, `${entry.id} must not carry a lines colour slot`);
    assert.equal(entry.lines, undefined, `${entry.id} must not carry lines`);
  }
  // Vue is deliberately TWO entries — the language that owns `.vue` lines and
  // the framework whose presence is a separate fact.
  assert.equal(stackEntryById('vue').kind, 'language');
  assert.equal(stackEntryById('vue-framework').kind, 'framework');
  assert.equal(stackEntryById('nope'), null);
});

test('extension, filename and manifest lookups answer null rather than guessing', () => {
  assert.equal(languageForExtension('.TSX').id, 'typescript');
  assert.equal(languageForExtension('.rs').id, 'rust');
  assert.equal(languageForExtension('.zzz'), null, 'unknown is null, not a zero bucket');
  assert.equal(languageForExtension(null), null);
  assert.equal(languageForFilename('makefile').id, 'makefile');
  assert.equal(languageForFilename('Dockerfile').id, 'dockerfile');
  assert.equal(languageForFilename('README'), null);

  assert.equal(manifestKindFor('package.json'), 'npm');
  assert.equal(manifestKindFor('Cargo.toml'), 'cargo');
  assert.equal(manifestKindFor('requirements-dev.txt'), 'python');
  assert.equal(manifestKindFor('Gemfile'), 'rubygems');
  assert.equal(manifestKindFor('notes.txt'), null);

  // A name only means something inside ONE manifest family: `openai` is a
  // different package on npm and on PyPI, and `react` is not a Python package.
  assert.equal(dependencyEntry('npm', 'react').id, 'react');
  assert.equal(dependencyEntry('python', 'react'), null);
  assert.equal(dependencyEntry('python', 'FastAPI').id, 'fastapi');
  // Longest prefix wins, so a scoped family never loses to a shorter neighbour.
  assert.equal(dependencyEntry('npm', '@langchain/core').id, 'langchain');
  assert.equal(dependencyEntry('npm', 'not-a-real-package'), null);
  assert.equal(dependencyEntry('npm', ''), null);

  // A stated exclusion is a decision; an unmapped extension is a gap. The two
  // must not be the same answer.
  assert.equal(isNonSourceExtension('.PNG'), true);
  assert.equal(isNonSourceExtension('.zzz'), false);
  assert.equal(new Set(NON_SOURCE_EXTENSIONS).size, NON_SOURCE_EXTENSIONS.length);
});

test('registryStats is the provenance a panel prints, and counts what is there', () => {
  const stats = registryStats();
  assert.equal(stats.version, STACK_REGISTRY_VERSION);
  assert.equal(stats.entries, STACK_REGISTRY.length);
  assert.equal(stats.languages, stackEntries('language').length);
  assert.equal(stats.languages + stats.frameworks + stats.sdks + stats.tools, stats.entries);
  assert.ok(stats.extensions > 100, `only ${stats.extensions} extensions indexed`);
  assert.equal(stats.nonSourceExtensions, NON_SOURCE_EXTENSIONS.length);
  assert.ok(signatureEntries().every((entry) => entry.match.by === 'signature'));
});

// ── manifest parsing, without a filesystem ───────────────────────────────────

test('manifest parsers read KEYS only, and never evaluate their input', () => {
  assert.deepEqual(
    parseManifestDependencies('npm', JSON.stringify({
      dependencies: { react: '^18', local: 'workspace:*' },
      devDependencies: { vitest: '^1' },
    })),
    ['react', 'vitest'], 'a workspace protocol is the project depending on itself');
  assert.equal(parseManifestDependencies('npm', 'not json'), null,
    'unparseable is null — reported as degraded, never as "declares nothing"');

  // Cargo: a path dependency is a workspace member, not a third-party crate.
  assert.deepEqual(
    parseManifestDependencies('cargo',
      '[dependencies]\ntokio = "1"\nsibling = { path = "crates/x" }\n[dev-dependencies]\ncriterion = "0"\n'),
    ['tokio', 'criterion']);

  // pyproject vs requirements.txt share a manifest kind and nothing else; the
  // leading `[` is the discriminator, because no requirement line can start
  // with one.
  assert.deepEqual(
    parseManifestDependencies('python', '[project]\ndependencies = ["FastAPI>=0.1", "httpx"]\n'),
    ['fastapi', 'httpx']);
  assert.deepEqual(
    parseManifestDependencies('python', '# comment\nDjango==5.0\n-r other.txt\nboto3\n'),
    ['django', 'boto3']);

  // go.mod: an indirect requirement is a transitive dependency, not this
  // project's stack.
  assert.deepEqual(
    parseManifestDependencies('gomod',
      'require github.com/spf13/cobra v1.8.0\nrequire golang.org/x/net v0.1.0 // indirect\n'),
    ['github.com/spf13/cobra']);

  assert.ok(parseManifestDependencies('jvm',
    '<groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId>')
    .includes('org.springframework.boot'));
  assert.deepEqual(parseManifestDependencies('hex', '[{:phoenix, "~> 1.7"}, {:ecto, "~> 3.0"}]'),
    ['phoenix', 'ecto']);
  assert.deepEqual(parseManifestDependencies('rubygems', "gem 'rails', '~> 7'\n# gem 'nope'\n"),
    ['rails']);
  assert.deepEqual(
    parseManifestDependencies('pub', 'dependencies:\n  flutter:\n    sdk: flutter\n  dio: ^5\n'),
    ['flutter', 'dio']);
  assert.equal(parseManifestDependencies('unheard-of', 'anything'), null);
});

// ── detection over a real project ────────────────────────────────────────────

/** A project with lines in two languages, one recognized framework, one
 *  unrecognized dependency, an unrecognized-extension tail, a stated non-source
 *  file, and manifests at every depth the bound cares about. */
function project(t) {
  const root = fixture(t, 'detect');
  write(root, 'package.json', JSON.stringify({
    dependencies: { react: '^18', 'totally-unknown-lib': '^1' },
  }));
  write(root, 'src/app.tsx', 'a\nb\nc\n');
  write(root, 'src/util.ts', 'x\ny\n');
  write(root, 'src/index.js', 'one\n');
  // Unrecognized tail: three of one extension, one of another, so the ranking
  // has something to rank.
  write(root, 'a.zeta', '1\n');
  write(root, 'b.zeta', '1\n');
  write(root, 'c.zeta', '1\n');
  write(root, 'd.qux', '1\n');
  // A stated non-source exclusion must NOT reach the tail.
  write(root, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // A rotated log's "extension" is not shaped like one; it collapses into a
  // named bucket rather than minting a single-file row.
  write(root, 'debug.2026-08-06', 'x\n');
  write(root, 'LICENSE', 'x\n');
  // A lockfile is a deliberate exclusion, not a to-do.
  write(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  // Signature: the deepest one the scan looks for.
  write(root, '.github/workflows/ci.yml', 'name: ci\n');
  // A monorepo package manifest is the project's own and IS read.
  write(root, 'packages/api/package.json', JSON.stringify({ dependencies: { fastify: '^4' } }));
  // A vendored dependency's manifest is NOT: `vendor/` is pruned outright...
  write(root, 'vendor/thing/package.json', JSON.stringify({ dependencies: { express: '^4' } }));
  write(root, 'node_modules/dep/package.json', JSON.stringify({ dependencies: { koa: '^2' } }));
  // ...and a manifest deeper than the bound is out of scope even in a tree
  // nobody prunes.
  write(root, 'deep/a/b/package.json', JSON.stringify({ dependencies: { angular: '^17' } }));
  return root;
}

test('lines land in languages, and the stack payload has no lines field at all', (t) => {
  const root = project(t);
  const out = detectStack(root, { asOf: 1_700_000_000_000 });

  assert.equal(out.registryVersion, STACK_REGISTRY_VERSION);
  assert.equal(out.approximate, true);
  const byId = new Map(out.languages.map((row) => [row.id, row]));
  assert.equal(byId.get('typescript').lines, 5, 'app.tsx + util.ts');
  assert.equal(byId.get('typescript').files, 2);
  assert.equal(byId.get('javascript').lines, 1);
  // Ranked by lines, so the biggest bucket reads first. `config` is in this
  // list too: a manifest is read for its dependency keys AND holds lines, and
  // the registry maps `.json` to a language for exactly that reason.
  assert.equal(out.languages[0].id, 'typescript');
  assert.ok(out.languages.some((row) => row.id === 'javascript'));
  for (let i = 1; i < out.languages.length; i++) {
    assert.ok(out.languages[i - 1].lines >= out.languages[i].lines, 'ranked by lines');
  }
  assert.equal(out.totalLines.status, 'measured');
  assert.equal(out.totalLines.value,
    out.languages.reduce((sum, row) => sum + row.lines, 0));
  assert.equal(out.totalLines.partial, false);

  // The load-bearing assertion: presence entries are structurally incapable of
  // carrying a line count.
  assert.ok(out.stack.length > 0);
  for (const item of out.stack) {
    assert.ok(!('lines' in item), `${item.id} carries a lines field`);
    assert.ok(!('files' in item), `${item.id} carries a files field`);
    assert.notEqual(item.kind, 'language', `${item.id} is a language on the presence list`);
    assert.deepEqual(Object.keys(item).sort(), ['ecosystem', 'id', 'kind', 'name', 'via']);
  }
  assert.ok(ids(out.stack).includes('react'));
  assert.ok(ids(out.stack).includes('github-actions'), 'a directory signature is presence too');
  assert.ok(!ids(out.stack).includes('typescript'), 'the language bucket is not a stack row');
});

test('a vendored or too-deep manifest is never mistaken for the project\'s own', (t) => {
  const root = project(t);
  const out = detectStack(root, { asOf: 1 });
  const seen = ids(out.stack);

  assert.ok(seen.includes('react'), 'the root manifest is the project\'s own');
  assert.ok(seen.includes('fastify'), 'a monorepo package manifest is in scope');
  assert.ok(!seen.includes('express'), 'vendor/ is pruned, so its manifest never appears');
  assert.ok(!seen.includes('koa'), 'node_modules is pruned');
  assert.ok(!seen.includes('angular'), `a manifest below depth ${MANIFEST_MAX_DEPTH} is out of scope`);

  const manifestPaths = out.manifests.map((row) => path.relative(root, row.path));
  assert.deepEqual(manifestPaths.sort(), ['package.json', path.join('packages', 'api', 'package.json')]);
  assert.ok(out.manifests.every((row) => row.status === 'read'));

  // Turning manifests off leaves signature-detected rows and nothing else, so
  // the two detection paths are provably independent.
  const noManifests = detectStack(root, { manifests: false, asOf: 1 });
  assert.deepEqual(noManifests.manifests, []);
  assert.ok(!ids(noManifests.stack).includes('react'));
  assert.ok(ids(noManifests.stack).includes('github-actions'));
});

test('the unrecognized tail is populated, ranked, and admits only real gaps', (t) => {
  const root = project(t);
  const out = detectStack(root, { asOf: 1 });
  const tail = out.unrecognized.extensions;
  const tailByExt = new Map(tail.map((row) => [row.ext, row]));

  assert.equal(tailByExt.get('.zeta').files, 3);
  assert.equal(tailByExt.get('.qux').files, 1);
  // Ranked by file count, so the biggest gap is the first thing a release sees.
  assert.equal(tail[0].ext, '.zeta');
  assert.ok(tail.findIndex((row) => row.ext === '.zeta')
    < tail.findIndex((row) => row.ext === '.qux'));
  assert.equal(out.unrecognized.extensionsTotal, tail.length);

  // A stated exclusion is counted separately and never pollutes the to-do list.
  assert.ok(!tailByExt.has('.png'));
  assert.equal(out.nonSource.files, 1);
  assert.ok(out.nonSource.bytes > 0);
  // A rotated log collapses into a named bucket rather than minting a row.
  assert.ok(!tailByExt.has('.2026-08-06'));
  assert.ok(tailByExt.has('(other)'));
  assert.equal(tailByExt.get('(no extension)').files, 1, 'LICENSE');
  // Lockfiles are excluded outright — not lines, and not a gap either.
  assert.ok(!tailByExt.has('.yaml'), 'pnpm-lock.yaml is a stated exclusion');

  // Unrecognized DEPENDENCIES are the other half of the same to-do list.
  const unknownDeps = out.unrecognized.dependencies.map((row) => row.name);
  assert.ok(unknownDeps.includes('totally-unknown-lib'));
  assert.ok(!unknownDeps.includes('react'));
  assert.equal(out.unrecognized.dependenciesTotal, out.unrecognized.dependencies.length);
  assert.ok(out.unrecognized.dependencies.every((row) => MANIFEST_KINDS.includes(row.manifest)));
});

test('an unwalkable project is unknown with a reason, never a measured zero', () => {
  const out = detectStack(path.join(os.tmpdir(), 'ak-fp-stack-does-not-exist-9x8y7z'), { asOf: 5 });
  assert.equal(out.totalLines.status, 'unknown');
  assert.equal(out.totalLines.value, null);
  assert.equal(out.totalLines.reason, 'ENOENT');
  assert.deepEqual(out.languages, []);
  assert.deepEqual(out.stack, []);
  assert.equal(out.files, null, 'a file count nobody took is null, not 0');
  assert.equal(out.complete, false);
  assert.ok(out.exclusions.length, 'the scope is stated even when nothing was measured');
});

test('an empty project is a measured zero, which is a different answer', (t) => {
  const root = fixture(t, 'empty');
  const out = detectStack(root, { asOf: 7 });
  assert.equal(out.totalLines.status, 'measured');
  assert.equal(out.totalLines.value, 0);
  assert.equal(out.files, 0);
  assert.equal(out.complete, true);
});

test('a binary or oversized file is skipped and counted, not line-counted', (t) => {
  const root = fixture(t, 'skips');
  // A `.js` file with a NUL byte is not source anyone wrote lines in.
  fs.writeFileSync(path.join(root, 'blob.js'), Buffer.from([0x61, 0x00, 0x62, 0x0a]));
  write(root, 'real.js', 'a\nb\n');
  const out = detectStack(root, { asOf: 1 });
  assert.equal(out.skipped, 1);
  assert.equal(out.languages.find((row) => row.id === 'javascript').lines, 2);
  assert.equal(out.files, 1, 'only the counted file is a counted file');
  // A file with no trailing newline still ends a line.
  write(root, 'tail.js', 'a\nb');
  assert.equal(detectStack(root, { asOf: 1 }).languages
    .find((row) => row.id === 'javascript').lines, 4);
});

test('a capped walk makes the total a floor rather than a smaller number', (t) => {
  const root = project(t);
  const capped = detectStack(root, { limits: { maxEntries: 3 }, asOf: 9 });
  assert.equal(capped.totalLines.status, 'measured');
  assert.equal(capped.totalLines.partial, true, 'a capped total renders as ">= N"');
  assert.equal(capped.complete, false);
});

test('the exclusions and the provenance travel with the figure', (t) => {
  const root = project(t);
  const out = detectStack(root, { asOf: 1 });
  for (const dir of EXCLUDED_DIRS) assert.ok(STACK_EXCLUSIONS.includes(`${dir}/`), dir);
  for (const file of EXCLUDED_FILES) assert.ok(STACK_EXCLUSIONS.includes(file), file);
  assert.deepEqual(out.exclusions, [...STACK_EXCLUSIONS]);

  const note = stackProvenance(out);
  assert.equal(note.registryVersion, STACK_REGISTRY_VERSION);
  assert.equal(note.languages, out.languages.length);
  assert.equal(note.stackItems, out.stack.length);
  assert.equal(note.manifestsRead, 2);
  assert.equal(note.manifestsSeen, out.manifests.length);
  assert.equal(note.nonSourceFiles, 1);
  assert.equal(note.approximate, true);

  // Provenance for a project that was never measured says so rather than
  // reporting a confident zero-language stack.
  const none = stackProvenance(null);
  assert.equal(none.languages, 0);
  assert.equal(none.unrecognizedExtensions, null);
  assert.equal(none.nonSourceFiles, null);
});

// ── cloud placeholders, and the platform that cannot detect them ────────────
// A dataless file (real size, zero allocated blocks) must never be opened: the
// read blocks in the kernel until the provider faults the bytes back, which
// with the provider offline is forever. But `blocks` is a POSIX field, and on
// win32 Node reports 0 for EVERY file — so the same rule there condemns the
// whole scan. This is the regression that took Windows CI down: 8 failures,
// all of them "measured nothing".

test('a dataless file is a placeholder on POSIX and is never opened', () => {
  assert.equal(isCloudPlaceholder(4096, 0, 'darwin'), true);
  assert.equal(isCloudPlaceholder(4096, 0, 'linux'), true);
});

test('on win32 a zero block count is NOT evidence of a placeholder', () => {
  // fs.Stats.blocks is POSIX-only; win32 reports 0 for every file. Reading the
  // rule literally there skipped every source file and queued no manifest, so a
  // scan returned no lines, no dependencies and no stack.
  assert.equal(isCloudPlaceholder(4096, 0, 'win32'), false);
  assert.equal(isCloudPlaceholder(1, 0, 'win32'), false);
});

test('a real file, an empty file and a missing blocks field are never placeholders', () => {
  assert.equal(isCloudPlaceholder(4096, 8, 'darwin'), false, 'allocated blocks means real content');
  assert.equal(isCloudPlaceholder(0, 0, 'darwin'), false, 'an empty file legitimately has no blocks');
  assert.equal(isCloudPlaceholder(4096, undefined, 'darwin'), false,
    'a stat that did not carry blocks is unknown, and guessing would skip real files');
});

/** A stat shim that reports zero allocated blocks for every file — what win32
 *  actually does, reproduced so the guard is testable from any machine. Without
 *  this the platform argument changes nothing on POSIX (real files have blocks)
 *  and the test below would pass with or without the fix. */
function zeroBlocksFs() {
  // The walk stats with lstatSync, so that is the call to shim. The returned
  // object must keep its prototype: the walk asks it isDirectory()/isFile().
  const zero = (st) => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { blocks: 0 });
  return { ...fs, lstatSync: (target, opts) => zero(fs.lstatSync(target, opts)) };
}

test('with zero blocks reported, POSIX skips everything — the behaviour being guarded against', (t) => {
  const root = fixture(t, 'zero-blocks-posix');
  write(root, 'real.js', 'a\nb\n');
  write(root, 'package.json', JSON.stringify({ dependencies: { 'totally-unknown-lib': '1.0.0' } }));
  const out = detectStack(root, { asOf: 1, platform: 'darwin', fsImpl: zeroBlocksFs() });
  // Anti-vacuity: this is the exact damage seen on Windows CI. If this ever
  // stops holding, the test below proves nothing.
  assert.equal(out.manifests.length, 0, 'every file read as a placeholder — no manifest queued');
  assert.ok((out.languages.find((r) => r.id === 'javascript')?.lines ?? 0) === 0, 'and no lines counted');
});

test('a win32 scan still counts lines, reads manifests and skips only the binary', (t) => {
  const root = fixture(t, 'win32-blocks');
  write(root, 'real.js', 'a\nb\n');
  write(root, 'package.json', JSON.stringify({ dependencies: { 'totally-unknown-lib': '1.0.0' } }));
  fs.writeFileSync(path.join(root, 'blob.js'), Buffer.from([0x61, 0x00, 0x62, 0x0a]));

  const out = detectStack(root, { asOf: 1, platform: 'win32', fsImpl: zeroBlocksFs() });
  assert.equal(out.skipped, 1, 'only the binary is skipped — not every file');
  assert.equal(out.languages.find((row) => row.id === 'javascript').lines, 2);
  assert.equal(out.manifests.length, 1, 'the manifest was queued and read');
  assert.ok(out.unrecognized.dependencies.some((r) => r.name === 'totally-unknown-lib'),
    'and its declarations reached the unrecognized tail');
});
