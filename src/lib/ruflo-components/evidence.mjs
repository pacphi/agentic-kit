// ADR-0058: ruflo's own evidence. Text parsing is tolerant; anything unreadable is null,
// which the classifier turns into `unknown` — never `active`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../exec.mjs';
import * as paths from '../paths.mjs';
import { componentEnv } from './env.mjs';
import { writePrivateFileAtomic } from '../file-write.mjs';

export const EVIDENCE_TTL_MS = 15 * 60_000;
export const EVIDENCE_STALE_MS = 24 * 3600_000;
export const AUDIT_LOG = () => path.join(os.tmpdir(), 'ruflo-mcp-audit.jsonl');
// ANSI SGR stripper. The ESC byte is built via fromCharCode (not a literal
// control char in a regex) so this stays clean under eslint no-control-regex.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const STATUS = { '✓': 'pass', '⚠': 'warn', '✗': 'fail' };

export function parseDoctor(text) {
  const rows = [];
  for (const raw of String(text).replace(ANSI, '').split(/\r?\n/)) {
    const m = raw.match(/([✓⚠✗])\s+([^:]+?):\s*(.*)$/);
    if (m) rows.push({ status: STATUS[m[1]], name: m[2].trim(), detail: m[3].trim() });
  }
  return rows;
}

export const parseRouteEmbedder = (text) => String(text).match(/embedder=([a-z0-9-]+)/i)?.[1] ?? null;

export function parseIntelligence(text) {
  const t = String(text).replace(ANSI, '');
  const mode = t.match(/Mode:\s*([a-z-]+)/i)?.[1];
  if (!mode) return null;
  const last = t.match(/Last Training:\s*(\d+)s ago/i)?.[1];
  const traj = t.match(/Trajectories\s*\|\s*(\d+)/i)?.[1];
  return { mode, lastTrainingSeconds: last ? Number(last) : null, trajectories: traj ? Number(traj) : null };
}

export function parseNeuralStatus(text) {
  const m = String(text).replace(ANSI, '').match(/SONA Engine\s*\|\s*([^|]+)\|/i);
  return m ? { sonaEngineLoaded: !/not loaded/i.test(m[1]) } : null;
}

// Funnel evidence is JSON on current ruflo (`funnel status --json`): the probe below
// requests --json, but the parser still accepts the older text form as a fallback so a
// stale/unpatched ruflo or a stderr-mixed capture still yields evidence rather than null.
/** ruflo funnel sources that outrank the user tier `ruflo funnel disable` writes (ADR-305). */
export const OUTRANKS_USER = /^(env|enterprise-policy)$/i;

export function parseFunnel(text) {
  const raw = String(text).replace(ANSI, '').trim();
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && typeof obj.enabled === 'boolean' && typeof obj.decidedBy === 'string') {
      return { enabled: obj.enabled, decidedBy: obj.decidedBy };
    }
  } catch { /* not JSON — fall through to the text form */ }
  const m = raw.match(/Funnel:\s*(enabled|disabled)\s*\(decided by:\s*([^)]+)\)/i);
  return m ? { enabled: m[1].toLowerCase() === 'enabled', decidedBy: m[2].trim() } : null;
}

export function auditStats(file, now = Date.now()) {
  let text;
  try {
    const { size } = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const length = Math.min(size, 5 * 1024 * 1024);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  let audited = 0; let refused = 0; const reasons = [];
  for (const line of text.split('\n')) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const at = Date.parse(rec?.timestamp);
    if (!Number.isFinite(at) || now - at > 24 * 3600_000) continue;
    audited += 1;
    if (rec.allowed === false) { refused += 1; if (rec.reason) reasons.push(String(rec.reason)); }
  }
  return { audited, refused, reasons: reasons.slice(-5) };
}

export function moduleVersionFromRuflo(pkg) {
  // The whole lookup — including computing the candidate bases — must never throw:
  // `paths.rufloRoot()`/`rufloNodeModules()` walk to `globalRoot()`, which throws
  // "cannot determine npm global root" whenever npm is not on PATH (its own comment:
  // sandboxed tests and hooks hit this). Unreadable stays null, never an escaped throw.
  let bases;
  try {
    bases = [
      path.join(paths.rufloNodeModules(), '@claude-flow', 'cli', 'node_modules'),
      paths.rufloNodeModules(),
      path.dirname(paths.rufloRoot()),
    ];
  } catch { return null; }
  for (const base of bases) {
    try { return JSON.parse(fs.readFileSync(path.join(base, pkg, 'package.json'), 'utf8')).version; } catch { /* next */ }
  }
  return null;
}

async function probe(runner, args, env, errors, key) {
  try {
    const r = await runner('ruflo', args, { env, timeout: 90_000 });
    if (r.code === 0) return r.stdout;
    errors[key] = (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 200);
  } catch (error) { errors[key] = String(error?.message ?? error).slice(0, 200); }
  return null;
}

/** Resolve one module's version through the injected resolver. A plain "not
 *  installed" null is not an error and gets no `errors[key]` entry; only a thrown
 *  resolver (the default `moduleVersionFromRuflo` no longer throws, but an injected
 *  test double or a future resolver might) is recorded there, and still resolves
 *  to null rather than escaping `collectEvidence`. */
function resolveVersion(resolveModuleVersion, pkg, errors, key) {
  try {
    return resolveModuleVersion(pkg) ?? null;
  } catch (error) {
    errors[key] = String(error?.message ?? error).slice(0, 200);
    return null;
  }
}

export async function collectEvidence({
  projectRoot, cfg, rufloVersion, runner = run, now = Date.now(), cwd = projectRoot ?? process.cwd(),
  resolveModuleVersion = moduleVersionFromRuflo,
}) {
  const env = { ...process.env, ...componentEnv(projectRoot, cfg, rufloVersion) };
  const errors = {};
  const call = (args, key) => probe((c, a, o) => runner(c, a, { ...o, cwd }), args, env, errors, key);
  const [typesafeDoc, metaDoc, route, intel, neural, funnel] = await Promise.all([
    call(['doctor', '--component', 'typesafe'], 'typesafe'),
    call(['doctor', '--component', 'metaharness'], 'metaharness'),
    call(['hooks', 'route', '--task', 'sync and review latest issues'], 'route'),
    call(['hooks', 'intelligence', 'stats'], 'intelligence'),
    call(['neural', 'status'], 'neural'),
    call(['funnel', 'status', '--json'], 'funnel'),
  ]);
  const typesafeRow = typesafeDoc ? parseDoctor(typesafeDoc).find((r) => /typesafe/i.test(r.name)) ?? null : null;
  const intelligence = intel ? parseIntelligence(intel) : null;
  const typesafeVersion = resolveVersion(resolveModuleVersion, '@ruvector/typesafe', errors, 'typesafeModule');
  const memoryVersion = resolveVersion(resolveModuleVersion, '@claude-flow/memory', errors, 'memoryModule');
  return {
    capturedAt: new Date(now).toISOString(),
    rufloVersion,
    typesafe: { resolves: typesafeVersion !== null, doctor: typesafeRow },
    minilm: { embedder: route ? parseRouteEmbedder(route) : null },
    learning: {
      mode: intelligence?.mode ?? null,
      engineLoaded: neural ? parseNeuralStatus(neural)?.sonaEngineLoaded ?? null : null,
      lastTrainingSeconds: intelligence?.lastTrainingSeconds ?? null,
      trajectories: intelligence?.trajectories ?? null,
    },
    turnCredit: { present: metaDoc ? parseDoctor(metaDoc).some((r) => /turn-credit/.test(r.detail)) : null },
    memoryFix: { version: memoryVersion },
    funnel: funnel ? parseFunnel(funnel) : null,
    governance: { audit: auditStats(AUDIT_LOG(), now) },
    errors,
  };
}

export function readEvidenceCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
export function writeEvidenceCache(file, evidence) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writePrivateFileAtomic(file, JSON.stringify(evidence) + '\n');
}
