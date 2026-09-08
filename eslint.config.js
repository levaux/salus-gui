// @ts-check
import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

/**
 * Flat ESLint config for salus-gui.
 *
 * Two project-specific guards (plan 001, decisions 3 and 6):
 *  1. The `well-known.ts` choke point: `.unscaled` / `.scale` member access
 *     (Salus.Common.Decimal internals) is banned everywhere except that module.
 *     A Decimal read field-by-field somewhere in a panel is how a number
 *     silently loses its scale.
 *  2. `console.log` is banned outside the bridge — the bridge is the one place
 *     structured stdout logging is the interface rather than a leftover.
 *
 * Paths below name packages that later stages create; a config entry whose
 * files do not exist yet is inert, not an error.
 */

/** Ban raw Decimal-internal field access outside the choke-point module. */
const decimalChokePoint = {
  name: 'salus-gui/decimal-choke-point',
  files: ['**/*.ts', '**/*.svelte'],
  // well-known.ts owns the helpers; its own test necessarily pokes at the raw
  // Decimal internals to prove them — both are exempt from the ban.
  ignores: ['packages/proto/src/well-known.ts', 'packages/proto/src/well-known.test.ts'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "MemberExpression > Identifier.property[name='unscaled']",
        message:
          'Access to Salus.Common.Decimal.unscaled is forbidden outside packages/proto/src/well-known.ts. Use the well-known.ts helpers instead.',
      },
      {
        selector: "MemberExpression > Identifier.property[name='scale']",
        message:
          'Access to Salus.Common.Decimal.scale is forbidden outside packages/proto/src/well-known.ts. Use the well-known.ts helpers instead.',
      },
    ],
  },
};

export default ts.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.svelte-kit/**',
      'packages/proto/src/gen/**',
      'packages/proto/vendor/**',
      '**/node_modules/**',
      '**/test-results/**',
      // Design mocks under design/ are a reference surface, not product code:
      // the runtime beside them is generated bundle output from another
      // toolchain. Linting it reports on code we neither wrote nor ship.
      'design/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // `_`-prefixed names are the intentional-unused convention, used by
      // stubs that declare a signature a later stage fills in.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Parse the TypeScript inside <script lang="ts"> blocks of .svelte files.
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: {
        parser: ts.parser,
        extraFileExtensions: ['.svelte'],
      },
    },
    // no-undef is redundant with TS type-checking and mis-fires on the type
    // parameter of a Svelte 5 `generics="…"` component; typescript-eslint's
    // own guidance is to disable it for TS-checked files.
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['packages/streams/**/*.ts', 'packages/ui-kit/**/*', 'apps/web/**/*'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  decimalChokePoint,
  {
    // The bridge is the one place structured stdout logging is expected.
    files: ['apps/bridge/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
