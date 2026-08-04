import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UPGRADE = path.join(ROOT, 'docs', 'UPGRADING.md');
const MIGRATION_HEADING = '## 4.0 GA surface migration';

const retired = [
  {
    label: 'removed command or alias',
    pattern: /\bak(?:\s+x)?\s+(?:dual|provider)\b/gi,
  },
  {
    label: 'removed routing configuration name',
    pattern: /\b(?:providers\.)?dualRouting\b/g,
  },
  {
    label: 'removed persisted integration field',
    pattern: /\bproviders\.(?:hosts|bindings|primaryHost|codexMcp|rufloCodexMcp|opencodeMcp|opencodeManaged|opencodeCatalogDir)\b/g,
  },
  {
    label: 'removed collaboration adapter advice',
    pattern: /(?:\bdual-run\b|\bclaude-flow-codex\s+dual\s+run\b|@claude-flow\/codex\b)/gi,
  },
  {
    label: 'removed dynamic dual initialization advice',
    pattern: /\bruflo\s+init\s+--dual\b/gi,
  },
  {
    label: 'removed command module',
    pattern: /\bsrc\/commands\/(?:dual|x\/provider)\.mjs\b/g,
  },
];

function markdownFiles(root) {
  return filesWithExtension(root, '.md');
}

function filesWithExtension(root, extension) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesWithExtension(full, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(full);
  }
  return files;
}

function withoutSection(text, heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `${heading} is required`);
  assert.equal(text.indexOf(heading, start + heading.length), -1, `${heading} must occur once`);
  const next = text.indexOf('\n## ', start + heading.length);
  return `${text.slice(0, start)}${next === -1 ? '' : text.slice(next + 1)}`;
}

function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

function violations(file, text) {
  const found = [];
  for (const { label, pattern } of retired) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      found.push(`${path.relative(ROOT, file)}:${lineOf(text, match.index)} ${label}: ${match[0]}`);
    }
  }
  return found;
}

function stripJavaScriptComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('active docs, generated guidance, and rendered help contain only GA surfaces', () => {
  const activeDocs = [
    path.join(ROOT, 'README.md'),
    path.join(ROOT, 'MAINTAINER.md'),
    path.join(ROOT, 'AGENTS.md'),
    path.join(ROOT, 'CLAUDE.md'),
    path.join(ROOT, 'docs', 'adr', 'README.md'),
    ...markdownFiles(path.join(ROOT, 'claude')),
    ...markdownFiles(path.join(ROOT, 'docs')).filter((file) => (
      file !== UPGRADE
      && !file.includes(`${path.sep}docs${path.sep}adr${path.sep}`)
      && !file.includes(`${path.sep}docs${path.sep}archive${path.sep}`)
    )),
  ];
  const renderedSource = [
    path.join(ROOT, 'bin', 'agentic-kit.mjs'),
    ...fs.readdirSync(path.join(ROOT, 'src', 'commands'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
      .map((entry) => path.join(ROOT, 'src', 'commands', entry.name)),
    ...fs.readdirSync(path.join(ROOT, 'src', 'commands', 'x'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
      .map((entry) => path.join(ROOT, 'src', 'commands', 'x', entry.name)),
    path.join(ROOT, 'src', 'lib', 'providers.mjs'),
    path.join(ROOT, 'src', 'lib', 'dashboard', 'page.mjs'),
  ];

  const found = [];
  for (const file of activeDocs) found.push(...violations(file, fs.readFileSync(file, 'utf8')));
  for (const file of renderedSource) {
    found.push(...violations(file, stripJavaScriptComments(fs.readFileSync(file, 'utf8'))));
  }
  assert.deepEqual(found, [], `retired GA surfaces remain:\n${found.join('\n')}`);
});

test('ordinary runtime source cannot revive retired GA surfaces', () => {
  const migrationBoundaries = new Set([
    path.join(ROOT, 'src', 'lib', 'adapters', 'config.mjs'),
    path.join(ROOT, 'src', 'lib', 'live', 'event-schema.mjs'),
    path.join(ROOT, 'src', 'lib', 'routing-config.mjs'),
  ]);
  const removedSymbols = [
    {
      label: 'removed command module',
      pattern: /commands\/(?:dual|x\/provider)\.mjs/g,
    },
    {
      label: 'removed routing helper',
      pattern: /\b(?:seedDualRouting|seedDualRoutingIfDualHost|policyToDualRunConfig|escalatePolicy|DUAL_RUN_TEMPLATES|DUAL_RUN_TEMPLATE_NAMES)\b/g,
    },
    {
      label: 'removed live-session adapter',
      pattern: /\b(?:adaptDualRunRecord|DUAL_TEMPLATES|DUAL_TEMPLATE_NAMES)\b/g,
    },
    {
      label: 'removed adapter bootstrap',
      pattern: /\b(?:CODEX_ADAPTER_PKG|codexAdapterAction|ensureCodexAdapter|ensureDualAgents)\b/g,
    },
    {
      label: 'removed compatibility writer or guard',
      pattern: /\b(?:writeConfigModule|nativeWalConflict|legacyRouteProvider|deriveCompatibilityExports|byTranscriptProvider)\b/g,
    },
  ];
  const runtimeFiles = [
    path.join(ROOT, 'package.json'),
    path.join(ROOT, 'pnpm-lock.yaml'),
    ...filesWithExtension(path.join(ROOT, 'bin'), '.mjs'),
    ...filesWithExtension(path.join(ROOT, 'scripts'), '.mjs'),
    ...filesWithExtension(path.join(ROOT, 'src'), '.mjs'),
  ];
  const found = [];

  for (const file of runtimeFiles) {
    const text = stripJavaScriptComments(fs.readFileSync(file, 'utf8'));
    if (!migrationBoundaries.has(file)) found.push(...violations(file, text));
    for (const { label, pattern } of removedSymbols) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        found.push(`${path.relative(ROOT, file)}:${lineOf(text, match.index)} ${label}: ${match[0]}`);
      }
    }
  }

  assert.deepEqual(found, [], `retired runtime surfaces remain:\n${found.join('\n')}`);
});

test('the upgrading guide contains the only active migration vocabulary', () => {
  const text = fs.readFileSync(UPGRADE, 'utf8');
  const sectionStart = text.indexOf(MIGRATION_HEADING);
  const next = text.indexOf('\n## ', sectionStart + MIGRATION_HEADING.length);
  const section = text.slice(sectionStart, next === -1 ? text.length : next);

  for (const expected of [
    '`ak dual`',
    '`ak provider`',
    '`ak x provider`',
    '`providers.dualRouting`',
    '`providers.hosts`',
    '`providers.bindings`',
    '`providers.primaryHost`',
    '`integrations.hosts`',
    '`integrations.ownership`',
    '`routing`',
    '`routing.primaryHost`',
    '`routing.routes`',
    '`provenance`',
    '`escalation`',
    '--max-concurrent',
    '`@claude-flow/codex`',
  ]) {
    assert.ok(section.includes(expected), `migration section must name ${expected}`);
  }
  assert.match(section, /unknown commands/);
  assert.deepEqual(
    violations(UPGRADE, withoutSection(text, MIGRATION_HEADING)),
    [],
    'retired vocabulary must remain inside the single migration section',
  );
});

test('ADRs that retain retired vocabulary are explicitly marked by the GA decision', () => {
  const adrDir = path.join(ROOT, 'docs', 'adr');
  for (const file of markdownFiles(adrDir)) {
    if (file.endsWith(`${path.sep}README.md`) || file.endsWith('0020-ga-stable-surfaces.md')) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (violations(file, text).length === 0) continue;
    assert.match(
      text.slice(0, 1_200),
      /ADR-0020|0020-ga-stable-surfaces/,
      `${path.relative(ROOT, file)} retains historical vocabulary without a GA amendment`,
    );
  }
});

test('GA-amended ADRs carry living-plan metadata', () => {
  const adrDir = path.join(ROOT, 'docs', 'adr');
  for (const file of markdownFiles(adrDir)) {
    if (file.endsWith(`${path.sep}README.md`)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!/ADR-0020|0020-ga-stable-surfaces/.test(text.slice(0, 1_200))) continue;
    assert.match(text.slice(0, 1_200), /- \*\*Updated:\*\* \d{4}-\d{2}-\d{2}/,
      `${path.relative(ROOT, file)} needs an Updated date`);
    assert.match(text.slice(0, 1_200), /- \*\*Update note:\*\*/,
      `${path.relative(ROOT, file)} needs an update note`);
  }
});

test('maintainer command and package inventories match the stable manifest', () => {
  const maintainer = fs.readFileSync(path.join(ROOT, 'MAINTAINER.md'), 'utf8');
  assert.doesNotMatch(
    maintainer,
    /\*\*(?:Porcelain|Plumbing)\*\*[^\n]*`(?:dual|provider)`/,
    'maintainer command inventory must not revive a removed bare command',
  );
  for (const command of ['`usage`', '`run`', '`host`']) {
    assert.ok(maintainer.includes(command), `maintainer command inventory must include ${command}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const entry of pkg.files.filter((file) => !file.startsWith('!'))) {
    assert.ok(
      maintainer.includes(`\`${entry}\``),
      `maintainer package inventory must include ${entry}`,
    );
  }
});
