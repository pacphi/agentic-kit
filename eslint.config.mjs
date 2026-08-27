// Flat ESLint config. Scope: OUR code only (src/bin/tests/scripts). Vendored
// ruflo/aqe content (.claude, .agentic-qe, .agents) and historical docs are
// never linted — they aren't ours to fix and would drown real findings.
import js from '@eslint/js';
import globals from 'globals';

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
];
