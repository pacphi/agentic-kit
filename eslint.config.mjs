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
