/** 
 * ESLint Configuration for CardMint Architecture Cleanup
 * Enforces ports/adapters pattern and prevents legacy imports
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: [
    '@typescript-eslint',
    'import'
  ],
  extends: [
    'eslint:recommended',
    '@typescript-eslint/recommended'
  ],
  rules: {
    // Architecture enforcement rules
    'import/no-restricted-paths': ['error', {
      zones: [
        // Forbid imports from legacy anywhere
        {
          target: './src',
          from: './legacy',
          message: '🚨 ARCHITECTURE VIOLATION: Legacy imports forbidden from src/. Use ports/adapters pattern.'
        },
        // Core interfaces cannot depend on adapters or app
        {
          target: './src/core',
          from: './src/adapters',
          message: '🚨 ARCHITECTURE VIOLATION: Core ports cannot depend on adapters. Keep interfaces pure.'
        },
        {
          target: './src/core', 
          from: './src/app',
          message: '🚨 ARCHITECTURE VIOLATION: Core ports cannot depend on app layer.'
        },
        // Only wiring.ts can import both adapters and core together
        {
          target: './src',
          from: './src/adapters',
          except: ['./src/app/wiring.ts'],
          message: '🚨 ARCHITECTURE VIOLATION: Only src/app/wiring.ts can import adapters directly. Use dependency injection.'
        }
      ]
    }],
    
    // Forbid placeholder strings in production code
    'no-warning-comments': ['error', {
      terms: ['TODO', 'FIXME', 'PLACEHOLDER', 'NOT IMPLEMENTED', '@@@TEMP@@@'],
      location: 'anywhere'
    }],
    
    // Enforce consistent imports
    'import/order': ['warn', {
      groups: [
        'builtin',
        'external', 
        'internal',
        'parent',
        'sibling',
        'index'
      ],
      'newlines-between': 'never'
    }],
    
    // Prevent unused variables (except those prefixed with _)
    '@typescript-eslint/no-unused-vars': ['error', { 
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_' 
    }],
    
    // Require explicit return types for public methods
    '@typescript-eslint/explicit-function-return-type': ['warn', {
      allowExpressions: true,
      allowTypedFunctionExpressions: true
    }]
  },
  env: {
    node: true,
    es2022: true
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json'
  },
  settings: {
    'import/resolver': {
      typescript: {
        project: './tsconfig.json'
      }
    }
  },
  ignorePatterns: [
    'dist/**',
    'node_modules/**',
    'legacy/**',      // Legacy code is exempt from rules
    'scripts/**',     // Python helper scripts exempt
    '*.js',          // Only lint TypeScript files
    'CrSDK_*/**'     // Sony SDK exempt
  ]
};