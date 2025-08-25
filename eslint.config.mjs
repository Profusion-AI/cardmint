// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

export default [
  // --- TypeScript source: typed linting + architecture rules
  {
    files: ['src/**/*.{ts,tsx}'],
    ...tseslint.configs.recommended[0],
    // Add typed rules on top (uses tsconfig)
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { import: importPlugin, '@typescript-eslint': tseslint.plugin },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true },
      },
    },
    rules: {
      // Architecture guardrails
      'import/no-restricted-paths': ['error', {
        zones: [
          // forbid legacy into src
          { target: './src', from: './legacy',
            message: '🚨 Legacy imports forbidden from src/. Use ports/adapters.' },

          // core cannot depend "up"
          { target: './src/core', from: './src/adapters',
            message: '🚨 Core cannot depend on adapters.' },
          { target: './src/core', from: './src/app',
            message: '🚨 Core cannot depend on app layer.' },

          // block adapters into most of src, but allow wiring.ts  
          { target: './src/!(app/wiring.ts)', from: './src/adapters',
            message: '🚨 Only src/app/wiring.ts can import adapters directly.' },
        ],
      }],

      // High-signal hygiene
      'no-warning-comments': ['error', {
        terms: ['PLACEHOLDER', 'NOT IMPLEMENTED', '@@@TEMP@@@'],
        location: 'anywhere',
      }],

      'import/order': ['warn', {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'never',
      }],
    },
  },

  // --- TypeScript "looser" zone (optional): downgrade `any` during migration
  {
    files: [
      'src/api/**',
      'src/utils/**',
      'src/adapters/**',
    ],
    rules: {
      // Keep velocity while migrating — tighten later
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // --- Plain JS & CJS files: declare Node globals and avoid TS rules
  {
    files: [
      '**/*.{js,cjs,mjs}',
      'jest.config.js',
      'test-*.js',
    ],
    languageOptions: {
      // Most of these are CommonJS
      sourceType: 'commonjs',
      globals: { ...globals.node },
      ecmaVersion: 2022,
    },
    rules: {
      // Ensure TS-only rules never run on JS
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // --- Global ignores (keep lean)
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'legacy/**',
      'scripts/**',
      'CrSDK_*/**',
      '*.cjs',                // legacy config blobs
      'eslint.config.mjs',    // don't lint the config itself
      '**/*.test.ts', '**/*.spec.ts',
    ],
  },
];