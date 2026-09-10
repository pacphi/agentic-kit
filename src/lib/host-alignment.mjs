// Host transport alignment. MCP configuration is not provider routing: AQE's
// claude-code/codex providers and Ruflo's dual-mode CLI workers remain intact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileWithBackup } from './file-write.mjs';
import { inspectCodexTomlStructure, isTomlTableLine } from './codex-toml-safety.mjs';
import { enabledPluginRefs } from './codex-plugins.mjs';
import { repoRoot } from './paths.mjs';

export const HOST_ALIGNMENT_POLICY = Object.freeze({
  id: 'supported-peer-transports/v1',
  managed: 'ak run: claude --print / codex exec',
  preserved: ['Ruflo dual-mode CLI workers', 'AQE claude-code/codex providers', 'Claude Codex companion via App Server'],
  sources: {
    codex: 'https://learn.chatgpt.com/docs/mcp-server',
    claude: 'https://code.claude.com/docs/en/headless',
    claudeTools: 'https://code.claude.com/docs/en/mcp#use-claude-code-as-an-mcp-server',
  },
});
const hash = value => createHash('sha256').update(value).digest('hex');
const equalArgs = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const hostAlignmentFindingId = finding => `host-alignment-${hash(JSON.stringify([
  finding.host, finding.file, finding.scope, finding.project ?? null, finding.name ?? null, finding.code,
])).slice(0,32)}`;
const selectedFinding = (finding, ids) => !ids || ids.includes(hostAlignmentFindingId(finding));
const executable = command => typeof command === 'string'
  ? command.replaceAll('\\', '/').split('/').at(-1).replace(/\.(exe|cmd)$/i, '') : '';

export function retiredCodexTransport(entry) {
  const cmd = executable(entry?.command);
  const args = entry?.args;
  if (!Array.isArray(args)) return false;
  if (cmd === 'codex') return args[0] === 'mcp-server';
  if (cmd !== 'npx') return false;
  const rest = ['-y', '--yes'].includes(args[0]) ? args.slice(1) : args;
  return /^@openai\/codex(?:@[\w.-]+)?$/.test(rest[0]) && rest[1] === 'mcp-server';
}

// JSON.parse validates grammar; the token walk additionally rejects duplicate
// keys, which JSON.parse would silently collapse during a corrective rewrite.
function uniqueJson(source) {
  const parsed = JSON.parse(source);
  const stack = [];
  for (const match of source.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
    const token = match[0];
    if (token === '{' || token === '[') stack.push(token === '{' ? new Set() : null);
    else if (token === '}' || token === ']') stack.pop();
    else if (/^\s*:/.test(source.slice(match.index + token.length))) {
      const key = JSON.parse(token);
      const keys = stack.at(-1);
      if (keys?.has(key)) throw new Error('duplicate JSON key');
      keys?.add(key);
    }
  }
  return parsed;
}

function readSource(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('configuration is not a bounded regular file');
  const bytes = fs.readFileSync(file);
  const source = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(source))) throw new Error('configuration is not UTF-8');
  return { file, source, digest: hash(bytes), mode: stat.mode & 0o777,
    identity: { real: fs.realpathSync(file), device: stat.dev, inode: stat.ino, mode: stat.mode } };
}

function safeJsonTransport(entry) {
  return Object.keys(entry).every(k => ['command', 'args', 'type', 'env'].includes(k))
    && (entry.type === undefined || entry.type === 'stdio')
    && (entry.env === undefined || (entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env) && Object.keys(entry.env).length === 0))
    && entry.command === 'codex' && equalArgs(entry.args, ['mcp-server']);
}

function scanJson(snapshot, scope, roots, findings, selectedIds) {
  const doc = uniqueJson(snapshot.source);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(doc) || (doc.mcpServers !== undefined && !object(doc.mcpServers))
    || (doc.projects !== undefined && !object(doc.projects))) throw new Error('invalid host configuration shape');
  let changed = false;
  function inspect(servers, entryScope, project = null) {
    if (servers !== undefined && !object(servers)) throw new Error('invalid server mapping');
    for (const [name, entry] of Object.entries(servers ?? {})) {
      if (!object(entry)) throw new Error('invalid MCP definition');
      const base = { host: 'claude', file: snapshot.file, scope: entryScope, project, name };
      if (retiredCodexTransport(entry)) {
        const repairable = safeJsonTransport(entry);
        findings.push({ ...base, code: 'retired-codex-mcp', level: 'fail', repairable,
          message: 'retired Codex MCP transport; use native CLI delegation or the Claude companion/App Server',
          remedy: 'ak host align --apply' });
        if (repairable && selectedFinding(findings.at(-1), selectedIds)) { delete servers[name]; changed = true; }
      } else if (executable(entry?.command) === 'claude' && equalArgs(entry.args, ['mcp', 'serve'])) {
        findings.push({ ...base, code: 'claude-tools-only', level: 'info', repairable: false,
          message: 'supported Claude tool server; agent delegation uses claude -p, Ruflo/AQE native providers, or ak run' });
      }
    }
  }
  inspect(doc?.mcpServers, scope, scope === 'project' ? path.dirname(snapshot.file) : null);
  if (scope === 'user') for (const [root, settings] of Object.entries(doc?.projects ?? {})) {
    if (roots.has(path.resolve(root))) inspect(settings?.mcpServers, 'local', root);
  }
  if (changed) snapshot.candidate = JSON.stringify(doc, null, 2) + '\n';
}

function scanToml(snapshot, scope, findings, selectedIds) {
  const structure = inspectCodexTomlStructure(snapshot.source);
  if (!structure.valid) throw new Error('ambiguous TOML structure');
  if (structure.lines.some(line => line.live && /^\s*(?:mcp_servers\b|"mcp_servers"|'mcp_servers')\s*[.=]/.test(line.text))) {
    throw new Error('unassessed inline or dotted MCP assignment');
  }
  const headers = structure.lines.filter(line => line.live && isTomlTableLine(line.text));
  for (const header of headers) {
    if (/^\s*\[\[?\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')(?:\s*\.|\s*\])/.test(header.text)
      && !/^\s*\[mcp_servers\.(?:"[A-Za-z0-9_-]+"|[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)*\]\s*(?:#.*)?$/.test(header.text)) {
      throw new Error('unassessed MCP table syntax');
    }
  }
  const seen = new Set();
  const removals = [];
  for (const [index, header] of headers.entries()) {
    const matched = /^\s*\[mcp_servers\.(?:"([A-Za-z0-9_-]+)"|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/.exec(header.text);
    if (!matched) continue;
    const name = matched[1] ?? matched[2];
    if (seen.has(name)) throw new Error('duplicate MCP table');
    seen.add(name);
    const end = headers[index + 1]?.start ?? snapshot.source.length;
    const body = snapshot.source.slice(header.end, end);
    const fields = body.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const decode = key => {
      try { return JSON.parse(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm').exec(body)?.[1] ?? 'null'); }
      catch { return null; }
    };
    const entry = { command: decode('command'), args: decode('args') };
    const base = { host: 'codex', file: snapshot.file, scope, project: scope === 'project' ? path.dirname(path.dirname(snapshot.file)) : null, name };
    if (retiredCodexTransport(entry)) {
      const children = headers.some(h => h.text.trim().startsWith(`[mcp_servers.${name}.`) || h.text.trim().startsWith(`[mcp_servers."${name}".`));
      const repairable = !children && fields.length === 2
        && fields.some(f => /^command\s*=/.test(f)) && fields.some(f => /^args\s*=/.test(f))
        && entry.command === 'codex' && equalArgs(entry.args, ['mcp-server']);
      findings.push({ ...base, code: 'retired-codex-mcp', level: 'fail', repairable,
        message: 'Codex self-registration through retired MCP; use native host/provider routing', remedy: 'ak host align --apply' });
      if (repairable && selectedFinding(findings.at(-1), selectedIds)) removals.push({ start: header.start, end });
    } else if (executable(entry.command) === 'claude' && equalArgs(entry.args, ['mcp', 'serve'])) {
      findings.push({ ...base, code: 'claude-tools-only', level: 'info', repairable: false,
        message: 'Claude tools exposed through MCP; this is not a Claude agent session' });
    } else if (/mcp-server/.test(body) && (!entry.command || !entry.args)) {
      throw new Error('MCP transport uses unassessed TOML syntax');
    }
  }
  if (enabledPluginRefs(snapshot.source).includes('codex@openai-codex')) {
    findings.push({ host: 'codex', file: snapshot.file, scope, name: 'codex@openai-codex',
      code: 'misplaced-claude-companion', level: 'fail', repairable: false,
      message: 'Claude companion plugin enabled inside Codex', remedy: 'ak heal hooks --host codex' });
  }
  if (removals.length) {
    let candidate = snapshot.source;
    for (const { start, end } of removals.reverse()) candidate = candidate.slice(0, start) + candidate.slice(end);
    snapshot.candidate = candidate;
  }
}

export function inspectHostAlignment({ projectRoots = [process.cwd()], home = os.homedir(),
  codexHome = process.env.CODEX_HOME || path.join(home, '.codex'),
  claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
  selectedFindingIds = undefined,
} = {}) {
  const roots = new Set(projectRoots.map(root => path.resolve(root)));
  for (const root of [...roots]) {
    const repository = repoRoot(root);
    if (repository) roots.add(repository);
  }
  /** @type {Map<string, {host:string, scope:string, format:string, project?:string}>} */
  const files = new Map([
    [path.join(home, '.claude.json'), { host: 'claude', scope: 'user', format: 'json' }],
    [path.resolve(codexHome, 'config.toml'), { host: 'codex', scope: 'user', format: 'toml' }],
  ]);
  for (const root of roots) {
    files.set(path.join(root, '.mcp.json'), { host: 'claude', scope: 'project', project: root, format: 'json' });
    const file = path.join(root, '.codex/config.toml');
    if (!files.has(file)) files.set(file, { host: 'codex', scope: 'project', project: root, format: 'toml' });
  }
  const findings = [], snapshots = [];
  if (path.resolve(claudeConfigDir) !== path.join(home, '.claude')) {
    files.delete(path.join(home, '.claude.json'));
    findings.push({ host: 'claude', scope: 'user', file: path.resolve(claudeConfigDir),
      code: 'config-unassessed', level: 'fail', repairable: false,
      message: 'custom CLAUDE_CONFIG_DIR requires host-specific configuration review', remedy: 'review the effective Claude config root before realignment' });
  }
  for (const [file, meta] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    let snapshot;
    try {
      snapshot = readSource(file);
      snapshots.push(snapshot);
      const local = [];
      if (meta.format === 'json') scanJson(snapshot, meta.scope, roots, local, selectedFindingIds);
      else scanToml(snapshot, meta.scope, local, selectedFindingIds);
      findings.push(...local);
    } catch (error) {
      if (snapshot) delete snapshot.candidate;
      if (error.code === 'ENOENT') continue;
      findings.push({ ...meta, file, code: 'config-unassessed', level: 'fail', repairable: false,
        message: 'configuration could not be safely assessed; review syntax, size, and symlinks', remedy: 'review configuration, then rerun ak host align' });
    }
  }
  const scope = { home, codexHome, claudeConfigDir, projectRoots: [...roots].sort(), selectedFindingIds };
  const digest = hash(JSON.stringify({ scope, findings, files: snapshots.map(s => [s.file, s.digest, s.identity]) }));
  return { policy: HOST_ALIGNMENT_POLICY, scope, digest, aligned: !findings.some(f => f.level === 'fail'), findings, snapshots };
}

export function publicHostAlignment(report) {
  const { snapshots, ...publicReport } = report;
  return { ...publicReport, repairs: snapshots.filter(s => s.candidate !== undefined).map(s => ({ file: s.file, sourceDigest: s.digest })) };
}

/** Configuration-declared projects supplement the session census: a project
 * can retain a live MCP file after its transcript has been archived. */
export function configuredHostProjects(home = os.homedir()) {
  let doc;
  try { doc = uniqueJson(readSource(path.join(home, '.claude.json')).source); }
  catch { return []; } // The alignment scan separately reports an unreadable config.
  const candidates = Object.keys(doc?.projects ?? {});
  if (candidates.length > 1024) throw new Error('too many configured projects; select explicit --project locations');
  return candidates.filter(root => {
    try { return path.isAbsolute(root) && fs.statSync(root).isDirectory(); }
    catch { return false; }
  });
}

export async function applyHostAlignment(report, { confirmed = false } = {}) {
  const backups = [], changed = [];
  if (!confirmed) return { ok: false, changed, backups, reason: 'approval-required' };
  const current = inspectHostAlignment(report.scope);
  if (current.digest !== report.digest) return { ok: false, changed, backups, reason: 'configuration-changed-since-preview' };
  try {
    for (const snapshot of current.snapshots.filter(s => s.candidate !== undefined)) {
      const fresh = readSource(snapshot.file);
      if (fresh.digest !== snapshot.digest || JSON.stringify(fresh.identity) !== JSON.stringify(snapshot.identity)) throw new Error('configuration changed before write');
      const backup = `${snapshot.file}.ak-host-align-${randomUUID()}.bak`;
      fs.copyFileSync(snapshot.file, backup, fs.constants.COPYFILE_EXCL);
      backups.push(backup);
      writeFileWithBackup(snapshot.file, snapshot.candidate);
      changed.push(snapshot.file);
      if (readSource(snapshot.file).digest !== hash(snapshot.candidate)) throw new Error('write verification failed');
    }
    const after = inspectHostAlignment(report.scope);
    const selectedRemaining = report.scope.selectedFindingIds
      ? after.findings.filter(f => f.code === 'config-unassessed' || selectedFinding(f, report.scope.selectedFindingIds)) : after.findings;
    return { ok: !selectedRemaining.some(f => f.level === 'fail'), changed, backups, remaining: after.findings };
  } catch (error) {
    return { ok: false, changed, backups, reason: error.message };
  }
}
