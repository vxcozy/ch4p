import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // ---------------------------------------------------------------------------
  // Global ignores — files that should never be linted.
  // ---------------------------------------------------------------------------
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.js',
      '**/*.d.ts',
    ],
  },

  // ---------------------------------------------------------------------------
  // Base ESLint recommended rules for all files.
  // ---------------------------------------------------------------------------
  eslint.configs.recommended,

  // ---------------------------------------------------------------------------
  // typescript-eslint recommended rules (non-type-checked variant — no
  // project-wide type information needed, keeps linting fast in a monorepo).
  // ---------------------------------------------------------------------------
  ...tseslint.configs.recommended,

  // ---------------------------------------------------------------------------
  // Project-specific overrides to match the existing codebase style.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // TypeScript compiler enforces unused vars/params via noUnusedLocals
      // and noUnusedParameters in tsconfig.json — no need to duplicate.
      '@typescript-eslint/no-unused-vars': 'off',

      // ~53 uses of `as any` / `: any` across the codebase, mostly in test
      // mocks and adapter FFI boundaries. Warn for visibility, fix over time.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Intentional empty catch blocks are a common pattern in ch4p for
      // best-effort cleanup and non-critical startup paths.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Legitimate @ts-expect-error uses for planned packages and dynamic
      // imports that can't be statically resolved.
      '@typescript-eslint/ban-ts-comment': 'off',

      // createRequire usage in worker-pool.ts and test helpers.
      '@typescript-eslint/no-require-imports': 'off',

      // Marker types and extensibility points use empty object types.
      '@typescript-eslint/no-empty-object-type': 'off',

      // ch4p is a CLI application — console is the primary UI surface.
      'no-console': 'off',

      // ANSI escape codes (\x1b) and null bytes (\x00) are used intentionally
      // in terminal UI code and binary message filtering.
      'no-control-regex': 'off',

      // Regex patterns in security modules use defensive escaping (e.g. \/)
      // that is technically unnecessary but safer to leave as-is.
      'no-useless-escape': 'warn',

      // Unicode combined/joined character sequences in the input validator
      // are intentional for security filtering.
      'no-misleading-character-class': 'warn',

      // Test mocks use `Function` type for broad callback signatures.
      '@typescript-eslint/no-unsafe-function-type': 'warn',

      // Test mock generators may not yield (they return canned results).
      'require-yield': 'off',
    },
  },
);
