#!/usr/bin/env node

/**
 * ch4p -- Personal AI Assistant
 *
 * Inspired by Chappie, the robot. A play on "chap" -- slang for friend.
 * Your AI companion with security-first defaults, BEAM-inspired concurrency,
 * and zero-dependency hybrid memory.
 *
 * Entry point: parses process.argv manually (zero external dependencies)
 * and dispatches to the appropriate command module.
 *
 * Commands:
 *   (default)   Interactive agent mode (REPL)
 *   agent       Interactive session or single-turn with -m
 *   gateway     Start the gateway server
 *   onboard     Run the setup wizard
 *   audit       Run security audit
 *   doctor      Run health checks
 *   status      Show system status
 *   tools       List available tools
 *   pairing     Manage gateway pairing
 *   message     Send a message via a channel
 *   help        Show usage
 *   version     Show version
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEAL, RESET, BOLD, DIM, GREEN, RED } from './ui.js';

// Compile-time constant injected by `bun build --compile --define CH4P_VERSION=...`.
// At runtime in normal Node.js builds this will be `undefined`.
declare const CH4P_VERSION: string | undefined;

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

function getVersion(): string {
  // When built with `bun build --compile`, CH4P_VERSION is baked in.
  try {
    if (typeof CH4P_VERSION === 'string') return CH4P_VERSION;
  } catch {
    // Not defined — fall through to filesystem lookup.
  }

  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Walk up from dist/ or src/ to find package.json.
    const paths = [
      resolve(__dirname, '..', 'package.json'),
      resolve(__dirname, '..', '..', 'package.json'),
    ];
    for (const p of paths) {
      try {
        const raw = readFileSync(p, 'utf8');
        const pkg = JSON.parse(raw) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // Try next path.
      }
    }
  } catch {
    // Fall through.
  }
  return '0.1.0';
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
  const version = getVersion();

  console.log(`
  ${TEAL}${BOLD}ch4p${RESET} ${DIM}v${version}${RESET} -- Personal AI Assistant

  ${BOLD}Usage${RESET}
    ${GREEN}ch4p${RESET}                            Interactive agent mode (REPL)
    ${GREEN}ch4p agent${RESET}                       Interactive agent mode (REPL)
    ${GREEN}ch4p agent -m "message"${RESET}          Single message mode
    ${GREEN}ch4p${RESET} ${DIM}<command> [options]${RESET}

  ${BOLD}Commands${RESET}
    ${GREEN}agent${RESET}        Start the agent (interactive or single message)
    ${GREEN}gateway${RESET}      Start the gateway server
    ${GREEN}onboard${RESET}      Run the setup wizard
    ${GREEN}audit${RESET}        Run a security audit
    ${GREEN}doctor${RESET}       Run health checks
    ${GREEN}status${RESET}       Show system status
    ${GREEN}tools${RESET}        List available tools
    ${GREEN}pairing${RESET}      Manage gateway pairing
    ${GREEN}message${RESET}      Send a message via a channel
    ${GREEN}skills${RESET}       Manage agent skills
    ${GREEN}canvas${RESET}       Start the interactive canvas workspace
    ${GREEN}identity${RESET}     Manage on-chain agent identity (ERC-8004)

  ${BOLD}Agent Options${RESET}
    ${GREEN}-m, --message${RESET} "text"      Run a single message and exit

  ${BOLD}Message Options${RESET}
    ${GREEN}-c, --channel${RESET} name        Target channel (telegram, discord, etc.)
    ${GREEN}-t, --thread${RESET}  id          Thread ID for threaded replies

  ${BOLD}Global Options${RESET}
    ${GREEN}--help, -h${RESET}               Show this help
    ${GREEN}--version, -V${RESET}            Show version

  ${BOLD}Examples${RESET}
    ${DIM}$${RESET} ch4p                                ${DIM}# Start interactive mode${RESET}
    ${DIM}$${RESET} ch4p agent -m "Summarize README.md"   ${DIM}# Single message${RESET}
    ${DIM}$${RESET} ch4p onboard                          ${DIM}# First-time setup${RESET}
    ${DIM}$${RESET} ch4p audit                            ${DIM}# Security audit${RESET}
    ${DIM}$${RESET} ch4p doctor                           ${DIM}# Health checks${RESET}
    ${DIM}$${RESET} ch4p status                           ${DIM}# System status${RESET}
    ${DIM}$${RESET} ch4p tools                            ${DIM}# List tools${RESET}
    ${DIM}$${RESET} ch4p canvas                           ${DIM}# Start canvas workspace${RESET}
    ${DIM}$${RESET} ch4p message -c telegram "Hello!"     ${DIM}# Send via channel${RESET}

  ${DIM}Run ${TEAL}ch4p onboard${DIM} to get started.${RESET}
`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { command: string; rest: string[] } {
  // argv[0] = node, argv[1] = script path, argv[2+] = user args.
  const args = argv.slice(2);

  // Handle global flags that can appear anywhere.
  if (args.includes('--help') || args.includes('-h')) {
    return { command: 'help', rest: [] };
  }
  if (args.includes('--version') || args.includes('-v') || args.includes('-V')) {
    return { command: 'version', rest: [] };
  }

  // No args = default to interactive agent mode.
  if (args.length === 0) {
    return { command: 'agent', rest: [] };
  }

  const command = args[0] ?? 'agent';
  const rest = args.slice(1);

  return { command, rest };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { command, rest } = parseArgs(process.argv);

  switch (command) {
    case 'agent': {
      const { agent } = await import('./commands/agent.js');
      await agent(rest);
      break;
    }

    case 'gateway': {
      const { gateway } = await import('./commands/gateway.js');
      await gateway(rest);
      break;
    }

    case 'onboard': {
      const { onboard } = await import('./commands/onboard.js');
      await onboard();
      break;
    }

    case 'audit': {
      const { audit } = await import('./commands/audit.js');
      await audit();
      break;
    }

    case 'doctor': {
      const { doctor } = await import('./commands/doctor.js');
      await doctor();
      break;
    }

    case 'status': {
      const { status } = await import('./commands/status.js');
      await status();
      break;
    }

    case 'tools': {
      const { tools } = await import('./commands/tools.js');
      await tools();
      break;
    }

    case 'pairing': {
      const { pairing } = await import('./commands/pairing.js');
      await pairing(rest);
      break;
    }

    case 'message': {
      const { message } = await import('./commands/message.js');
      await message(rest);
      break;
    }

    case 'skills': {
      const { skills } = await import('./commands/skills.js');
      await skills(rest);
      break;
    }

    case 'canvas': {
      const { canvas } = await import('./commands/canvas.js');
      await canvas(rest);
      break;
    }

    case 'identity': {
      const { identity } = await import('./commands/identity.js');
      await identity(rest);
      break;
    }

    case 'version': {
      console.log(`ch4p v${getVersion()}`);
      break;
    }

    case 'help': {
      printHelp();
      break;
    }

    default: {
      console.error(`\n  ${RED}Unknown command:${RESET} ${command}`);
      console.error(`  ${DIM}Run ${TEAL}ch4p --help${DIM} for available commands.${RESET}\n`);
      process.exitCode = 1;
      break;
    }
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${RED}${BOLD}Fatal error:${RESET} ${message}`);
  if (err instanceof Error && err.stack) {
    const stackLines = err.stack.split('\n').slice(1).map((l) => `  ${l.trim()}`).join('\n');
    console.error(`${DIM}${stackLines}${RESET}`);
  }
  process.exitCode = 1;
});
