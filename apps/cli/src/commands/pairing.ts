/**
 * Pairing command — manage gateway pairing codes.
 *
 * Pairing is the security mechanism that ensures only authorized
 * clients can connect to the ch4p gateway. Based on the one-time
 * pairing code pattern.
 *
 * Subcommands:
 *   ch4p pairing generate   — Generate a new pairing code
 *   ch4p pairing list       — List active codes and paired clients
 *   ch4p pairing revoke <c> — Revoke a pairing code or client
 *   ch4p pairing status     — Show pairing configuration status
 *
 * Note: These commands manage a local PairingManager instance for
 * quick code generation. In production, pairing is managed by the
 * running gateway server via the POST /pair endpoint.
 */

import { loadConfig } from '../config.js';
import { PairingManager } from '@ch4p/gateway';

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

// ---------------------------------------------------------------------------
// Shared pairing manager instance (local, for CLI-only operations)
// ---------------------------------------------------------------------------

let manager: PairingManager | null = null;

function getManager(): PairingManager {
  if (!manager) {
    manager = new PairingManager();
  }
  return manager;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function handleGenerate(args: string[]): void {
  const label = args[0] ?? 'CLI';
  const pm = getManager();

  try {
    const code = pm.generateCode(label);
    console.log(`  ${GREEN}${BOLD}Pairing code generated${RESET}\n`);
    console.log(`  ${BOLD}Code${RESET}      ${CYAN}${BOLD}${code.code}${RESET}`);
    console.log(`  ${BOLD}Label${RESET}     ${code.label ?? DIM + 'none' + RESET}`);
    console.log(`  ${BOLD}Expires${RESET}   ${code.expiresAt.toLocaleTimeString()}`);
    console.log('');
    console.log(`  ${DIM}Share this code with the client. It can only be used once.${RESET}`);
    console.log(`  ${DIM}Exchange via: POST /pair { "code": "${code.code}" }${RESET}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  ${RED}Failed to generate code:${RESET} ${message}`);
  }
}

function handleList(): void {
  const pm = getManager();
  const codes = pm.listCodes();
  const clients = pm.listClients();
  const stats = pm.stats();

  console.log(`  ${BOLD}Active Codes${RESET} ${DIM}(${stats.activeCodes})${RESET}`);
  if (codes.length === 0) {
    console.log(`  ${DIM}No active pairing codes.${RESET}`);
  } else {
    for (const code of codes) {
      const remaining = Math.max(0, Math.ceil((code.expiresAt.getTime() - Date.now()) / 1000));
      console.log(
        `  ${CYAN}${code.code}${RESET}  ${DIM}label=${code.label ?? 'none'}  ` +
        `expires in ${remaining}s${RESET}`,
      );
    }
  }

  console.log('');
  console.log(`  ${BOLD}Paired Clients${RESET} ${DIM}(${stats.pairedClients})${RESET}`);
  if (clients.length === 0) {
    console.log(`  ${DIM}No paired clients.${RESET}`);
  } else {
    for (const client of clients) {
      console.log(
        `  ${GREEN}${client.tokenPreview}${RESET}  ${DIM}label=${client.label ?? 'none'}  ` +
        `paired=${client.pairedAt.toLocaleTimeString()}  ` +
        `seen=${client.lastSeenAt.toLocaleTimeString()}${RESET}`,
      );
    }
  }
}

function handleRevoke(args: string[]): void {
  const target = args[0];
  if (!target) {
    console.log(`  ${RED}Usage:${RESET} ch4p pairing revoke <code-or-token-hash>`);
    console.log(`  ${DIM}Use 'ch4p pairing list' to see active codes and clients.${RESET}`);
    process.exitCode = 1;
    return;
  }

  const pm = getManager();

  // Try revoking as a code first, then as a client token hash.
  if (pm.revokeCode(target)) {
    console.log(`  ${GREEN}Revoked pairing code:${RESET} ${target}`);
    return;
  }

  if (pm.revokeClient(target)) {
    console.log(`  ${GREEN}Revoked paired client:${RESET} ${target.slice(0, 16)}...`);
    return;
  }

  console.log(`  ${YELLOW}Not found:${RESET} ${target}`);
  console.log(`  ${DIM}No active code or client matched. Use 'ch4p pairing list' to see current state.${RESET}`);
}

function handleStatus(requirePairing: boolean, port: number): void {
  const pm = getManager();
  const stats = pm.stats();

  console.log(`  ${BOLD}Configuration${RESET}`);
  console.log(`  ${BOLD}  Pairing required${RESET}  ${requirePairing ? `${GREEN}yes${RESET}` : `${YELLOW}no${RESET}`}`);
  console.log(`  ${BOLD}  Gateway port${RESET}      ${port}`);
  console.log('');
  console.log(`  ${BOLD}Local State${RESET}`);
  console.log(`  ${BOLD}  Active codes${RESET}      ${stats.activeCodes}`);
  console.log(`  ${BOLD}  Paired clients${RESET}    ${stats.pairedClients}`);
  console.log('');
  console.log(`  ${DIM}Subcommands: generate [label], list, revoke <target>, status${RESET}`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function pairing(args: string[]): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${RED}Failed to load config:${RESET} ${message}`);
    console.error(`  ${DIM}Run ${CYAN}ch4p onboard${DIM} to set up ch4p.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  const subcommand = args[0] ?? 'status';
  const subArgs = args.slice(1);

  console.log(`\n  ${CYAN}${BOLD}ch4p Pairing${RESET}`);
  console.log(`  ${DIM}${'='.repeat(50)}${RESET}\n`);

  switch (subcommand) {
    case 'generate':
      handleGenerate(subArgs);
      break;

    case 'list':
      handleList();
      break;

    case 'revoke':
      handleRevoke(subArgs);
      break;

    case 'status':
      handleStatus(config.gateway.requirePairing, config.gateway.port);
      break;

    default:
      console.log(`  ${RED}Unknown subcommand: ${subcommand}${RESET}`);
      console.log(`  ${DIM}Available: generate, list, revoke, status${RESET}`);
      process.exitCode = 1;
  }

  console.log('');
}
