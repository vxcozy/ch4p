import { defineConfig } from 'vitest/config';
import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build resolve aliases so tests can import @ch4p/* packages directly
// from source (src/index.ts) without requiring a prior build step.
// This avoids MODULE_NOT_FOUND errors on clean checkouts where dist/
// does not yet exist.
const root = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(root, 'packages');
const alias: Record<string, string> = {};
for (const name of readdirSync(packagesDir)) {
  alias[`@ch4p/${name}`] = resolve(packagesDir, name, 'src', 'index.ts');
}

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/index.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
