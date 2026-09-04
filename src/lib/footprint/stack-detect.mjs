// Stack detection over ONE project directory: which languages hold its lines,
// which frameworks / SDKs / tools it declares, and — the part that makes the
// registry self-improving — everything it saw and could NOT name (ADR-0025 §4,
// docs/ddd/machine-footprint.md "Project footprint").
//
// LINES vs PRESENCE is the load-bearing distinction. `languages` carry a line
// count because a file extension is what a line belongs to. `stack` entries carry
// PRESENCE ONLY and are never given a `lines` field: react does not own lines, the
// .tsx files do, and stacking both on one proportional bar would count the same
// bytes twice. Nothing downstream can make that mistake by accident because the
// number simply is not in the payload.
//
// THE UNRECOGNIZED TAIL IS THE POINT. An extension the registry does not map is
// never counted as lines — most unmapped extensions on a real machine are binaries
// and data — so instead it is tallied BY NAME, as is every declared dependency that
// matched no entry. That converts the usual silent "Other" slice into a to-do list
// a release can close.
//
// Which is why the tail has exactly one job and admits only what belongs in it. An
// extension the registry has already RULED OUT (`.png`, `.sqlite` — the registry's
// non-source list) is a stated exclusion, not a gap, and is counted separately.
// A key that is not shaped like an extension at all (`.2026-08-06` from a rotated
// log) collapses into a named bucket. Without both filters the tail fills with
// noise and stops being read, which is the same failure as not having one.
//
// MANIFESTS ARE READ SHALLOWLY, AND ONLY FOR NAMES. Reading a project's own
// manifests extends the metadata-only rule (invariant 1) exactly as far as
// `.git/config`'s remote URL and `.git/worktrees/*/gitdir` already do: a bounded
// read of a declaration file, parsed for dependency KEYS and nothing else. Nothing
// here evaluates, executes, resolves or fetches anything — mix.exs and build.gradle
// are Elixir and Groovy source, and they are scanned with regexes, never run. The
// depth bound is not cosmetic: a scan of this machine found 1884 Cargo.toml files,
// nearly all of them inside cargo's registry cache, so a deep manifest search would
// report a dependency's dependencies as the project's own.
//
// The walk is the shared bounded walker from walk.mjs, so this module inherits the
// never-follow-symlinks rule, the entry/depth caps, and the degrade-this-node-only
// failure mode (invariant 6) rather than reimplementing them.
import fs from 'node:fs';
import path from 'node:path';
import { walkTree, measured, unknown } from './walk.mjs';
import {
  STACK_REGISTRY_VERSION, dependencyEntry, isNonSourceExtension, languageForExtension,
  languageForFilename, manifestKindFor, registryStats, signatureEntries,
} from './stack-registry.mjs';

/** Vendored / generated / virtual-env trees. Excluded from the scan entirely:
 *  they are real bytes on disk (projects.mjs still counts them in treeBytes) but
 *  they are not lines the user wrote, and their manifests are not this project's
 *  declarations. Kept byte-identical to projects.mjs's list so the two agree on
 *  what "the user's code" means. */
export const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'third_party', 'thirdparty', 'bower_components',
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', 'coverage',
  '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache',
  '.gradle', '.idea', '.vscode', 'Pods', '.terraform', '.cache', '.turbo',
]);

/** Machine-generated manifests: text, enormous, and nobody's line count. Skipped
 *  before the tail too — a lockfile is not an unrecognized extension, it is a
 *  deliberate exclusion, and listing it as a to-do would be noise. */
export const EXCLUDED_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json',
  'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', 'flake.lock',
]);

/** Source trees nest far shallower than dependency trees. */
export const STACK_MAX_DEPTH = 12;
/** A project's own manifests plus one monorepo package level
 *  (`packages/<pkg>/package.json` sits at 3). Vendored trees are already pruned
 *  by EXCLUDED_DIRS, so this bound is about monorepo shape, not safety alone. */
export const MANIFEST_MAX_DEPTH = 3;
/** `.github/workflows` is the deepest signature worth looking for. */
export const SIGNATURE_MAX_DEPTH = 3;
/** Files above this are minified bundles, fixtures or data dumps far more often
 *  than hand-written source. Skipped and reported, never counted. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A manifest larger than this is generated, not authored; refused rather than
 *  read, so one pathological file cannot dominate a scan. */
export const MANIFEST_MAX_BYTES = 512 * 1024;

const READ_CHUNK = 64 * 1024;
const MAX_MANIFESTS = 64;
const MAX_DEPS_PER_MANIFEST = 500;
const MAX_SIGNATURE_PATHS = 4000;
const MAX_TAIL_KEYS = 4000;
const TAIL_EXTENSIONS = 40;
const TAIL_DEPENDENCIES = 50;

/** The exclusion list every surface must be able to state alongside the figure
 *  (invariant 11). Deliberate exclusions are a scope, not a failed measurement, so
 *  they never mark a count partial — which is exactly why they ship attached to it. */
export const STACK_EXCLUSIONS = Object.freeze([
  ...[...EXCLUDED_DIRS].sort().map((dir) => `${dir}/`),
  ...[...EXCLUDED_FILES].sort(),
  'files with a known non-source extension (images, media, archives, binaries, stores)',
  'files without a registry-recognized source extension (listed as the unrecognized tail)',
  'files containing NUL bytes (binary)',
  `files larger than ${MAX_FILE_BYTES} bytes`,
]);

/** The tail is keyed by extension — but only when the extension is shaped like
 *  one. `path.extname('debug.2026-08-06')` is `.2026-08-06`, and one rotated log
 *  directory would otherwise mint a thousand single-file "extensions" and drown
 *  the to-do list it exists to be. Everything else collapses into two named
 *  buckets, which is honest and stays countable. */
const TAIL_OTHER = '(other)';
const TAIL_NONE = '(no extension)';
// Digits are allowed (`.ps1`, `.f90`, `.mp3`) but separators are not: no real
// source extension contains a hyphen or an underscore, while every rotated,
// versioned or quarantined filename does (`.corrupt-4585`, `.2026-08-06`).
const PLAUSIBLE_EXTENSION = /^\.[a-z][a-z0-9+#]{0,10}$/;

function tailKey(lowerName) {
  const ext = path.extname(lowerName);
  if (!ext) return TAIL_NONE;
  return PLAUSIBLE_EXTENSION.test(ext) ? ext : TAIL_OTHER;
}

// ── lines ─────────────────────────────────────────────────────────────────────

/** A file a cloud provider has evicted: real size, zero allocated blocks. Reading
 *  one is not slow, it is UNBOUNDED — the open blocks in the kernel until the
 *  provider faults the bytes back in, and with the provider signed out or offline
 *  that never happens and no timeout fires. Measured on this machine: a 4KB
 *  dataless Dropbox `.yml` held a synchronous read for over 15 minutes, which is
 *  the whole deep scan and (the collectors being synchronous) the whole server.
 *
 *  So placeholders are never opened. They are skipped like any other unreadable
 *  file — the project's line count is a floor and the walk reports incomplete,
 *  which is invariant 3's "unknown, never 0" rather than a fabricated zero.
 *
 *  Only an explicit 0 counts. `undefined` means the stat did not carry blocks (a
 *  test shim), and guessing from a missing field would skip real files. Sparse
 *  files also report fewer blocks than their size implies but never
 *  zero-with-content, so they are unaffected.
 *
 *  WINDOWS IS EXCLUDED, and not as a nicety. `fs.Stats.blocks` is a POSIX field;
 *  on win32 Node reports it as 0 for every file, content or not. The rule then
 *  reads EVERY file as evicted — manifests are never queued and every source
 *  file is skipped, so a scan returns no lines, no dependencies and no stack at
 *  all. Two independent CI symptoms pinned it: `manifestsRead` 0 where 2 were
 *  present, and a skip count one higher than the fixture's only binary file.
 *
 *  The cost of the exclusion is real and worth stating: Windows is where OneDrive
 *  Files On-Demand actually lives, so it is the platform that most needs this
 *  check and the one platform that cannot have it. Detecting a placeholder there
 *  means reading FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, which `fs.Stats` does not
 *  surface — so a Windows placeholder is opened and may block, exactly as it did
 *  before this heuristic existed. Reading one file slowly is recoverable;
 *  measuring nothing at all is not.
 *
 *  `platform` is a parameter rather than a direct `process.platform` read so the
 *  win32 branch is testable from any machine. Pure.
 *  @param {number} bytes @param {number|undefined} blocks @param {string} platform */
export const isCloudPlaceholder = (bytes, blocks, platform = process.platform) =>
  platform !== 'win32' && blocks === 0 && bytes > 0;

/** Count newlines in one file through a fixed buffer. Returns null when the file
 *  is binary (a NUL byte in the first chunk) or unreadable — never 0, which would
 *  claim an empty file. Each chunk is counted and immediately overwritten; no file
 *  content is retained past this function or emitted anywhere. */
function countFileLines(file, size, fsImpl, buffer) {
  let fd;
  try { fd = fsImpl.openSync(file, 'r'); } catch { return null; }
  try {
    let lines = 0;
    let read = 0;
    let lastByte = 0;
    let offset = 0;
    let first = true;
    while ((read = fsImpl.readSync(fd, buffer, 0, READ_CHUNK, offset)) > 0) {
      if (first) { const nul = buffer.indexOf(0); if (nul >= 0 && nul < read) return null; }
      first = false;
      for (let i = 0; i < read; i++) if (buffer[i] === 0x0a) lines++;
      lastByte = buffer[read - 1];
      offset += read;
    }
    // A final line with no trailing newline still counts as a line.
    if (size > 0 && lastByte !== 0x0a) lines++;
    return lines;
  } catch { return null; }
  finally { try { fsImpl.closeSync(fd); } catch { /* fd already gone */ } }
}

// ── manifest parsing (names and keys only — nothing is evaluated) ─────────────

/** A dependency resolved from inside this repository is not a stack fact — it is
 *  the project depending on itself. Workspace and path protocols are the one thing
 *  a dependency's VALUE is read for; nothing else about it is inspected. */
const LOCAL_PROTOCOL = /^(workspace|file|link|portal|path):/i;

const jsonDependencyKeys = (source, sections) => {
  let doc;
  try { doc = JSON.parse(source); } catch { return null; }
  const names = [];
  for (const section of sections) {
    const block = doc?.[section];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [name, version] of Object.entries(block)) {
      if (typeof version === 'string' && LOCAL_PROTOCOL.test(version)) continue;
      names.push(name);
    }
  }
  return names;
};

/** TOML keys inside any section whose header ends in `dependencies`, plus the
 *  `[dependencies.<name>]` table form. Line-oriented on purpose: a real TOML
 *  parser is a dependency this context does not have and does not need for keys. */
function tomlDependencyKeys(source) {
  const names = [];
  let inDeps = false;
  for (const line of source.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*$/);
    if (header) {
      const section = header[1].replace(/["']/g, '');
      const table = section.match(/(?:^|\.)(?:dev-|build-|dependency-)?dependencies\.(.+)$/);
      if (table) { names.push(table[1].split('.')[0]); inDeps = false; continue; }
      // `packages` covers Pipfile, whose section is spelled differently from
      // every other TOML manifest's.
      inDeps = /(?:^|\.)(?:dev-|build-|dependency-|optional-)?(?:dependencies|packages)$/
        .test(section) || /(?:^|\.)dependency-groups$/.test(section);
      continue;
    }
    if (!inDeps) continue;
    // `sibling = { path = "crates/…" }` is a workspace member, not a third-party
    // dependency; counting it would list a Cargo workspace's own crates as its stack.
    if (/\bpath\s*=/.test(line)) continue;
    const key = line.match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=/);
    if (key) names.push(key[1] ?? key[2] ?? key[3]);
  }
  return names;
}

/** Quoted requirement strings inside a `dependencies = [ … ]` array (PEP 621 and
 *  the optional-dependency groups that share its shape). */
function tomlDependencyArrays(source) {
  const names = [];
  const arrays = source.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]/g);
  for (const array of arrays) {
    for (const quoted of array[1].matchAll(/["']([^"']+)["']/g)) names.push(quoted[1]);
  }
  return names;
}

/** PyPI treats `_` and `-` as the same character and casing as insignificant. */
const pythonName = (raw) => {
  const head = String(raw).trim().match(/^[A-Za-z0-9._-]+/);
  return head ? head[0].toLowerCase().replace(/_/g, '-') : null;
};

function goModules(source) {
  const names = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.includes('// indirect')) continue; // transitive, not this project's stack
    const match = line.match(/^\s*(?:require\s+)?([a-z0-9][^\s(]*\.[a-z]{2,}\/[^\s]+)\s+v/i);
    if (match) names.push(match[1]);
  }
  return names;
}

/** Maven coordinates and Gradle dependency strings alike: every quoted token that
 *  looks like a coordinate contributes its group and its artifact, because the
 *  registry matches whichever half is the recognizable one. */
function jvmCoordinates(source) {
  const names = [];
  for (const tag of source.matchAll(/<(?:groupId|artifactId)>\s*([^<\s]+)\s*<\//g)) names.push(tag[1]);
  for (const quoted of source.matchAll(/["']([A-Za-z][\w.-]*(?::[\w.$-]+){0,2})["']/g)) {
    for (const part of quoted[1].split(':')) {
      if (part && !/^\d/.test(part)) names.push(part);
    }
  }
  return names;
}

/** Top-level `dependencies:` / `dev_dependencies:` keys in a pubspec. */
function yamlDependencyKeys(source) {
  const names = [];
  let inDeps = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^[A-Za-z_]/.test(line)) {
      inDeps = /^(dependencies|dev_dependencies|dependency_overrides):\s*$/.test(line);
      continue;
    }
    if (!inDeps) continue;
    const key = line.match(/^\s{2}([A-Za-z0-9_.-]+):/);
    if (key) names.push(key[1]);
  }
  return names;
}

/**
 * Dependency names declared by one manifest. Pure: no I/O, no evaluation — every
 * parser here is JSON.parse or a regex scan, so a manifest that is source code
 * (mix.exs, build.gradle) is read as text and never run.
 *
 * Returns null when the source could not be parsed at all, which the caller
 * reports as a degraded manifest rather than as "declares nothing".
 *
 * @param {string} kind one of MANIFEST_KINDS
 * @param {string} source raw manifest text
 * @returns {string[]|null}
 */
export function parseManifestDependencies(kind, source) {
  const text = String(source ?? '');
  switch (kind) {
    case 'npm':
      return jsonDependencyKeys(text,
        ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);
    case 'composer':
      return jsonDependencyKeys(text, ['require', 'require-dev']);
    case 'cargo':
      return tomlDependencyKeys(text);
    case 'gomod':
      return goModules(text);
    case 'python': {
      // pyproject.toml / Pipfile and requirements.txt share a manifest kind and
      // nothing else, so the two shapes are read exclusively: running the
      // line-per-requirement scan over a TOML file turns classifier strings into
      // imaginary dependencies. A leading `[` on any line is the discriminator —
      // no requirement line can start with one.
      if (/^\s*\[/m.test(text)) {
        return [...tomlDependencyKeys(text), ...tomlDependencyArrays(text)]
          .map(pythonName).filter(Boolean);
      }
      const raw = [];
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
        raw.push(trimmed);
      }
      return raw.map(pythonName).filter(Boolean);
    }
    case 'jvm':
      return jvmCoordinates(text);
    case 'pub':
      return yamlDependencyKeys(text);
    case 'hex':
      return [...text.matchAll(/\{\s*:([a-z0-9_]+)\s*,/g)].map((m) => m[1]);
    case 'rubygems':
      return [...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    default:
      return null;
  }
}

/** One manifest, bounded and read for keys only. `bytes` comes from the walk's
 *  own lstat, so an oversized manifest is refused without ever being opened. */
function readManifest(file, kind, bytes, fsImpl) {
  if (bytes > MANIFEST_MAX_BYTES) {
    return { path: file, kind, status: 'skipped', reason: 'manifest larger than cap', names: [] };
  }
  let source;
  try { source = fsImpl.readFileSync(file, 'utf8'); } catch (error) {
    return { path: file, kind, status: 'unreadable', reason: error?.code ?? 'io', names: [] };
  }
  const names = parseManifestDependencies(kind, source);
  if (names === null) {
    return { path: file, kind, status: 'unparsed', reason: 'EPARSE', names: [] };
  }
  return {
    path: file,
    kind,
    status: 'read',
    reason: null,
    names: names.slice(0, MAX_DEPS_PER_MANIFEST),
    truncated: names.length > MAX_DEPS_PER_MANIFEST,
  };
}

// ── detection ─────────────────────────────────────────────────────────────────

const KIND_ORDER = { framework: 0, sdk: 1, tool: 2 };
const rel = (root, target) => path.relative(root, target).split(path.sep).join('/').toLowerCase();

/** The shape returned when the project root itself could not be walked. Every
 *  figure is unknown-with-reason; none of them is 0, because nothing was measured
 *  (invariant 2). */
function unmeasured(reason, asOf) {
  return {
    registryVersion: STACK_REGISTRY_VERSION,
    asOf,
    approximate: true,
    exclusions: [...STACK_EXCLUSIONS],
    languages: [],
    totalLines: unknown(reason),
    stack: [],
    unrecognized: { extensions: [], extensionsTotal: 0, dependencies: [], dependenciesTotal: 0 },
    nonSource: { files: null, bytes: null },
    manifests: [],
    files: null,
    skipped: 0,
    complete: false,
    degraded: [],
  };
}

/** Read every queued manifest after the walk, folding each declared dependency
 *  name into either the registry-matched stack or the unrecognized-dependencies
 *  tail. Split out of `detectStack` (2026-08 complexity program) purely to give
 *  this loop its own complexity budget; the matching rules are unchanged. */
function readQueuedManifests(manifestFiles, fsImpl) {
  const manifestRows = [];
  const stack = new Map();
  const unrecognizedDeps = new Map();
  for (const { file, kind, bytes } of manifestFiles) {
    const reading = readManifest(file, kind, bytes, fsImpl);
    manifestRows.push({
      path: reading.path, kind: reading.kind, status: reading.status, reason: reading.reason,
    });
    for (const name of reading.names) {
      const entry = dependencyEntry(kind, name);
      if (entry) {
        if (!stack.has(entry.id)) stack.set(entry.id, { entry, via: kind });
        continue;
      }
      const key = `${kind} ${name.toLowerCase()}`;
      if (!unrecognizedDeps.has(key)) unrecognizedDeps.set(key, { name, manifest: kind });
    }
  }
  return { manifestRows, stack, unrecognizedDeps };
}

/** Signature-based stack matches (a shallow file, directory, or filename prefix
 *  seen during the walk), added on top of whatever the manifests already
 *  matched — a manifest match always wins, so a signature never overrides a
 *  dependency-derived one. Mutates `stack` in place. */
function matchSignatures(stack, { seenFiles, seenPaths, seenDirs }) {
  for (const entry of signatureEntries()) {
    const { files: names, dirs, filePrefixes } = entry.match;
    const hit = names.find((name) => seenFiles.has(name) || seenPaths.has(name))
      ?? dirs.find((dir) => seenDirs.has(dir))
      ?? (filePrefixes.length
        ? [...seenFiles].find((name) => filePrefixes.some((prefix) => name.startsWith(prefix)))
        : undefined);
    if (hit !== undefined && !stack.has(entry.id)) stack.set(entry.id, { entry, via: hit });
  }
}

/** Build the stateful projection that can consume either Stack's own bounded
 * walk or a compatible, complete traversal superset acquired by Projects. The
 * observer owns Stack's exclusions/depth rules; sharing traversal never widens
 * the semantic scope.
 *
 * @param {string} root the project's directory
 * @param {{ limits?: Record<string, any>, maxDepth?: number,
 *           manifestDepth?: number, signatureDepth?: number, manifests?: boolean,
 *           platform?: string,
 *           asOf?: number|null, fsImpl?: typeof fs }} [options]
 * @returns {{ maxDepth: number,
 *   onDirectory: (dir: string, name: string, depth: number) => boolean,
 *   acceptFile: (name: string, file?: string, depth?: number) => boolean,
 *   onFile: (entry: { file: string, name: string, bytes: number, blocks: number,
 *                    mtimeMs: number, depth: number }) => void,
 *   finalize: (result: Record<string, any>) => Record<string, any> }}
 */
export function createStackObserver(root, {
  limits = {},
  maxDepth = STACK_MAX_DEPTH,
  manifestDepth = MANIFEST_MAX_DEPTH,
  signatureDepth = SIGNATURE_MAX_DEPTH,
  manifests: readManifests = true,
  platform = process.platform,
  asOf = null,
  fsImpl = fs,
} = {}) {
  const effectiveMaxDepth = limits.maxDepth ?? maxDepth;
  const lines = new Map();     // language id → { entry, lines, files }
  const tail = new Map();      // extension (or bare filename) → { files, bytes }
  const manifestFiles = [];    // { file, kind, bytes }
  const seenFiles = new Set(); // shallow basenames, for signature matching
  const seenPaths = new Set(); // shallow root-relative file paths
  const seenDirs = new Set();  // shallow root-relative directory paths
  let skipped = 0;
  let files = 0;
  let tailTruncated = false;
  let nonSourceFiles = 0;
  let nonSourceBytes = 0;
  // Source reads are sequential inside one observer. Reusing one fixed buffer
  // avoids allocating and collecting 64 KiB for every source file while
  // retaining the same bounded, non-retained content contract.
  const lineBuffer = Buffer.allocUnsafe(READ_CHUNK);

  const note = (set, value) => { if (set.size < MAX_SIGNATURE_PATHS) set.add(value); };
  const relativeParts = (target) => path.relative(root, target).split(path.sep).filter(Boolean);
  const hasExcludedAncestor = (target) => relativeParts(target).slice(0, -1)
    .some((part) => EXCLUDED_DIRS.has(part));
  let scopeTruncated = false;

  const onDirectory = (dir, name, depth) => {
    // A broad footprint walk may continue through a directory this stack
    // contract excludes. Ignore every descendant as though the walker had
    // pruned it at this boundary.
    if (hasExcludedAncestor(dir)) return true;
    // walkTree checks directory depth before calling skipDir. Reproduce that
    // signal when observing a broader walk with a larger depth budget.
    if (depth > effectiveMaxDepth) { scopeTruncated = true; return true; }
    // Recorded BEFORE the skip decision: `.terraform` and `.git` are excluded
    // from the scan and are still evidence of what this project uses.
    if (depth <= signatureDepth) note(seenDirs, rel(root, dir));
    return EXCLUDED_DIRS.has(name);
  };
  const acceptFile = (name) => !EXCLUDED_FILES.has(name);
  const onFile = ({ file, name, bytes, blocks, depth }) => {
    // Files immediately inside a max-depth directory are counted by walkTree;
    // only files whose parent is beyond the stack contract are out of scope.
    if (depth - 1 > effectiveMaxDepth || hasExcludedAncestor(file)
      || !acceptFile(name)) return;
    const lower = name.toLowerCase();
    const placeholder = isCloudPlaceholder(bytes, blocks, platform);
    if (depth <= signatureDepth) { note(seenFiles, lower); note(seenPaths, rel(root, file)); }
    // A placeholder manifest is still evidence the project HAS that manifest —
    // its name was noted above. Only its contents are out of reach, so it is
    // never queued for the read pass.
    if (readManifests && !placeholder
      && depth <= manifestDepth && manifestFiles.length < MAX_MANIFESTS) {
      const kind = manifestKindFor(name);
      if (kind) manifestFiles.push({ file, kind, bytes });
    }

    const entry = languageForFilename(name) ?? languageForExtension(path.extname(name));
    if (!entry) {
      // A STATED non-source extension is a decision, not a gap: it is named in
      // `exclusions` and counted here, and it never joins the tail — otherwise
      // .png and .sqlite would bury the extensions the registry should learn.
      if (isNonSourceExtension(path.extname(lower))) {
        nonSourceFiles += 1;
        nonSourceBytes += bytes;
        return;
      }
      // A manifest is recognized — it simply holds declarations rather than
      // lines. `go.mod` reported as an unrecognized `.mod` extension would be
      // the tail contradicting the parser that just read it.
      if (manifestKindFor(name)) return;
      const key = tailKey(lower);
      const row = tail.get(key);
      if (row) { row.files += 1; row.bytes += bytes; } else if (tail.size < MAX_TAIL_KEYS) {
        tail.set(key, { files: 1, bytes });
      } else tailTruncated = true;
      return;
    }
    if (bytes > MAX_FILE_BYTES) { skipped++; return; }
    if (placeholder) { skipped++; return; }
    const counted = countFileLines(file, bytes, fsImpl, lineBuffer);
    if (counted === null) { skipped++; return; }
    const bucket = lines.get(entry.id);
    if (bucket) { bucket.lines += counted; bucket.files += 1; } else {
      lines.set(entry.id, { entry, lines: counted, files: 1 });
    }
    files++;
  };

  const finalize = (result) => {
    if (result.status === 'unknown') return unmeasured(result.reason ?? 'unreadable', asOf);

    // Manifests are read after the walk: the traversal stays a pure metadata pass,
    // and a slow read cannot hold the walker's entry budget open.
    const { manifestRows, stack, unrecognizedDeps } = readQueuedManifests(manifestFiles, fsImpl);
    matchSignatures(stack, { seenFiles, seenPaths, seenDirs });

    const languages = [...lines.values()]
      .map(({ entry, lines: count, files: fileCount }) => ({
        id: entry.id,
        name: entry.name,
        ecosystem: entry.ecosystem,
        colorSlot: entry.colorSlot,
        lines: count,
        files: fileCount,
      }))
      .sort((a, b) => b.lines - a.lines || a.id.localeCompare(b.id));

    const total = languages.reduce((sum, row) => sum + row.lines, 0);
    const extensions = [...tail.entries()]
      .map(([ext, row]) => ({ ext, files: row.files, bytes: row.bytes }))
      .sort((a, b) => b.files - a.files || a.ext.localeCompare(b.ext));
    const dependencies = [...unrecognizedDeps.values()]
      .sort((a, b) => a.manifest.localeCompare(b.manifest) || a.name.localeCompare(b.name));
    const complete = result.complete !== false && !scopeTruncated;

    return {
      registryVersion: STACK_REGISTRY_VERSION,
      asOf,
      approximate: true,
      exclusions: [...STACK_EXCLUSIONS],
      languages,
      // The Measurement carries what the array cannot: a walk that hit a cap or an
      // unreadable subtree makes this a floor, which every surface renders as "≥ N".
      totalLines: measured(total, { asOf, partial: !complete }),
      // PRESENCE ONLY — deliberately no `lines` field; see this file's header.
      stack: [...stack.values()]
        .map(({ entry, via }) => ({
          id: entry.id, kind: entry.kind, name: entry.name, ecosystem: entry.ecosystem, via,
        }))
        .sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.name.localeCompare(b.name)),
      unrecognized: {
        // Totals sit next to the capped lists so a truncated tail is a stated
        // number, never a quietly shorter one.
        extensions: extensions.slice(0, TAIL_EXTENSIONS),
        extensionsTotal: tailTruncated ? null : extensions.length,
        dependencies: dependencies.slice(0, TAIL_DEPENDENCIES),
        dependenciesTotal: dependencies.length,
      },
      // Not a gap and not lines: the bytes this project holds in things the
      // registry has already ruled out as source.
      nonSource: { files: nonSourceFiles, bytes: nonSourceBytes },
      manifests: manifestRows,
      files,
      skipped,
      complete: complete && manifestRows.every((row) => row.status === 'read'),
      degraded: result.degraded ?? [],
    };
  };

  return { maxDepth: effectiveMaxDepth, onDirectory, acceptFile, onFile, finalize };
}

/** Detect the stack of one project directory. One walk answers all three
 * questions: source lines, shallow manifest/signature evidence, and the
 * unrecognized tail. */
export function detectStack(root, {
  walk = walkTree,
  limits = {},
  maxDepth = STACK_MAX_DEPTH,
  manifestDepth = MANIFEST_MAX_DEPTH,
  signatureDepth = SIGNATURE_MAX_DEPTH,
  manifests: readManifests = true,
  platform = process.platform,
  asOf = null,
  fsImpl = fs,
} = {}) {
  const observer = createStackObserver(root, {
    limits, maxDepth, manifestDepth, signatureDepth,
    manifests: readManifests, platform, asOf, fsImpl,
  });
  const result = walk(root, {
    maxDepth: observer.maxDepth, ...limits, fsImpl,
    skipDir: observer.onDirectory,
    // Rejected files still consume the entry budget but do no work — and, being
    // deliberate exclusions, they never reach the unrecognized tail either.
    acceptFile: observer.acceptFile,
    onFile: observer.onFile,
  });
  return observer.finalize(result);
}

/** The liner note a panel prints under a changed number: what was counted, by
 *  which registry, and what the tail still owes. Returned as parts rather than a
 *  sentence so the UI owns the typography and this module owns the facts. */
export function stackProvenance(detected) {
  const stats = registryStats();
  return Object.freeze({
    registryVersion: stats.version,
    registryEntries: stats.entries,
    recognizedExtensions: stats.extensions,
    nonSourceExtensions: stats.nonSourceExtensions,
    nonSourceFiles: detected?.nonSource?.files ?? null,
    languages: detected?.languages?.length ?? 0,
    stackItems: detected?.stack?.length ?? 0,
    unrecognizedExtensions: detected?.unrecognized?.extensionsTotal ?? null,
    unrecognizedDependencies: detected?.unrecognized?.dependenciesTotal ?? null,
    manifestsRead: (detected?.manifests ?? []).filter((row) => row.status === 'read').length,
    manifestsSeen: detected?.manifests?.length ?? 0,
    approximate: true,
  });
}
