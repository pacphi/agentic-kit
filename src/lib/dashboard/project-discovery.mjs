// project-discovery.mjs — machine-wide discovery of every ruflo-initialized
// project on this machine, for a later Intelligence-panel feature that will
// aggregate across all of them and let a user pick one to view. This module's
// ONLY concern is discovery: it returns plain { path, label, source } rows
// and does no aggregation, no reading of neural PATTERNS, and no dependency
// on intel-history.mjs (sorting reads .claude-flow/neural/stats.json
// directly, deliberately duplicating intel-history.mjs's tiny `?? 0` default
// rather than importing it, per this module's brief).
//
// "Ruflo has genuinely initialized" a directory means it has a
// .claude-flow/neural/ subdirectory (fs.existsSync check below) — a bare
// .claude-flow/ with no neural/ subdir is NOT enough; that's how a project
// that only ever ran e.g. `ruflo daemon start` without ever training/learning
// anything gets correctly excluded.
//
// ── Two sources, unioned ────────────────────────────────────────────────────
//
// SOURCE 1 (primary, guaranteed-correct): registryWorkspaces() from
// ../daemons.mjs, reused VERBATIM (imported, not reimplemented) — it walks
// ~/.claude-flow/{ai-jobs.json,workspace-leases.json,repo-supervisors.json}
// and returns every workspace path recorded there that has a .claude-flow
// directory. That function was previously module-private in daemons.mjs; it
// has been given a bare `export` (visibility only, zero behavior change) so
// it could be imported here instead of duplicated — the only edit made
// outside this file, and made because the frozen contract for this module
// requires verbatim reuse, which is otherwise impossible to satisfy.
//
// SOURCE 2 (cross-reference, structurally empty today): Observability's own
// persisted notion of known projects — WorkspaceSnapshotStore
// (../live/workspace-store.mjs) reading
// ~/.config/agentic-kit/observability-workspaces.json. Investigated against
// the REAL file on this machine (229 session records, schemaVersion 1) and
// against workspace-store.mjs's `safeRecord`/`safeWorkspace` sanitizers:
// every record's workspace carries only `repositoryLabel` (a single
// path-separator-free leaf name, e.g. "emailibrium") and `directoryLabel` (a
// relative fragment like "backend" or "repo root", with absolute-looking or
// ".."-traversal strings explicitly rejected by workspace-store.mjs's own
// `workspaceText()` sanitizer). That sanitizer exists specifically so this
// store never retains a real filesystem path — it is a deliberately
// privacy-safe label store, not a path index. A scan of the real file found
// ZERO absolute-path-shaped strings in any record, and structurally cannot
// find one as long as that schema holds. The code below still does a real,
// defensive per-record check — via resolvableAbsolutePath() — rather than
// skipping source 2 outright, so it starts pulling genuine extra projects
// automatically if that schema ever grows a real cwd/path field.
//
// SOURCE 3 (primary in practice): raw transcript content under
// ~/.claude/projects/**/*.jsonl and ~/.codex/sessions/**/*.jsonl, read via
// native-transcript-discovery.mjs's discoverJsonl()/bootstrapRecords() — the
// exact same functions live-sessions-service.mjs already trusts for
// Observability's live session tracking. Unlike source 2's *persisted,
// privacy-sanitized* registry, these are the raw session transcripts
// themselves: legitimately readable at this trust boundary (same user, same
// machine, same files Observability already parses), and unlike the
// sanitized store they DO carry a real absolute cwd — flat `record.cwd` for
// Claude records, `record.payload.cwd` for Codex's session_meta/turn_context
// records. Bounded to the MAX_TRANSCRIPT_FILES most-recently-modified
// transcripts (discoverJsonl's own recency sort) so this stays cheap
// regardless of how many total sessions a project has accumulated; dedup
// against sources 1/2 happens for free through record()'s existing
// resolved-path Map.
//
// ── Real-machine result the above implies ───────────────────────────────────
// ~/.claude-flow/{ai-jobs.json,workspace-leases.json,repo-supervisors.json}
// do not exist on this machine, so source 1 (registryWorkspaces()) returns
// an empty Set here — despite daemons.mjs's own header comment assuming
// ruflo 3.28+ reliably writes those files (this machine runs ruflo 3.34.0
// and does not have them; a per-project .claude-flow/daemon.pid still
// exists, so daemons DO run here, just without that specific central
// registry). Source 2 is structurally empty per its own privacy design
// (above). Source 3 is what actually makes discoverRuvfloProjects() return
// real projects on this machine today — verified against this repo's own 4
// real ruflo-initialized projects.
//
// ── Testability ──────────────────────────────────────────────────────────
// registryWorkspaces() takes no arguments and reads a `home` binding that
// paths.mjs captures ONCE from os.homedir() at module-load time — there is
// no runtime-overridable home-dir seam on the real function to inject
// against without fragile pre-import env-var tricks. WorkspaceSnapshotStore,
// by contrast, already takes its file path as a plain constructor argument
// (see live-sessions-service.mjs's own `options.workspaceFile ?? ...`
// pattern). So rather than inventing a parallel home-dir-resolver override,
// discoverRuvfloProjects() accepts optional { registryWorkspaces,
// resolveProjectLabel, observabilityFile, readObservabilityRecords }
// overrides — each defaulting to the real import — which lets tests
// substitute a fake registry sweep and a fixture observability file without
// touching HOME or module caching at all. readObservabilityRecords is a
// second, narrower seam on source 2 specifically: WorkspaceSnapshotStore's
// own sanitizer makes it IMPOSSIBLE to get an absolute path into a record
// even via a crafted fixture file (repositoryLabel rejects any path
// separator, directoryLabel rejects anything absolute-looking), so the
// merge/"both"-tagging logic is exercised by injecting already-sanitized-
// looking records directly; the realistic "skip" behavior is exercised via
// observabilityFile against the real WorkspaceSnapshotStore, matching what
// actually happens on a real machine. Source 3 accepts { claudeProjectsRoot,
// codexSessionsRoot, discoverJsonl, bootstrapRecords, maxTranscriptFiles }
// overrides on the same principle — each defaulting to the real
// claudeDir()/codexDir() paths and the real native-transcript-discovery.mjs
// functions, so tests can point at fixture transcript trees without
// touching HOME.
import fs from 'node:fs';
import path from 'node:path';
import { registryWorkspaces } from '../daemons.mjs';
import { resolveProjectLabel } from '../live/index.mjs';
import { WorkspaceSnapshotStore } from '../live/workspace-store.mjs';
import { bootstrapRecords, discoverJsonl } from '../live/native-transcript-discovery.mjs';
import { claudeDir, codexDir, observabilityWorkspacePath } from '../paths.mjs';
import { readJson } from '../settings.mjs';

const MAX_TRANSCRIPT_FILES = 150;

/** True only when `candidate` has real ruflo learning state, not merely a
 *  .claude-flow directory. */
function hasNeuralState(candidate) {
  return fs.existsSync(path.join(candidate, '.claude-flow', 'neural'));
}

/** Canonicalize for dedup so a symlinked/relative variant of the same
 *  project never appears twice. Falls back to path.resolve when the target
 *  can't be realpath'd (e.g. permissions), matching project-label.mjs's own
 *  fallback convention. */
function resolvePath(candidate) {
  try { return fs.realpathSync.native(candidate); }
  catch { return path.resolve(candidate); }
}

/** Reuse Observability's own label for the same path so a project reads
 *  identically here and there; falls back to the bare directory name if
 *  resolveProjectLabel can't be used for any reason. */
function labelFor(resolveProjectLabelImpl, resolved) {
  try {
    const label = resolveProjectLabelImpl(resolved);
    if (typeof label === 'string' && label && label !== 'unknown') return label;
  } catch { /* fall through to basename */ }
  return path.basename(resolved) || resolved;
}

/** Look for a genuinely resolvable absolute filesystem path inside a
 *  WorkspaceSnapshotStore record's workspace. Per the header notes above,
 *  the real schema never carries one (repositoryLabel/directoryLabel are
 *  sanitized labels, not paths) — this returns null in that case rather than
 *  reconstructing anything from a label. */
function resolvableAbsolutePath(workspace) {
  if (!workspace || typeof workspace !== 'object') return null;
  for (const candidate of [workspace.directoryLabel, workspace.repositoryLabel]) {
    if (typeof candidate === 'string' && path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Default source-2 reader: the real WorkspaceSnapshotStore against the real
 *  (or injected) file. Kept as its own named function so tests can override
 *  just this seam (readObservabilityRecords) when they need to exercise the
 *  merge logic with record shapes the store's own sanitizer would otherwise
 *  make unreachable. */
function readObservabilityRecords(file) {
  return new WorkspaceSnapshotStore(file).records();
}

/** Source-3 candidates: real absolute cwd values read directly out of Claude
 *  and Codex transcript content under `root`, via the exact discoverJsonl/
 *  bootstrapRecords functions live-sessions-service.mjs already trusts for
 *  Observability. Bounded to the maxFiles most-recently-modified transcripts
 *  (discoverJsonl's own recency sort) so a project with hundreds of sessions
 *  costs no more to scan than one with a handful — dedup happens for free
 *  downstream in record()'s resolved-path Map, so returning the same cwd
 *  from many sessions in one project is harmless, not wasted work avoided
 *  here on purpose. Returns [] on any read/parse failure for a given file
 *  (bootstrapRecords already degrades that way) rather than aborting the
 *  whole scan over one bad transcript. */
function transcriptCwdCandidates(root, adapter, { maxFiles, discoverJsonl: discoverJsonlImpl, bootstrapRecords: bootstrapRecordsImpl }) {
  const files = discoverJsonlImpl(root, { maxDepth: 6, maxFiles, accept: () => true });
  const candidates = [];
  for (const file of files) {
    const records = bootstrapRecordsImpl(file, adapter);
    for (const rec of records) {
      const cwd = adapter === 'codex' ? rec?.payload?.cwd : rec?.cwd;
      if (typeof cwd === 'string' && cwd) candidates.push(cwd);
    }
  }
  return candidates;
}

/** .claude-flow/neural/stats.json's lastAdaptation, read directly (no
 *  intel-history.mjs dependency, per this module's discovery-only brief).
 *  Missing/unreadable/non-numeric defaults to 0, oldest-first among ties. */
function lastAdaptationOf(projectPath) {
  const stats = readJson(path.join(projectPath, '.claude-flow', 'neural', 'stats.json'));
  const value = stats?.lastAdaptation;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Every project on this machine ruflo has genuinely initialized, deduplicated
 * by resolved absolute path and sorted most-recently-active first.
 * @returns {Array<{ path: string, label: string, source: 'registry'|'observability'|'transcript'|'both' }>}
 *   'both' means 2+ sources agree on the same resolved path, not literally
 *   exactly two.
 */
export function discoverRuvfloProjects({
  registryWorkspaces: registryWorkspacesImpl = registryWorkspaces,
  resolveProjectLabel: resolveProjectLabelImpl = resolveProjectLabel,
  observabilityFile = observabilityWorkspacePath(),
  readObservabilityRecords: readObservabilityRecordsImpl = readObservabilityRecords,
  claudeProjectsRoot = path.join(claudeDir(), 'projects'),
  codexSessionsRoot = path.join(codexDir(), 'sessions'),
  discoverJsonl: discoverJsonlImpl = discoverJsonl,
  bootstrapRecords: bootstrapRecordsImpl = bootstrapRecords,
  maxTranscriptFiles = MAX_TRANSCRIPT_FILES,
} = {}) {
  const projects = new Map(); // resolved absolute path -> row

  const record = (candidate, tag) => {
    if (typeof candidate !== 'string' || !candidate || !path.isAbsolute(candidate)) return;
    if (!hasNeuralState(candidate)) return;
    const resolved = resolvePath(candidate);
    const existing = projects.get(resolved);
    if (existing) {
      if (existing.source !== tag) existing.source = 'both';
      return;
    }
    projects.set(resolved, { path: resolved, label: labelFor(resolveProjectLabelImpl, resolved), source: tag });
  };

  // Source 1 — the guaranteed-correct registry sweep.
  for (const workspace of registryWorkspacesImpl()) record(workspace, 'registry');

  // Source 2 — cross-reference Observability's persisted workspace snapshots.
  let snapshotRecords;
  try { snapshotRecords = readObservabilityRecordsImpl(observabilityFile) ?? []; }
  catch { snapshotRecords = []; }
  for (const entry of snapshotRecords) {
    const candidate = resolvableAbsolutePath(entry?.workspace);
    if (candidate) record(candidate, 'observability');
  }

  // Source 3 — real cwd values read out of raw Claude/Codex transcript
  // content. In practice, the primary source of real results on a machine
  // where source 1's central registry files don't exist (see header notes).
  const transcriptOpts = { maxFiles: maxTranscriptFiles, discoverJsonl: discoverJsonlImpl, bootstrapRecords: bootstrapRecordsImpl };
  for (const candidate of transcriptCwdCandidates(claudeProjectsRoot, 'claude', transcriptOpts)) {
    record(candidate, 'transcript');
  }
  for (const candidate of transcriptCwdCandidates(codexSessionsRoot, 'codex', transcriptOpts)) {
    record(candidate, 'transcript');
  }

  const rows = [...projects.values()];
  const lastAdaptation = new Map(rows.map((row) => [row.path, lastAdaptationOf(row.path)]));
  rows.sort((a, b) => lastAdaptation.get(b.path) - lastAdaptation.get(a.path));
  return rows;
}
