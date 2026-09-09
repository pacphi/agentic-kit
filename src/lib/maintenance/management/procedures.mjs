// ADR-0048 procedure rendering and the persistent step checklist
// (MNT-ACT-007..009, MNT-ACT-017).
//
// `renderProcedure` turns a signed `ProcedureRecipe` (recipes.mjs) into the
// nine-part panel object experience-specification.md describes. Rendering
// escapes ONLY typed trusted fields declared on the recipe itself
// (`recipe.typedArguments`); nothing here ever interpolates a raw discovered
// string into an executable position. The panel is copyable text — this
// module never spawns a process.
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFileAtomic } from '../../file-write.mjs';
import { SHELLS, SHELL_LABELS } from './model.mjs';

// ── Shell-specific escaping ──────────────────────────────────────────────
// Each function returns ONE safely-quoted token for the shell named. Every
// value — whatever its content — is wrapped so shell metacharacters
// ($(...), `...`, ;, |, &, etc.) stay inert. Callers never build a command by
// concatenating unescaped values.

function escapePosix(value) {
  // Single quotes disable ALL expansion in POSIX shells; the only special
  // case is an embedded single quote, closed/escaped/reopened.
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function escapePowerShell(value) {
  // Single-quoted PowerShell strings are literal; '' is the escape for '.
  return `'${String(value).replace(/'/g, "''")}'`;
}

function escapeCmd(value) {
  // cmd.exe has no true non-interpolating quote: '%' still expands inside
  // "...". Double the quote and neutralize '%' defensively.
  return `"${String(value).replace(/"/g, '""').replace(/%/g, '%%')}"`;
}

const ESCAPERS = Object.freeze({
  bash: escapePosix, zsh: escapePosix, powershell: escapePowerShell, cmd: escapeCmd,
  // A WSL shell runs bash inside; the inner command is POSIX-escaped, then
  // the whole line is wrapped once more for the Windows-side argv parser.
  wsl: (value) => escapePosix(value),
});

function commandWords(recipe) {
  const { typedArguments = {} } = recipe;
  if (typedArguments.command) {
    return [typedArguments.command, typedArguments.verb, typedArguments.package ?? typedArguments.flag].filter(Boolean);
  }
  return [typedArguments.manager, typedArguments.verb, typedArguments.flag, typedArguments.package].filter(Boolean);
}

function renderLine(recipe, shell) {
  const escape = ESCAPERS[shell];
  const words = commandWords(recipe).map((word) => escape(word));
  const line = words.join(' ');
  if (shell !== 'wsl') return line;
  const distro = recipe.typedArguments?.wslDistro;
  const prefix = distro ? `wsl.exe -d ${escapePowerShell(distro)} --` : 'wsl.exe --';
  return `${prefix} bash -lc ${escapePowerShell(line)}`;
}

/**
 * @param {any} recipe
 * @param {{ shell?: string, preferredShell?: string }} [choice]
 */
function resolveShell(recipe, { shell, preferredShell } = /** @type {any} */ ({})) {
  const requested = shell ?? preferredShell ?? recipe.shell;
  if (!SHELLS.includes(requested)) throw new TypeError(`unknown shell: ${requested}`);
  return requested;
}

function checklistSteps(recipe) {
  return [
    { stepId: 'review', label: `Review the ${SHELL_LABELS[recipe.shell]} command before running it.` },
    { stepId: 'run', label: 'Run the command in your own terminal.' },
    { stepId: 'verify', label: 'Run the verification command and confirm the expected result.' },
  ];
}

/**
 * Render one signed recipe into the nine-part procedure panel. `shell`
 * overrides the run-local selection; `preferredShell` is the environment's
 * remembered default; `recipe.shell` is the last fallback (MNT-ACT-017).
 * @param {any} recipe
 * @param {{ shell?: string, environment?: any, preferredShell?: string }} [choice]
 */
export function renderProcedure(recipe, { shell, environment, preferredShell } = /** @type {any} */ ({})) {
  const resolvedShell = resolveShell(recipe, { shell, preferredShell });
  return {
    outcome: recipe.expectedEffect,
    source: { authority: recipe.sourceAuthority, publisher: recipe.publisher, recipeVersion: recipe.recipeVersion },
    compatibility: {
      osAndVersionRange: recipe.osAndVersionRange ?? null,
      architecture: recipe.architecture ?? null,
      hostAndVersionRange: recipe.hostAndVersionRange ?? null,
      resourceKind: recipe.resourceKind ?? null,
      packageManagerAndRange: recipe.packageManagerAndRange ?? null,
      shells: [...SHELLS],
      environmentId: environment?.environmentId ?? null,
    },
    privilege: recipe.privilegeRequirement,
    network: recipe.networkRequirement,
    effect: recipe.expectedEffect,
    preserved: [...(recipe.preservedResources ?? [])],
    command: { shell: resolvedShell, shellLabel: SHELL_LABELS[resolvedShell], text: renderLine(recipe, resolvedShell) },
    verification: { shell: resolvedShell, shellLabel: SHELL_LABELS[resolvedShell], text: recipe.verification },
    checklist: checklistSteps(recipe),
    nextStepLabel: 'Verify after completing these steps',
  };
}

/** Copy-feedback text: names WHAT was copied, never a path. */
export function describeCopy(kind) {
  const label = { command: 'Command', verification: 'Verification command', checklist: 'Checklist' }[kind] ?? 'Text';
  return `${label} copied.`;
}

// ── Persistent per-guidance checklist store ────────────────────────────────

const CHECKLIST_STORE_SCHEMA = 'maintenance-procedure-checklist/v1';
const MAX_CHECKLIST_BYTES = 512 * 1024;

function storeFile(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('checklist store root must be a dedicated absolute directory');
  }
  return path.join(path.normalize(root), 'checklists.json');
}

function readAll(root, fsImpl) {
  let raw;
  try {
    raw = fsImpl.readFileSync(storeFile(root), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  const envelope = JSON.parse(raw);
  if (envelope.schemaVersion !== CHECKLIST_STORE_SCHEMA || typeof envelope.byGuidanceId !== 'object') {
    throw new Error('procedure checklist store schema mismatch');
  }
  return envelope.byGuidanceId;
}

function writeAll(root, byGuidanceId, fsImpl) {
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  const envelope = { schemaVersion: CHECKLIST_STORE_SCHEMA, byGuidanceId };
  const bytes = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(bytes) > MAX_CHECKLIST_BYTES) throw new Error('procedure checklist store exceeds size limit');
  writePrivateFileAtomic(storeFile(root), bytes, { fsImpl });
}

/** Owner-private persistent checklist state, one entry per guidanceId. Partial
 *  success keeps completed-step evidence so only the next grounded steps
 *  need to be shown again.
 * @param {{ root: string, fsImpl?: any, now?: () => Date }} options */
export function createChecklistStore({ root, fsImpl = fs, now = () => new Date() } = /** @type {any} */ ({})) {
  function getChecklist(guidanceId) {
    return readAll(root, fsImpl)[guidanceId] ?? { done: {}, updatedAt: null };
  }

  function setStepDone(guidanceId, stepId, done) {
    const all = readAll(root, fsImpl);
    const current = all[guidanceId] ?? { done: {}, updatedAt: null };
    const updated = { done: { ...current.done, [stepId]: Boolean(done) }, updatedAt: now().toISOString() };
    all[guidanceId] = updated;
    writeAll(root, all, fsImpl);
    return updated;
  }

  function listChecklists() {
    return readAll(root, fsImpl);
  }

  return { getChecklist, setStepDone, listChecklists };
}
