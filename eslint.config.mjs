// Flat ESLint config. Scope: OUR code only (src/bin/tests/scripts). Vendored
// ruflo/aqe content (.claude, .agentic-qe, .agents) and historical docs are
// never linted — they aren't ours to fix and would drown real findings.
import js from '@eslint/js';
import globals from 'globals';

// Project-scope write gate (ADR-0064, "Making it stick"): writers go through file-write.mjs, and
// user-level folders are resolved only in paths.mjs. A warning today; P7-01 makes it an error.
const FS_WRITE_METHODS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync', 'rm', 'rmSync',
  'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'copyFile', 'copyFileSync',
  'cp', 'cpSync', 'unlink', 'unlinkSync', 'symlink', 'symlinkSync', 'link', 'linkSync', 'chmod',
  'chmodSync', 'chown', 'chownSync', 'truncate', 'truncateSync', 'utimes', 'utimesSync', 'createWriteStream',
];
const USER_DIR_HELPERS = ['claudeDir', 'codexDir', 'opencodeDir'];
const FS_MESSAGE = 'Write through file-write.mjs so the project-scope write gate sees it (ADR-0064).';
const USER_DIR_MESSAGE = 'Resolve user-level folders only in paths.mjs; a project writer must not target them (ADR-0064).';

export default [
  {
    ignores: [
      'node_modules/**',
      '.claude/**',
      '.agentic-qe/**',
      '.agents/**',
      'docs/archive/**',
      'coverage/**',
      // Gitignored tool output, same category as coverage/: tests/ui writes
      // screenshots here and debugging sessions leave browser-context scratch
      // scripts behind. Linting them fails `check` for anyone who has run
      // `pnpm test:ui`, over globals (document, location) that are correct there.
      '.ui-artifacts/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{mjs,js,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // High-signal correctness rules; not a style bikeshed.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-eval': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // CommonJS test/statusline files use require/module.
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    // Complexity visibility for shipped code (src/bin only — tests are long by
    // nature). Warnings, not errors: the 2026-08 complexity audit found 399
    // functions over CC 10 (worst CC 250), so an error gate would be
    // unpayable today. Thresholds ratchet down per-directory as the refactor
    // tracks land; new code should stay under them from the start.
    files: ['src/**/*.{mjs,js,cjs}', 'bin/**/*.mjs'],
    rules: {
      complexity: ['warn', 25],
      'max-depth': ['warn', 5],
      'max-lines': ['warn', { max: 1000, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Writer modules: all of src/ except the three modules that own writes and locations.
    files: ['src/**/*.mjs'],
    ignores: ['src/lib/file-write.mjs', 'src/lib/scope-gate.mjs', 'src/lib/paths.mjs'],
    rules: {
      'no-restricted-imports': ['warn', {
        paths: ['node:fs', 'fs', 'node:fs/promises', 'fs/promises']
          .map((name) => ({ name, importNames: FS_WRITE_METHODS, message: FS_MESSAGE })),
        patterns: [{ regex: '(^|/)paths\\.mjs$', importNames: USER_DIR_HELPERS, message: USER_DIR_MESSAGE }],
      }],
      'no-restricted-properties': ['warn', ...['fs', 'fsp', 'fsImpl'].flatMap((object) => FS_WRITE_METHODS
        .map((property) => ({ object, property, message: FS_MESSAGE })))],
      'no-restricted-syntax': ['warn',
        {
          selector: `CallExpression[callee.object.property.name='promises'][callee.property.name=/^(${FS_WRITE_METHODS.join('|')})$/]`,
          message: FS_MESSAGE,
        },
        {
          selector: `CallExpression[callee.object.name='paths'][callee.property.name=/^(${USER_DIR_HELPERS.join('|')})$/]`,
          message: USER_DIR_MESSAGE,
        },
      ],
    },
  },
  {
    // admin-view.mjs is BROWSER code — never node-imported, only read as text and
    // embedded into the served admin page (ADR-0007 §5). It legitimately uses DOM
    // globals (document, localStorage, location, fetch, history, setInterval).
    // Lint it for correctness with the browser environment, not the node one.
    files: ['src/lib/admin-view.mjs'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // The statusline footer is an EMITTED shell-statusline template + its test:
    // deliberately old-school (var, literal ANSI escape bytes, bare catch bindings)
    // because the snippet runs embedded in the user's shell, not as normal source.
    // Relax the idiom rules here; syntax/undef checks still apply.
    files: ['src/templates/statusline-footer.cjs', 'tests/statusline-segments.test.cjs', 'tests/statusline-brain.test.cjs'],
    // getStdinData is injected by the host statusline runtime (guarded with typeof).
    languageOptions: { globals: { getStdinData: 'readonly' } },
    rules: {
      'no-var': 'off',
      'no-redeclare': 'off',
      'no-control-regex': 'off',
      'no-unused-vars': 'off',
      'no-useless-assignment': 'off',
      'prefer-const': 'off',
    },
  },
  {
    // src/lib/dashboard/client/**: the dashboard's browser bundle, split out of
    // the former single 4,066-line client.mjs template literal (2026-08
    // complexity audit, Finding 2) into real, individually lintable browser
    // modules. Never node-imported — client.mjs (the collector) reads each
    // file as TEXT, strips its cross-file `import`/`export` lines (concatenation
    // collapses the module graph into one flat classic-script scope, exactly
    // as the pre-split bundle already was), and serves the result inline
    // (ADR-0036). Real `import`/`export` between these files exists purely
    // so node --check/eslint can verify the actual cross-file dependency graph
    // — see each file's own header comment.
    //
    // `var` throughout (not `let`/`const`) is DELIBERATE, not legacy debt: every
    // file becomes one flat scope once concatenated, so two files each using
    // `let`/`const` for a same-named local (e.g. a loop index) would collide
    // with a hard SyntaxError at the CONCATENATED scope — `var`'s redeclare
    // tolerance is exactly what makes that safe. Converting away from it is a
    // cross-file, whole-bundle change, not a per-file cleanup.
    files: ['src/lib/dashboard/client/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.browser,
        // Cross-file MUTABLE state: each name below is declared+exported by
        // exactly one file but REASSIGNED (not just read) from others. Real
        // ES import bindings are read-only from the importing side (no-import-
        // assign) — declaring these as globals instead of importing them
        // documents the same "owned by one file" contract (see that file's
        // own `export var` declaration) without fighting the language's own
        // live-binding rules. Every name here is read-only FROM THIS LIST's
        // point of view only in the sense that eslint won't flag reassignment
        // — the actual single-owner discipline is enforced by code review,
        // same as any other shared-mutable-global codebase.
        aboutScrollPending: 'writable', consMode: 'writable', inflight: 'writable',
        intelProjects: 'writable', intelRequestSeq: 'writable', LAST: 'writable',
        lastAttempt: 'writable', lastUpdated: 'writable', LIMITS: 'writable',
        modelDirection: 'writable', modelRouteDirection: 'writable', modelRouteSort: 'writable',
        MODELS: 'writable', modelSearchTimer: 'writable', modelSnapshotId: 'writable',
        modelSort: 'writable', projSort: 'writable', selectedProjectKey: 'writable',
        selectedProjectLabel: 'writable', SYSTEM: 'writable', systemBusy: 'writable',
        systemPollTimer: 'writable', usageDays: 'writable', usageLoaded: 'writable',
        usageSession: 'writable', usageView: 'writable',
      },
    },
    rules: {
      'no-var': 'off',
      'no-redeclare': 'off',
      // Old-school defensive style throughout this bundle: `try{...}catch(e){}`
      // swallows a localStorage/URL/DOM quirk without needing the error value.
      // Never linted before this split (the audit's own Finding 2) — the
      // pattern itself isn't new, only its visibility to ESLint is.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Same rationale as the statusline-footer override below: pre-existing,
      // harmless "assigned, then unconditionally reassigned before use" spots
      // (e.g. a switch-like if/else-if/else chain that always overwrites its
      // seed value) that a first-time lint pass surfaces but changing would be
      // a behavior-adjacent edit this split does not make.
      'no-useless-assignment': 'off',
    },
  },
];
