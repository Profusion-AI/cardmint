/**
 * Dependency Cruiser Configuration - CardMint Architecture Enforcement
 * Validates ports/adapters pattern and prevents architectural violations
 */
module.exports = {
  forbidden: [
    // 🚨 ARCHITECTURE VIOLATION: Legacy imports forbidden
    {
      name: 'legacy-imports-forbidden',
      comment: 'Legacy code imports are forbidden from src/ - use ports/adapters pattern',
      from: {
        path: '^src',
      },
      to: {
        path: '^legacy',
      },
      severity: 'error',
    },
    
    // 🚨 ARCHITECTURE VIOLATION: Core ports cannot depend on adapters  
    {
      name: 'core-cannot-depend-on-adapters',
      comment: 'Core ports must remain pure interfaces - cannot import adapters',
      from: {
        path: '^src/core',
      },
      to: {
        path: '^src/adapters',
      },
      severity: 'error',
    },
    
    // 🚨 ARCHITECTURE VIOLATION: Core ports cannot depend on app layer
    {
      name: 'core-cannot-depend-on-app',
      comment: 'Core ports cannot depend on app layer - maintain clean architecture',
      from: {
        path: '^src/core',
      },
      to: {
        path: '^src/app',
      },
      severity: 'error',
    },
    
    // ⚠️ PATTERN VIOLATION: Only wiring.ts should import adapters directly
    {
      name: 'adapters-only-via-wiring',
      comment: 'Only src/app/wiring.ts should import adapters - use dependency injection elsewhere',
      from: {
        path: '^src',
        pathNot: '^src/app/wiring\\.ts$',
      },
      to: {
        path: '^src/adapters',
      },
      severity: 'warn',
    },
    
    // 📦 NODE_MODULES: Prevent direct node_modules access (use package imports)
    {
      name: 'no-unreachable-node-modules',
      comment: 'Import packages properly, not via node_modules paths',
      from: {},
      to: {
        path: 'node_modules',
        pathNot: 'node_modules/(@types)',
      },
      severity: 'error',
    },
  ],
  
  options: {
    // TypeScript path mapping support
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: './tsconfig.json',
    },
    
    // Enhanced progress reporting
    progress: {
      type: 'cli-feedback',
      maximumLevel: 60,
    },
    
    // Include all TypeScript and JavaScript files
    includeOnly: '^(src|legacy)',
    
    // Exclude test files and build artifacts
    exclude: {
      path: '(\\.(test|spec)\\.(ts|js)|dist/|node_modules/)',
    },
    
    // Report configuration
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)',
        theme: {
          graph: {
            bgcolor: 'transparent',
            splines: 'ortho',
          },
          modules: [
            {
              criteria: { source: '^src/core' },
              attributes: { fillcolor: 'lightblue', style: 'filled' },
            },
            {
              criteria: { source: '^src/adapters' },
              attributes: { fillcolor: 'lightgreen', style: 'filled' },
            },
            {
              criteria: { source: '^src/app' },
              attributes: { fillcolor: 'lightyellow', style: 'filled' },
            },
            {
              criteria: { source: '^legacy' },
              attributes: { fillcolor: 'lightcoral', style: 'filled,dashed' },
            },
          ],
        },
      },
    },
  },
};