// The ONE bounded directory walker every machine-footprint collector uses, and
// the Measurement vocabulary they all report in (ADR-0025, docs/ddd/machine-
// footprint.md invariants 2 and 6). No other module in this context may readdir
// on its own: the caps, the never-follow-symlinks rule, and the
// degrade-this-node-only failure mode are safety-critical, so they get exactly
// one implementation to audit rather than one per collector.
//
// Metadata only, structurally. This module has no read path for file contents —
// readdir entries and lstat results are all it can obtain — so no collector
// built on it can acquire one by accident (invariant 1).
//
// The limits are explicit, not inherited, so a caller reads what it is buying:
//
//   maxDepth    How far below `root` the walk descends. A global npm tree nests
//               node_modules several levels; codex transcript roots are four
//               deep (YYYY/MM/DD/file). 16 covers both without letting a
//               pathological tree run away. Hitting it marks the walk truncated
//               — the figures are then a floor, never a total.
//   maxEntries  Every dirent seen counts, including skipped symlinks. This is
//               the wall-clock bound: a walk that exhausts it stops and says so.
//   maxDegraded How many unreadable-node reasons are RETAINED. The degraded
//               COUNT is always exact; only the retained sample is capped, so a
//               permission-denied storm cannot balloon the payload.
//
// Symlinks are never followed and never counted. A symlinked tree's bytes
// belong to wherever they really live, counting them here would double-count
// them there, and following them is how a walker escapes its root or spins
// forever on a cycle.
import fs from 'node:fs';
import path from 'node:path';

export const WALK_LIMITS = Object.freeze({
  maxDepth: 16,
  maxEntries: 400_000,
  maxDegraded: 64,
});

export const MEASURED = 'measured';
export const CARRIED_FORWARD = 'carried-forward';
export const UNKNOWN = 'unknown';

/** A real walk/stat/count produced this. `partial: true` means a cap or an
 *  unreadable subtree cut the measurement short, so the value is a floor. */
export function measured(value, { asOf = null, partial = false } = {}) {
  return { value, status: MEASURED, reason: null, asOf, partial };
}

/** A figure from a previous deep scan, presented with THAT scan's asOf —
 *  never as current (invariant 3). */
export function carriedForward(value, asOf) {
  return { value, status: CARRIED_FORWARD, reason: null, asOf, partial: false };
}

/** Never measured, or the measurement failed. `reason` is mandatory: an
 *  unknown without a why is exactly the failure mode ADR-0023 exists to
 *  prevent, and it is the ONLY correct alternative to a number — a figure the
 *  collector does not have is never rendered as 0 (invariant 2). */
export function unknown(reason) {
  return {
    value: null,
    status: UNKNOWN,
    reason: String(reason || 'unmeasured'),
    asOf: null,
    partial: false,
  };
}

/** Did this snapshot's own collectors produce the figure (as opposed to a
 *  carried-forward one)? */
export const isMeasured = (m) => m?.status === MEASURED;
/** Is there a number at all — measured or carried forward? */
export const hasValue = (m) => typeof m?.value === 'number' && Number.isFinite(m.value);

/** Sum of the inputs that have values. An unknown input never contributes a 0;
 *  it makes the sum `partial`, i.e. an honest lower bound. An all-unknown sum
 *  is unknown, not 0. Summing an EMPTY list is a measured 0 — a caller that
 *  does not know whether there were inputs must pass an explicit unknown()
 *  rather than an empty array. */
export function sumMeasurements(list, { asOf = null } = {}) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return measured(0, { asOf });
  const usable = items.filter(hasValue);
  if (!usable.length) return unknown('every input unmeasured');
  const total = usable.reduce((acc, m) => acc + m.value, 0);
  const partial = usable.length < items.length || usable.some((m) => m.partial);
  return measured(total, { asOf, partial });
}

/** lstat one known path. Used for the individually-known files the cheap tier
 *  reads (ledgers, tee files, index caches) where a walk would be overkill.
 *  Never follows a symlink — a symlinked known-file reports kind 'symlink' and
 *  no bytes rather than silently measuring its target. */
export function statNode(target, { fsImpl = fs } = {}) {
  try {
    const st = fsImpl.lstatSync(target);
    const kind = st.isFile() ? 'file'
      : st.isDirectory() ? 'dir'
        : st.isSymbolicLink() ? 'symlink' : 'other';
    return {
      path: target,
      status: MEASURED,
      reason: null,
      kind,
      bytes: kind === 'file' ? st.size : null,
      mtimeMs: st.mtimeMs,
    };
  } catch (err) {
    return {
      path: target,
      status: UNKNOWN,
      reason: err?.code || 'io',
      kind: null,
      bytes: null,
      mtimeMs: null,
    };
  }
}

/**
 * Bounded, symlink-free tree walk. Returns bytes, file count, and newest mtime
 * for `root`, plus the provenance a caller needs to render the figure honestly.
 *
 * Failure semantics, per invariant 6: an unreadable subtree degrades THAT node
 * — it is recorded in `degraded` and the walk continues with its siblings. Only
 * an unreadable ROOT makes the whole result unknown. `complete` is the single
 * flag a caller checks: false means a cap fired or something was unreadable, so
 * `bytes`/`files` are floors.
 *
 * @param {string} root
 * @param {{
 *   maxDepth?: number, maxEntries?: number, maxDegraded?: number,
 *   skipDir?: ((dir: string, name: string, depth: number) => boolean) | null,
 *   acceptFile?: ((name: string, file: string, depth: number) => boolean) | null,
 *   onFile?: ((entry: { file: string, name: string, bytes: number,
 *                       blocks: number, mtimeMs: number,
 *                       depth: number }) => void) | null,
 *   fsImpl?: typeof fs,
 * }} [options] `skipDir` prunes a subtree deliberately (it does NOT mark the
 *   walk truncated — an intentional scope is not a failed measurement).
 *   `acceptFile` filters what is COUNTED and what reaches `onFile`; rejected
 *   files still consume the entry budget. `onFile` exceptions propagate: a
 *   collector bug must surface, not be swallowed as an unreadable subtree.
 */
export function walkTree(root, options = {}) {
  const {
    maxDepth = WALK_LIMITS.maxDepth,
    maxEntries = WALK_LIMITS.maxEntries,
    maxDegraded = WALK_LIMITS.maxDegraded,
    skipDir = null,
    acceptFile = null,
    onFile = null,
    fsImpl = fs,
  } = options;

  const result = {
    root,
    status: MEASURED,
    reason: null,
    bytes: 0,
    files: 0,
    dirs: 0,
    newestMtimeMs: null,
    entriesSeen: 0,
    symlinksSkipped: 0,
    truncated: false,
    truncatedBy: null,
    degradedCount: 0,
    degraded: [],
    complete: true,
  };

  const degrade = (target, reason) => {
    result.degradedCount += 1;
    result.complete = false;
    if (result.degraded.length < maxDegraded) result.degraded.push({ path: target, reason });
  };
  const truncate = (by) => {
    if (!result.truncated) { result.truncated = true; result.truncatedBy = by; }
    result.complete = false;
  };
  const countFile = (file, name, st, depth) => {
    result.files += 1;
    result.bytes += st.size;
    if (result.newestMtimeMs === null || st.mtimeMs > result.newestMtimeMs) {
      result.newestMtimeMs = st.mtimeMs;
    }
    // `blocks` rides along from the stat the walk has already paid for. A
    // consumer that wants to READ a file needs it: a cloud provider's evicted
    // placeholder (Dropbox/iCloud/OneDrive) stats as a normal file with a real
    // size but zero allocated blocks, and opening it blocks in the kernel until
    // the provider materializes it — which never returns when the provider is
    // signed out or offline. Undefined on a stat shim that omits it; callers
    // treat only an explicit 0 as the placeholder signal.
    if (onFile) {
      onFile({ file, name, bytes: st.size, blocks: st.blocks, mtimeMs: st.mtimeMs, depth });
    }
  };

  // A root that is itself a file is a legitimate node (opencode's single store,
  // a tee log). A root that is a symlink is refused rather than followed.
  const head = statNode(root, { fsImpl });
  if (head.status === UNKNOWN) {
    return { ...result, status: UNKNOWN, reason: head.reason, bytes: null, files: null, complete: false };
  }
  if (head.kind === 'symlink') {
    return { ...result, status: UNKNOWN, reason: 'symlink (never followed)', bytes: null, files: null, complete: false };
  }
  if (head.kind !== 'dir') {
    if (!acceptFile || acceptFile(path.basename(root), root, 0)) {
      countFile(root, path.basename(root), { size: head.bytes ?? 0, mtimeMs: head.mtimeMs }, 0);
    }
    return result;
  }

  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    if (result.entriesSeen >= maxEntries) { truncate('entries'); break; }
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = err?.code || 'io';
      // The root itself being unlistable is not a degraded subtree — there is
      // no sibling evidence to keep, so the whole node is unknown. Reporting it
      // as a "partial 0" would be exactly the unknown-rendered-as-zero failure
      // invariant 2 forbids: an EACCES directory is not an empty one.
      if (dir === root) {
        return { ...result, status: UNKNOWN, reason: code, bytes: null, files: null, complete: false };
      }
      degrade(dir, code);
      continue;
    }
    result.dirs += 1;
    for (const entry of entries) {
      if (result.entriesSeen >= maxEntries) { truncate('entries'); break; }
      result.entriesSeen += 1;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { result.symlinksSkipped += 1; continue; }
      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth) { truncate('depth'); continue; }
        if (skipDir && skipDir(file, entry.name, depth + 1)) continue;
        stack.push({ dir: file, depth: depth + 1 });
        continue;
      }
      // Sockets, fifos and device nodes hold no bytes this domain owns.
      if (!entry.isFile()) continue;
      if (acceptFile && !acceptFile(entry.name, file, depth + 1)) continue;
      let st;
      try {
        st = fsImpl.lstatSync(file);
      } catch (err) {
        degrade(file, err?.code || 'io');
        continue;
      }
      countFile(file, entry.name, st, depth + 1);
    }
  }
  return result;
}

// A wrapper created here is the only supported way to instrument walkTree while
// retaining its traversal contract. Keeping the witness in a module-local
// WeakSet means an arbitrary injected walker cannot opt itself into evidence
// reuse merely by returning `{ complete: true }` or attaching a public flag.
const compatibleWalkTreeAdapters = new WeakMap();

/**
 * Wrap the built-in walker with observation hooks without changing what it
 * traverses or returns. `before` may return opaque context that is handed to
 * `after`; this is enough for timers and work counters without reimplementing
 * the safety-critical walker.
 *
 * @param {{
 *   before?: ((input: { root: string, options: object }) => any) | null,
 *   after?: ((input: { root: string, options: object, result: any,
 *                      context: any }) => void) | null,
 * }} [hooks]
 * @returns {typeof walkTree}
 */
export function instrumentWalkTree({ before = null, after = null } = {}) {
  const instrumented = (root, options = {}) => {
    const context = before ? before({ root, options }) : null;
    const result = walkTree(root, options);
    if (after) after({ root, options, result, context });
    return result;
  };
  compatibleWalkTreeAdapters.set(instrumented, { before, after });
  return instrumented;
}

/** Only the built-in walker or a wrapper constructed above proves that it
 * honored the exact options and callbacks supplied by the collector.
 * @param {Function} walk */
export function carriesWalkTreeContract(walk) {
  return walk === walkTree || compatibleWalkTreeAdapters.has(walk);
}

/**
 * Let another module perform one contract-equivalent physical traversal while
 * retaining the hooks attached by instrumentWalkTree. The operation returns
 * its domain value separately from the WalkResult-shaped physical counters the
 * instrumentation receives.
 *
 * @param {Function} walk
 * @param {{ root: string, options?: object }} input
 * @param {() => { value: any, result: any }} operation
 */
export function runWalkTreeInstrumentation(walk, input, operation) {
  if (!carriesWalkTreeContract(walk)) {
    throw new TypeError('walk does not carry the built-in traversal contract');
  }
  const hooks = compatibleWalkTreeAdapters.get(walk);
  const options = input.options ?? {};
  const context = hooks?.before ? hooks.before({ root: input.root, options }) : null;
  const output = operation();
  if (hooks?.after) {
    hooks.after({ root: input.root, options, result: output.result, context });
  }
  return output.value;
}

/** A walk's byte/file figures as Measurements. An unreadable root yields
 *  unknown-with-reason; a truncated or partially degraded walk yields
 *  `partial: true` so the UI can render "at least", never a bare total. */
export function walkMeasurements(walk, { asOf = null } = {}) {
  if (!walk || walk.status === UNKNOWN) {
    const reason = walk?.reason || 'not measured';
    return { bytes: unknown(reason), files: unknown(reason) };
  }
  const partial = !walk.complete;
  return {
    bytes: measured(walk.bytes, { asOf, partial }),
    files: measured(walk.files, { asOf, partial }),
  };
}

/** ENOENT on a root is an ABSENCE, not a failed measurement: a directory that
 *  does not exist holds a real, measured zero bytes. Every other errno stays
 *  unknown-with-reason. This mirrors usage-index's rootHealth vocabulary
 *  (ok / absent / degraded) so the two agree on what "we saw nothing" means.
 *
 *  Presence describes only whether the ROOT could be read. A walk that hit an
 *  entry cap is still 'present' — the cap is a deliberate bound, not a read
 *  failure, and its effect is already carried by the Measurement's `partial`. */
export function presenceOf(walk) {
  if (!walk) return 'degraded';
  if (walk.status !== UNKNOWN) return 'present';
  return walk.reason === 'ENOENT' ? 'absent' : 'degraded';
}

/** Node figures for a root that may legitimately not exist. Absent → measured
 *  zero with presence 'absent'; unreadable → unknown with the errno. */
export function rootMeasurements(walk, { asOf = null } = {}) {
  const presence = presenceOf(walk);
  if (presence === 'absent') {
    return { presence, bytes: measured(0, { asOf }), files: measured(0, { asOf }) };
  }
  return { presence, ...walkMeasurements(walk, { asOf }) };
}
