#!/usr/bin/env bun

/**
 * build.ts — Single-file binary builder for ch4p CLI
 *
 * Uses `bun build --compile` to produce a standalone executable that
 * embeds the Bun runtime. No Node.js required to run the output.
 *
 * Usage:
 *   bun run build.ts                  # Build for current platform
 *   bun run build.ts --target linux   # Cross-compile for linux-x64
 *
 * Output: dist-bundle/ch4p (executable binary)
 */

import { $ } from 'bun';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, 'dist-bundle');

// Read version from package.json
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

// Parse --target flag (optional cross-compilation)
const targetArg = process.argv.find((a) => a.startsWith('--target='))?.split('=')[1]
  ?? (process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : undefined);

// Map short target names to bun target triples
const TARGET_MAP: Record<string, string> = {
  'linux': 'bun-linux-x64',
  'linux-arm': 'bun-linux-arm64',
  'mac': 'bun-darwin-arm64',
  'mac-x64': 'bun-darwin-x64',
  'windows': 'bun-windows-x64',
};

const target = targetArg ? (TARGET_MAP[targetArg] ?? targetArg) : undefined;

console.log(`\x1b[36m⚡\x1b[0m Building ch4p v${pkg.version} single-file binary...`);
if (target) {
  console.log(`\x1b[36m⚡\x1b[0m Target: ${target}`);
}

// Define version at compile time so the binary doesn't need package.json
const define: Record<string, string> = {
  'CH4P_VERSION': JSON.stringify(pkg.version),
};

const args = [
  'bun', 'build',
  '--compile',
  resolve(__dirname, 'src/index.ts'),
  '--outfile', resolve(outDir, 'ch4p'),
  '--external', 'better-sqlite3',
  ...(target ? ['--target', target] : []),
  ...Object.entries(define).flatMap(([k, v]) => [`--define`, `${k}=${v}`]),
];

console.log(`\x1b[2m$ ${args.join(' ')}\x1b[0m\n`);

const proc = Bun.spawn(args, {
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env },
});

const exitCode = await proc.exited;

if (exitCode === 0) {
  // Show output size
  const stat = Bun.file(resolve(outDir, 'ch4p'));
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
  console.log(`\n\x1b[32m✓\x1b[0m Built: dist-bundle/ch4p (${sizeMB} MB)`);
  console.log(`\x1b[2m  Run: ./apps/cli/dist-bundle/ch4p --help\x1b[0m`);
} else {
  console.error(`\n\x1b[31m✗\x1b[0m Build failed with exit code ${exitCode}`);
  process.exit(exitCode);
}
