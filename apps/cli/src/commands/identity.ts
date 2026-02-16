/**
 * Identity command — manage ERC-8004 on-chain agent identity.
 *
 * Subcommands:
 *   ch4p identity              — show identity status (default)
 *   ch4p identity status       — show identity status
 *   ch4p identity register     — register a new agent on-chain
 *
 * Requires the identity section in ~/.ch4p/config.json to be enabled.
 * Read-only operations (status) work without a private key.
 * Write operations (register) require a configured private key and RPC URL.
 */

import type { Ch4pConfig } from '@ch4p/core';
import { loadConfig } from '../config.js';

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
// Known chain names
// ---------------------------------------------------------------------------

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum Mainnet',
  8453: 'Base',
  42161: 'Arbitrum One',
  10: 'Optimism',
  11155111: 'Sepolia',
  84532: 'Base Sepolia',
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function identity(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status';

  switch (subcommand) {
    case 'status':
      await identityStatus();
      break;
    case 'register':
      await identityRegister();
      break;
    default:
      console.error(`\n  ${RED}Unknown identity subcommand:${RESET} ${subcommand}`);
      console.error(`  ${DIM}Available: status, register${RESET}\n`);
      process.exitCode = 1;
      break;
  }
}

// ---------------------------------------------------------------------------
// identity status
// ---------------------------------------------------------------------------

async function identityStatus(): Promise<void> {
  console.log(`\n  ${CYAN}${BOLD}ch4p Identity${RESET}`);
  console.log(`  ${DIM}${'='.repeat(50)}${RESET}\n`);

  let config: Ch4pConfig;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ${RED}Failed to load config:${RESET} ${message}`);
    console.error(`  ${DIM}Run ${CYAN}ch4p onboard${DIM} to set up ch4p.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  const idConfig = config.identity;

  if (!idConfig?.enabled) {
    console.log(`  ${BOLD}Status${RESET}           ${DIM}disabled${RESET}`);
    console.log('');
    console.log(`  ${DIM}To enable on-chain identity, add to ~/.ch4p/config.json:${RESET}`);
    console.log(`  ${DIM}{${RESET}`);
    console.log(`  ${DIM}  "identity": {${RESET}`);
    console.log(`  ${DIM}    "enabled": true,${RESET}`);
    console.log(`  ${DIM}    "provider": "erc8004",${RESET}`);
    console.log(`  ${DIM}    "rpcUrl": "https://mainnet.base.org"${RESET}`);
    console.log(`  ${DIM}  }${RESET}`);
    console.log(`  ${DIM}}${RESET}\n`);
    return;
  }

  const chainId = idConfig.chainId ?? 8453;
  const chainName = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
  const hasKey = !!(idConfig.privateKey && !idConfig.privateKey.includes('${'));
  const hasRpc = !!idConfig.rpcUrl;

  console.log(`  ${BOLD}Status${RESET}           ${GREEN}enabled${RESET}`);
  console.log(`  ${BOLD}Provider${RESET}         ${idConfig.provider}`);
  console.log(`  ${BOLD}Chain${RESET}            ${chainName} (${chainId})`);
  console.log(`  ${BOLD}RPC URL${RESET}          ${hasRpc ? idConfig.rpcUrl : `${YELLOW}not configured${RESET}`}`);
  console.log(`  ${BOLD}Private Key${RESET}      ${hasKey ? `${GREEN}configured${RESET}` : `${DIM}not set (read-only)${RESET}`}`);
  console.log(`  ${BOLD}Agent ID${RESET}         ${idConfig.agentId ?? `${DIM}not registered${RESET}`}`);

  // Feedback
  const feedbackMode = idConfig.feedbackMode ?? 'off';
  console.log(`  ${BOLD}Feedback${RESET}         ${feedbackMode}${feedbackMode === 'threshold' ? ` (>= ${idConfig.feedbackThreshold ?? 0.7})` : ''}`);

  // Trust
  const trust = idConfig.trust;
  if (trust) {
    console.log('');
    console.log(`  ${BOLD}Trust Configuration${RESET}`);
    console.log(`  ${BOLD}  Min Reputation${RESET}   ${trust.minReputation ?? 0}`);
    console.log(`  ${BOLD}  Min Validation${RESET}   ${trust.minValidation ?? 0}`);
    console.log(
      `  ${BOLD}  Trusted Clients${RESET}  ${trust.trustedClients?.length ?? 0} configured`,
    );
    console.log(
      `  ${BOLD}  Trusted Validators${RESET} ${trust.trustedValidators?.length ?? 0} configured`,
    );
  }

  // On-chain lookup (if plugin is available and agentId is set)
  if (idConfig.agentId && hasRpc) {
    console.log('');
    try {
      const { EthIdentityProvider } = await import('@ch4p/plugin-erc8004');
      const provider = new EthIdentityProvider({
        enabled: true,
        chainId,
        rpcUrl: idConfig.rpcUrl!,
        contracts: idConfig.contracts ?? {},
      });
      const onChainIdentity = await provider.getIdentity(idConfig.agentId);
      if (onChainIdentity) {
        console.log(`  ${BOLD}On-Chain Identity${RESET}`);
        console.log(`  ${BOLD}  Global ID${RESET}      ${onChainIdentity.globalId}`);
        console.log(`  ${BOLD}  Owner${RESET}          ${onChainIdentity.ownerAddress}`);
        if (onChainIdentity.agentWallet) {
          console.log(`  ${BOLD}  Agent Wallet${RESET}   ${onChainIdentity.agentWallet}`);
        }
        if (onChainIdentity.uri) {
          console.log(`  ${BOLD}  URI${RESET}            ${onChainIdentity.uri}`);
        }
      } else {
        console.log(`  ${YELLOW}Agent ID ${idConfig.agentId} not found on-chain.${RESET}`);
      }
    } catch {
      console.log(`  ${DIM}On-chain lookup unavailable (plugin not installed or RPC error).${RESET}`);
    }
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// identity register
// ---------------------------------------------------------------------------

async function identityRegister(): Promise<void> {
  console.log(`\n  ${CYAN}${BOLD}ch4p Identity — Register${RESET}`);
  console.log(`  ${DIM}${'='.repeat(50)}${RESET}\n`);

  let config: Ch4pConfig;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ${RED}Failed to load config:${RESET} ${message}`);
    process.exitCode = 1;
    return;
  }

  const idConfig = config.identity;

  if (!idConfig?.enabled) {
    console.error(`  ${RED}Identity is not enabled.${RESET}`);
    console.error(`  ${DIM}Enable it in ~/.ch4p/config.json first.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  if (!idConfig.rpcUrl) {
    console.error(`  ${RED}No RPC URL configured.${RESET}`);
    console.error(`  ${DIM}Set identity.rpcUrl in ~/.ch4p/config.json.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  if (!idConfig.privateKey || idConfig.privateKey.includes('${')) {
    console.error(`  ${RED}No private key configured.${RESET}`);
    console.error(`  ${DIM}Registration requires a private key for signing transactions.${RESET}`);
    console.error(`  ${DIM}Set identity.privateKey in ~/.ch4p/config.json.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  if (idConfig.agentId) {
    console.log(`  ${YELLOW}Agent already registered with ID: ${idConfig.agentId}${RESET}`);
    console.log(`  ${DIM}Run ${CYAN}ch4p identity status${DIM} to see details.${RESET}\n`);
    return;
  }

  const chainId = idConfig.chainId ?? 8453;
  const chainName = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;

  console.log(`  ${BOLD}Chain${RESET}    ${chainName} (${chainId})`);
  console.log(`  ${BOLD}RPC${RESET}      ${idConfig.rpcUrl}`);
  console.log('');
  console.log(`  ${DIM}Registering agent on-chain...${RESET}`);

  try {
    const { EthIdentityProvider } = await import('@ch4p/plugin-erc8004');
    const provider = new EthIdentityProvider({
      enabled: true,
      chainId,
      rpcUrl: idConfig.rpcUrl,
      contracts: idConfig.contracts ?? {},
      privateKey: idConfig.privateKey,
    });

    const identity = await provider.register();

    console.log('');
    console.log(`  ${GREEN}${BOLD}Agent registered successfully!${RESET}`);
    console.log('');
    console.log(`  ${BOLD}Agent ID${RESET}       ${identity.agentId}`);
    console.log(`  ${BOLD}Global ID${RESET}      ${identity.globalId}`);
    console.log(`  ${BOLD}Owner${RESET}          ${identity.ownerAddress}`);
    if (identity.uri) {
      console.log(`  ${BOLD}URI${RESET}            ${identity.uri}`);
    }
    console.log('');
    console.log(`  ${DIM}Next steps:${RESET}`);
    console.log(`  ${DIM}  1. Add ${CYAN}"agentId": "${identity.agentId}"${DIM} to identity config${RESET}`);
    console.log(`  ${DIM}  2. Run ${CYAN}ch4p gateway${DIM} to serve /.well-known/agent.json${RESET}`);
    console.log(`  ${DIM}  3. Run ${CYAN}ch4p identity status${DIM} to verify${RESET}`);
    console.log('');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${RED}Registration failed:${RESET} ${message}`);
    if (message.includes('insufficient funds')) {
      console.error(`  ${DIM}The wallet needs ETH/gas tokens on ${chainName} to pay for the transaction.${RESET}`);
    }
    console.error('');
    process.exitCode = 1;
  }
}
