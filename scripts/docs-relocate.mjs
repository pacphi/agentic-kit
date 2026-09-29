// Move documentation files while preserving links and exact repository-path mentions.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const posix = path.posix;
const REPO_URL = /(https:\/\/github\.com\/pacphi\/agentic-kit\/(?:blob|tree)\/main\/)([^\s)"'#<>]+)/g;
const LINK = /(\]\()([^)\s#]+)(#[^)]*)?(\))|(href=")(?:([^"#]+))(#[^"]*)?(")/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;
const TEXT = /(?:\.(?:md|mjs|cjs|js|json|jsonc|ya?ml|toml|html|txt|sh)|(?:^|\/)(?:Dockerfile|Makefile))$/;

export const isText = (file) => TEXT.test(file);
export const DEFAULT_SKIPS = [
  'docs/archive/', 'scripts/docs-relocate.mjs', 'scripts/docs-layout.mjs',
  'tests/kit/docs-relocate.test.mjs', 'tests/kit/docs-layout.test.mjs',
];

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const token = (value) => new RegExp(`(?<![A-Za-z0-9_./-])${escape(value)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'g');
const literal = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const literalToken = (value) => new RegExp(`(?<![A-Za-z0-9_.-])${escape(literal(value))}(?![A-Za-z0-9_-])`, 'g');
const both = (text, from, to) => text.replace(token(from), to).replace(literalToken(from), literal(to));

/** Hide Markdown fenced blocks and inline spans during rewrites. */
export function protectCode(text) {
  const kept = [];
  const stash = (chunk) => `\u0000${kept.push(chunk) - 1}\u0000`;
  const output = [];
  let fence; let block = [];
  for (const line of text.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      block.push(line);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
        output.push(stash(block.join('\n'))); fence = undefined; block = [];
      }
    } else if (marker) { fence = marker[1]; block = [line]; } else output.push(line);
  }
  if (fence) output.push(stash(block.join('\n')));
  const masked = output.join('\n').replace(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (span) => stash(span));
  // The sentinel cannot occur in ordinary Markdown and keeps stored spans opaque.
  const sentinel = String.fromCharCode(0);
  return { masked, restore: (value) => value.replace(new RegExp(`${sentinel}(\\d+)${sentinel}`, 'g'), (_, index) => kept[Number(index)]) };
}

export function parseMap(tsv) {
  return tsv.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const [from, to, mode = 'move'] = line.split('\t');
    if (!from || !to || !['move', 'redirect'].includes(mode)) throw new Error(`bad map row: ${line}`);
    if (from.endsWith('/') && mode === 'move') throw new Error(`a folder row can only redirect: ${line}`);
    return { from, to, mode };
  });
}

export function relocate(target, rows) {
  const exact = rows.find((row) => row.from === target || row.from === `${target}/`);
  if (exact) return exact.to.endsWith('/') && !target.endsWith('/') ? exact.to.slice(0, -1) : exact.to;
  const folder = rows.find((row) => row.from.endsWith('/') && target.startsWith(row.from));
  return folder ? folder.to + target.slice(folder.from.length) : target;
}

export function rewriteText(text, oldFile, newFile, rows, exists) {
  let rewritten = 0;
  const broken = [];
  const code = oldFile.endsWith('.md') ? protectCode(text) : { masked: text, restore: (value) => value };
  let output = code.masked.replace(LINK, (match, open, raw, fragment = '', close, hrefOpen, hrefRaw, hrefFragment = '', hrefClose) => {
    const target = raw ?? hrefRaw;
    if (EXTERNAL.test(target)) return match;
    let decoded;
    try { decoded = decodeURIComponent(target); } catch { return match; }
    const trailing = decoded.endsWith('/');
    const resolved = posix.normalize(posix.join(posix.dirname(oldFile), decoded));
    const bare = trailing ? resolved.replace(/\/$/, '') : resolved;
    if (!exists(bare)) { broken.push(target); return match; }
    const moved = relocate(bare, rows);
    if (moved === bare && oldFile === newFile) return match;
    let next = posix.relative(posix.dirname(newFile), moved.replace(/\/$/, '')) || '.';
    if (trailing || moved.endsWith('/')) next += '/';
    if (target !== decoded) next = encodeURI(next);
    if (next === target) return match;
    rewritten++;
    return raw !== undefined ? `${open}${next}${fragment}${close}` : `${hrefOpen}${next}${hrefFragment}${hrefClose}`;
  });
  output = output.replace(REPO_URL, (match, prefix, repoPath) => {
    const moved = relocate(repoPath, rows);
    if (moved === repoPath) return match;
    rewritten++;
    return prefix + moved;
  });
  return { text: code.restore(output), rewritten, broken };
}

export function destinationProblem(row, tracked, exists) {
  if (!tracked.has(row.from)) return `not tracked: ${row.from}`;
  const caseOnly = row.from !== row.to && row.from.toLowerCase() === row.to.toLowerCase();
  const clash = [...tracked].find((file) => file !== row.from && file.toLowerCase() === row.to.toLowerCase());
  if (clash) return `destination clashes with ${clash}: ${row.to}`;
  if (!caseOnly && exists(row.to)) return `destination exists: ${row.to}`;
  return null;
}

export function rewriteMentions(text, rows, { bare = false } = {}) {
  const moves = rows.filter((row) => row.mode === 'move').sort((a, b) => b.from.length - a.from.length);
  let output = text.replace(REPO_URL, (match, prefix, repoPath) => prefix + relocate(repoPath, rows));
  for (const row of moves) output = both(output, row.from, row.to);
  if (bare) for (const row of moves) {
    const from = posix.basename(row.from); const to = posix.basename(row.to);
    if (from !== to && posix.dirname(row.from) === posix.dirname(row.to)) output = both(output, from, to);
  }
  const before = text.split('\n');
  const changed = output.split('\n').flatMap((line, index) => (line === before[index] ? [] : [{ line: index + 1, before: before[index], after: line }]));
  return { text: output, changed };
}

export function emptiedDirs(moves) {
  const dirs = new Set();
  for (const { from } of moves) for (let dir = posix.dirname(from); dir.startsWith('docs/'); dir = posix.dirname(dir)) dirs.add(dir);
  return [...dirs].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

export function main(argv) {
  const mapIndex = argv.indexOf('--map');
  const mapFile = argv[mapIndex + 1];
  if (mapIndex < 0 || !mapFile) { console.error('usage: node scripts/docs-relocate.mjs --map <file.tsv> [--mentions] [--bare] [--skip <prefix>]... [--dry-run]'); return 2; }
  const dryRun = argv.includes('--dry-run'); const bare = argv.includes('--bare'); const mentions = bare || argv.includes('--mentions');
  const skips = [...DEFAULT_SKIPS, ...argv.flatMap((arg, index) => (arg === '--skip' ? [argv[index + 1]] : []))];
  const rows = parseMap(fs.readFileSync(mapFile, 'utf8'));
  const tracked = new Set(git(['ls-files']).split('\n').filter(Boolean));
  const directories = new Set([...tracked].flatMap((file) => file.split('/').slice(0, -1).map((_, index, all) => all.slice(0, index + 1).join('/'))));
  const existsBefore = (entry) => tracked.has(entry) || directories.has(entry);
  const moves = rows.filter((row) => row.mode === 'move');
  for (const row of moves) { const problem = destinationProblem(row, tracked, fs.existsSync); if (problem) throw new Error(problem); }
  const docs = [...tracked].filter((file) => /\.(md|html)$/.test(file));
  let links = 0; let files = 0; const broken = [];
  const edits = docs.map((oldFile) => {
    const newFile = moves.find((row) => row.from === oldFile)?.to ?? oldFile;
    const result = rewriteText(fs.readFileSync(oldFile, 'utf8'), oldFile, newFile, rows, existsBefore);
    broken.push(...result.broken.map((link) => `${oldFile}: ${link}`));
    if (result.rewritten) { links++; files++; }
    return { oldFile, newFile, ...result };
  });
  if (!dryRun) {
    for (const row of moves) { fs.mkdirSync(posix.dirname(row.to), { recursive: true }); git(['mv', row.from, row.to]); }
    for (const edit of edits) if (edit.rewritten) fs.writeFileSync(edit.newFile, edit.text);
    for (const directory of emptiedDirs(moves)) if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  }
  let mentionLines = 0; const byFrom = new Map(moves.map((row) => [row.from, row.to]));
  if (mentions) for (const oldFile of [...tracked].filter(isText)) {
    const file = byFrom.get(oldFile) ?? oldFile;
    if (skips.some((prefix) => file.startsWith(prefix) || oldFile.startsWith(prefix))) continue;
    const edit = edits.find((entry) => entry.oldFile === oldFile && entry.rewritten);
    const source = edit ? edit.text : fs.readFileSync(dryRun ? oldFile : file, 'utf8');
    const result = rewriteMentions(source, rows, { bare });
    if (!result.changed.length) continue;
    mentionLines += result.changed.length;
    if (dryRun) for (const change of result.changed) console.log(`${oldFile}:${change.line}\n  - ${change.before.trim()}\n  + ${change.after.trim()}`);
    else fs.writeFileSync(file, result.text);
  }
  console.log(`${dryRun ? 'would move' : 'moved'} ${moves.length}; ${links} link(s) in ${files} file(s)${mentions ? `; ${mentionLines} mention line(s)` : ''}`);
  if (broken.length) console.log(`already broken (left unchanged):\n  ${broken.join('\n  ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
