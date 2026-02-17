/**
 * Tools command -- list all registered tools with metadata.
 *
 * Dynamically loads the actual tool registry from @ch4p/tools
 * and displays each tool's name, description, and weight classification.
 */

import { ToolRegistry } from '@ch4p/tools';
import { TEAL, RESET, BOLD, DIM, GREEN, YELLOW, MAGENTA, box, separator } from '../ui.js';

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

  console.log(`\n  ${TEAL}${BOLD}ch4p Tools${RESET}`);
  console.log(separator());
  console.log('');

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

  console.log(`\n${separator()}`);
  console.log(
    `  ${allTools.length} tools ` +
    `(${GREEN}${lwCount} lightweight${RESET}, ${YELLOW}${hwCount} heavyweight${RESET})`,
  );
  console.log(`  ${DIM}Lightweight tools run on the main thread.${RESET}`);
  console.log(`  ${DIM}Heavyweight tools run in worker threads for isolation.${RESET}\n`);
}
