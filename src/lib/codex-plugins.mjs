// Read-only Codex plugin compatibility inspection. Mutation is owned by the
// separately authorized hook-healing transaction boundary.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import { readBoundedFile } from './hook-audit/common.mjs';
import { inspectCodexTomlStructure, isTomlTableLine } from './codex-toml-safety.mjs';
import { cmpVersions } from './versions.mjs';

const HOOK_KEYS = new Set(['description', 'hooks']);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ADVISORIES = [{
  ref: 'security-guidance@claude-plugins-official',
  through: '2.0.7',
  message: 'Stop hook can emit a top-level "metrics" field that Codex rejects; disable it in /plugins and restart Codex',
}];
const CLAUDE_COMPANION_REF = 'codex@openai-codex';
const CLAUDE_COMPANION_POLICY = Object.freeze({
  id: 'codex-plugin-placement/claude-companion/v1',
  verifiedVersion: '1.0.6',
  verifiedAt: '2026-09-02',
  revision: 'db52e28f4d9ded852ab3942cea316258ae4ef346',
  evidence: 'https://github.com/openai/codex-plugin-cc/commit/db52e28f4d9ded852ab3942cea316258ae4ef346',
});

function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { value: null, error: 'must be a regular non-symlink file' };
    if (stat.size > 2 * 1024 * 1024) return { value: null, error: 'exceeds 2097152 byte inspection limit' };
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

const PLUGIN_TABLE = /^[\t ]*\[[\t ]*plugins[\t ]*\.[\t ]*(?:"((?:[^"\\]|\\.)+)"|'([^']+)')[\t ]*\][\t ]*(?:#[^\r\n]*)?$/;
const ENABLED_TRUE = /^[\t ]*enabled[\t ]*=[\t ]*true[\t ]*(?:#[^\r\n]*)?$/;

function decodedRef(match) {
  if (match[2] !== undefined) return match[2];
  try { return JSON.parse(`"${match[1]}"`); } catch { return null; }
}

function pluginTables(source) {
  const scan = inspectCodexTomlStructure(source);
  const headers = scan.lines.filter((line) => line.live && isTomlTableLine(line.text));
  const tables = headers.map((header, index) => ({
    header,
    end: headers[index + 1]?.start ?? source.length,
    match: PLUGIN_TABLE.exec(header.text),
  }));
  return { scan, tables };
}

/** Explicitly enabled `plugin@marketplace` refs from live Codex TOML tables. */
export function enabledPluginRefs(source) {
  const { scan, tables } = pluginTables(source);
  const refs = [];
  for (const table of tables.filter((candidate) => candidate.match)) {
    const ref = decodedRef(table.match);
    const enabled = scan.lines.some((line) => line.live
      && line.start >= table.header.end && line.start < table.end
      && ENABLED_TRUE.test(line.text));
    if (enabled && ref !== null) refs.push(ref);
  }
  return refs;
}

function pluginPlacementFindings(enabled, plugins, configFile, configDigest) {
  const companion = plugins.find((plugin) => plugin.ref === CLAUDE_COMPANION_REF);
  return enabled.includes(CLAUDE_COMPANION_REF) ? [{
    code: 'claude-companion-enabled-in-codex',
    ref: CLAUDE_COMPANION_REF,
    policyId: CLAUDE_COMPANION_POLICY.id,
    policyVersion: CLAUDE_COMPANION_POLICY.verifiedVersion,
    policyRevision: CLAUDE_COMPANION_POLICY.revision,
    policyVerifiedAt: CLAUDE_COMPANION_POLICY.verifiedAt,
    pluginVersion: companion?.version ?? null,
    evidence: CLAUDE_COMPANION_POLICY.evidence,
    configFile,
    configDigest,
    message: `${CLAUDE_COMPANION_REF} is the Codex companion for Claude Code and should not be enabled as a Codex plugin`,
  }] : [];
}

function readCodexConfig(configFile) {
  try {
    const entry = fs.lstatSync(configFile);
    if (!entry.isSymbolicLink()) {
      return { ...readBoundedFile(configFile, path.dirname(configFile)), viaSymlink: false };
    }
    const resolvedFile = fs.realpathSync(configFile);
    const read = readBoundedFile(resolvedFile, path.dirname(resolvedFile));
    if (read.status !== 'valid') return { ...read, viaSymlink: true, resolvedFile };
    if (fs.realpathSync(configFile) !== resolvedFile) {
      return { status: 'invalid', error: 'config symlink changed during inspection', viaSymlink: true };
    }
    return { ...read, viaSymlink: true, resolvedFile };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', viaSymlink: false };
    return { status: 'invalid', error: error?.message ?? String(error), viaSymlink: false };
  }
}

function splitRef(ref) {
  const at = ref.lastIndexOf('@');
  if (at <= 0 || at >= ref.length - 1) return null;
  const parsed = { plugin: ref.slice(0, at), marketplace: ref.slice(at + 1) };
  const safeSegment = (value) => value !== '.' && value !== '..' && !/[\\/\0]/.test(value);
  return safeSegment(parsed.plugin) && safeSegment(parsed.marketplace) ? parsed : null;
}

function canonicallyContained(root, target) {
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    return realTarget === realRoot || realTarget.startsWith(`${realRoot}${path.sep}`);
  } catch {
    return false;
  }
}

function newestVersionDir(base) {
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return null;
  }
  if (!entries.length) return null;
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  entries.sort((a, b) => {
    const av = semver.test(a.name); const bv = semver.test(b.name);
    if (av && bv) return cmpVersions(b.name, a.name);
    if (av !== bv) return av ? -1 : 1;
    const mtime = (entry) => {
      try { return fs.statSync(path.join(base, entry.name)).mtimeMs; } catch { return 0; }
    };
    return mtime(b) - mtime(a) || b.name.localeCompare(a.name);
  });
  return entries[0].name;
}

function validateHookDocument(doc, file) {
  if (!doc || Array.isArray(doc) || typeof doc !== 'object') {
    return [`${file}: hook config must be a JSON object`];
  }
  const extra = Object.keys(doc).filter((key) => !HOOK_KEYS.has(key));
  const issues = extra.length ? [`${file}: unsupported top-level field(s): ${extra.join(', ')}`] : [];
  if (!doc.hooks || Array.isArray(doc.hooks) || typeof doc.hooks !== 'object') {
    issues.push(`${file}: top-level "hooks" object is required`);
  }
  return issues;
}

function skillMetadata(source, file) {
  const normalized = source.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) {
    return { metadata: null, issues: [`${file}: missing YAML frontmatter delimited by ---`] };
  }
  const closing = normalized.indexOf('\n---\n', 4);
  if (closing < 0) {
    return { metadata: null, issues: [`${file}: missing closing YAML frontmatter delimiter ---`] };
  }
  const metadata = normalized.slice(4, closing);
  const field = (name) => {
    const lines = metadata.split('\n');
    const index = lines.findIndex((line) => line.startsWith(`${name}:`));
    if (index < 0) return '';
    const inline = lines[index].slice(name.length + 1).trim();
    if (inline && inline !== '>' && inline !== '|') {
      return inline.replace(/^(['"])(.*)\1$/, '$2').trim();
    }
    const continuation = [];
    for (const line of lines.slice(index + 1)) {
      if (line && !/^\s/.test(line)) break;
      if (line.trim()) continuation.push(line.trim());
    }
    return continuation.join(' ').trim();
  };
  return { metadata: { name: field('name'), description: field('description') }, issues: [] };
}

function inspectSkills(root) {
  const skillsDir = path.join(root, 'skills');
  let directories;
  try {
    directories = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch {
    return { files: [], issues: [] };
  }
  const files = [];
  const issues = [];
  for (const directory of directories) {
    const file = path.join(skillsDir, directory.name, 'SKILL.md');
    if (!fs.existsSync(file)) {
      issues.push(`${file}: missing SKILL.md`);
      continue;
    }
    files.push(file);
    const parsed = skillMetadata(fs.readFileSync(file, 'utf8'), file);
    issues.push(...parsed.issues);
    if (!parsed.metadata) continue;
    const { name, description } = parsed.metadata;
    if (!name) issues.push(`${file}: frontmatter requires a non-empty name`);
    if (!description) issues.push(`${file}: frontmatter requires a non-empty description`);
    if (name && name !== directory.name) {
      issues.push(`${file}: frontmatter name "${name}" must match directory "${directory.name}"`);
    }
    if (name && (!SKILL_NAME.test(name) || name.length > 63)) {
      issues.push(`${file}: frontmatter name must be lowercase kebab-case and at most 63 characters`);
    }
  }
  return { files, issues };
}

function advisoryIssues(ref, version) {
  return ADVISORIES
    .filter((advisory) => advisory.ref === ref && cmpVersions(version, advisory.through) <= 0)
    .map((advisory) => `${ref} ${version}: ${advisory.message}`);
}

function hookTargets(hooks, root) {
  if (hooks === undefined) {
    const conventional = path.join(root, 'hooks', 'hooks.json');
    try {
      fs.lstatSync(conventional);
      return [{ kind: 'file', value: conventional }];
    } catch (error) {
      return error.code === 'ENOENT' ? [] : [{ kind: 'file', value: conventional }];
    }
  }
  if (hooks && !Array.isArray(hooks) && typeof hooks === 'object'
      && Object.keys(hooks).length === 0) return [];
  const values = Array.isArray(hooks) ? hooks : [hooks];
  return values.map((value) => {
    if (typeof value !== 'string') return { kind: 'inline', value };
    if (!value.startsWith('./')) return { kind: 'invalid-path', value };
    const resolved = path.resolve(root, value);
    const inside = resolved === root || resolved.startsWith(`${root}${path.sep}`);
    return inside ? { kind: 'file', value: resolved } : { kind: 'outside', value };
  });
}

function inspectPlugin(ref, cacheDir) {
  const parsed = splitRef(ref);
  if (!parsed) {
    const hookIssues = [`invalid plugin reference "${ref}"`];
    return { ref, version: null, root: null, hookFiles: [], inlineHookDocuments: [], skillFiles: [], hookIssues, skillIssues: [], issues: hookIssues };
  }
  const base = path.join(cacheDir, parsed.marketplace, parsed.plugin);
  const version = newestVersionDir(base);
  if (!version) {
    const hookIssues = [`${ref}: enabled but no cached version is installed`];
    return { ref, version: null, root: null, hookFiles: [], inlineHookDocuments: [], skillFiles: [], hookIssues, skillIssues: [], issues: hookIssues };
  }
  const root = path.join(base, version);
  if (!canonicallyContained(cacheDir, root)) {
    const hookIssues = [`${ref}: cached generation escapes the plugin cache root`];
    return { ref, version, root: null, hookFiles: [], inlineHookDocuments: [], skillFiles: [], hookIssues, skillIssues: [], issues: hookIssues };
  }
  const manifestCandidates = [
    path.join(root, '.codex-plugin', 'plugin.json'),
    path.join(root, '.agent-plugin', 'plugin.json'),
    path.join(root, '.claude-plugin', 'plugin.json'),
  ];
  let manifestFile = null;
  let unsafeManifest = null;
  for (const file of manifestCandidates) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !canonicallyContained(root, file)) {
        unsafeManifest = file;
        break;
      }
      manifestFile = file;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') { unsafeManifest = file; break; }
    }
  }
  if (unsafeManifest) {
    const hookIssues = [`${ref}: plugin manifest must be a contained regular non-symlink file: ${unsafeManifest}`];
    return { ref, version, root, hookFiles: [], inlineHookDocuments: [], skillFiles: [], hookIssues, skillIssues: [], issues: hookIssues };
  }
  if (!manifestFile) {
    const hookIssues = [`${ref}: cached generation ${version} has no supported plugin manifest`];
    return {
      ref, version, root, hookFiles: [], inlineHookDocuments: [], skillFiles: [], hookIssues, skillIssues: [], issues: hookIssues,
    };
  }
  const manifest = readJson(manifestFile);
  if (manifest.error) {
    const hookIssues = [`${manifestFile}: ${manifest.error}`];
    return { ref, version, root, hookFiles: [], inlineHookDocuments: [], skillFiles: [], hookIssues, skillIssues: [], issues: hookIssues };
  }

  const hookFiles = [];
  const inlineHookDocuments = [];
  const hookIssues = advisoryIssues(ref, version);
  for (const target of hookTargets(manifest.value?.hooks, root)) {
    if (target.kind === 'outside') {
      hookIssues.push(`${ref}: hook path escapes the plugin root: ${target.value}`);
      continue;
    }
    if (target.kind === 'invalid-path') {
      hookIssues.push(`${ref}: hook path must start with "./": ${target.value}`);
      continue;
    }
    if (target.kind === 'inline') {
      const inlineIssues = validateHookDocument(target.value, `${ref} inline hooks`);
      hookIssues.push(...inlineIssues);
      if (inlineIssues.length === 0) inlineHookDocuments.push(target.value);
      continue;
    }
    hookFiles.push(target.value);
    const hook = readJson(target.value);
    if (hook.error) hookIssues.push(`${target.value}: ${hook.error}`);
    else hookIssues.push(...validateHookDocument(hook.value, target.value));
  }
  const skills = inspectSkills(root);
  const skillIssues = skills.issues;
  return {
    ref, version, root, manifestFile, hookFiles, inlineHookDocuments, skillFiles: skills.files,
    hookIssues, skillIssues, issues: [...hookIssues, ...skillIssues],
  };
}

/** Inspect every explicitly enabled plugin's newest cached generation. */
export function inspectCodexPlugins({
  configFile = paths.codexConfigPath(),
  cacheDir = paths.codexPluginCacheDir(),
} = {}) {
  const config = readCodexConfig(configFile);
  if (config.status !== 'valid') {
    const configIssues = ['absent'].includes(config.status) ? []
      : [`${configFile}: ${config.error}`];
    return {
      configPresent: config.status !== 'absent', configFile, configDigest: null,
      configViaSymlink: config.viaSymlink,
      configStatus: config.status, configIssues,
      enabled: [], plugins: [], pluginFindings: [], placementIssues: [],
      hookIssues: [], skillIssues: [], issues: configIssues,
    };
  }
  const source = config.text;
  const configDigest = config.digest;
  const utf8Valid = config.bytes.equals(Buffer.from(source));
  const structure = inspectCodexTomlStructure(source);
  const enabled = enabledPluginRefs(source);
  const plugins = enabled.map((ref) => inspectPlugin(ref, cacheDir));
  const pluginFindings = pluginPlacementFindings(enabled, plugins, configFile, configDigest);
  const placementIssues = pluginFindings.map((finding) => finding.message);
  const decoratedPlugins = plugins.map((inspected) => {
    const findings = pluginFindings.filter((finding) => finding.ref === inspected.ref);
    const issues = findings.map((finding) => finding.message);
    return {
      ...inspected,
      pluginFindings: findings,
      placementIssues: issues,
      issues: [...issues, ...inspected.issues],
    };
  });
  const configStatus = utf8Valid && structure.valid ? 'valid' : 'invalid';
  const configIssues = configStatus === 'valid' ? [] : [
    `${configFile}: ${utf8Valid ? structure.error : 'config is not valid UTF-8'}`,
  ];
  return {
    configPresent: true,
    configFile,
    configDigest,
    configStatus,
    configViaSymlink: config.viaSymlink,
    configIssues,
    enabled,
    plugins: decoratedPlugins,
    pluginFindings,
    placementIssues,
    hookIssues: decoratedPlugins.flatMap((plugin) => plugin.hookIssues),
    skillIssues: decoratedPlugins.flatMap((plugin) => plugin.skillIssues),
    issues: [...configIssues, ...decoratedPlugins.flatMap((plugin) => plugin.issues)],
  };
}
