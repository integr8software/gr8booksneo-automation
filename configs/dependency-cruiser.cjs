/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'warn',
      comment: 'Circular dependencies can make modules difficult to maintain.',
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'Orphan modules may be unused, incorrectly referenced, or missing from an entry point.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)(main|index|bootstrap)\\.(ts|tsx|js|jsx)$',
          '(^|/)migration(s)?/',
          '(^|/)prisma/',
          '(^|/)scripts?/',
          '(^|/)test(s)?/',
          '\\.(spec|test)\\.(ts|tsx|js|jsx)$',
        ],
      },
      to: {},
    },
    {
      name: 'no-deprecated-core',
      severity: 'warn',
      comment: 'Avoid deprecated Node.js core modules.',
      from: {},
      to: {
        dependencyTypes: ['core'],
        path: '^(punycode|domain|sys|constants)$',
      },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'warn',
      comment:
        'Production source code should not depend on packages declared only as devDependencies.',
      from: {
        path: '^src',
        pathNot: ['\\.(spec|test)\\.(ts|tsx|js|jsx)$'],
      },
      to: {
        dependencyTypes: ['npm-dev'],
      },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'warn',
      comment: 'The dependency could not be resolved.',
      from: {},
      to: {
        couldNotResolve: true,
      },
    },
    {
      name: 'no-duplicate-dependency-types',
      severity: 'warn',
      comment:
        'A package should not appear in more than one dependency category.',
      from: {},
      to: {
        moreThanOneDependencyType: true,
      },
    },
  ],

  options: {
    doNotFollow: {
      path: 'node_modules',
    },

    exclude: {
      path: [
        'node_modules',
        'dist',
        'coverage',
        'reports',
        '\\.next',
        'playwright-report',
        'test-results',
      ],
    },

    tsPreCompilationDeps: true,
    preserveSymlinks: false,

    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'require', 'node', 'default'],
      mainFields: ['types', 'typings', 'module', 'main'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },

    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/[^/]+',
      },
    },
  },
};