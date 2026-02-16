/**
 * Tools command -- list all registered tools with metadata.
 *
 * Dynamically loads the actual tool registry from @ch4p/tools
 * and displays each tool's name, description, and weight classification.
 */

import { ToolRegistry } from '@ch4p/tools';

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function weightLabel(weight: 'lightweight' | 'heavyweight'): string {
  return weight === 'lightweight'
    ? `${GREEN}lightweight${RESET}`
    : `${YELLOW}heavyweight${RESET}`;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function tools(): Promise<void> {
  const registry = ToolRegistry.createDefault();
  const allTools = registry.list();

  console.log(`\n  ${CYAN}${BOLD}ch4p Tools${RESET}`);
  console.log(`  ${DIM}${'='.repeat(50)}${RESET}\n`);

  // Find the longest tool name for alignment.
  const maxNameLen = Math.max(...allTools.map((t) => t.name.length));

  for (const tool of allTools) {
    const paddedName = tool.name.padEnd(maxNameLen + 2, ' ');
    console.log(
      `  ${MAGENTA}${BOLD}${paddedName}${RESET}` +
      `${tool.description}`,
    );
    console.log(
      `  ${''.padEnd(maxNameLen + 2, ' ')}` +
      `${DIM}weight: ${RESET}${weightLabel(tool.weight)}`,
    );
  }

  const lwCount = allTools.filter((t) => t.weight === 'lightweight').length;
  const hwCount = allTools.filter((t) => t.weight === 'heavyweight').length;

  console.log(`\n  ${DIM}${'='.repeat(50)}${RESET}`);
  console.log(
    `  ${allTools.length} tools ` +
    `(${GREEN}${lwCount} lightweight${RESET}, ${YELLOW}${hwCount} heavyweight${RESET})`,
  );
  console.log(`  ${DIM}Lightweight tools run on the main thread.${RESET}`);
  console.log(`  ${DIM}Heavyweight tools run in worker threads for isolation.${RESET}\n`);
}
