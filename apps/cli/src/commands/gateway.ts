/**
 * Gateway command — start the ch4p gateway server.
 *
 * The gateway is the central HTTP server that channels, web clients,
 * and native apps connect to. It provides:
 *   - REST API for session management
 *   - Pairing code authentication
 *   - Session steering (live message injection)
 *
 * Usage:
 *   ch4p gateway          — start the gateway server
 *   ch4p gateway --port N — override the configured port
 */

import { loadConfig } from '../config.js';
import { SessionManager, GatewayServer, PairingManager } from '@ch4p/gateway';

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
// CLI entry point
// ---------------------------------------------------------------------------

export async function gateway(args: string[]): Promise<void> {
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

  // Parse --port override.
  let port = config.gateway.port;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      const parsed = parseInt(args[i + 1]!, 10);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
        port = parsed;
      }
    }
  }

  const host = config.gateway.allowPublicBind ? '0.0.0.0' : '127.0.0.1';
  const requirePairing = config.gateway.requirePairing;

  // Create gateway components.
  const sessionManager = new SessionManager();
  const pairingManager = requirePairing ? new PairingManager() : undefined;

  const server = new GatewayServer({
    port,
    host,
    sessionManager,
    pairingManager,
    defaultSessionConfig: {
      engineId: config.engines?.default ?? 'native',
      model: config.agent.model,
      provider: config.agent.provider,
      systemPrompt:
        'You are ch4p, a personal AI assistant. ' +
        'You are helpful, concise, and security-conscious.',
    },
  });

  // Print startup banner.
  console.log(`\n  ${CYAN}${BOLD}ch4p Gateway${RESET}`);
  console.log(`  ${DIM}${'='.repeat(50)}${RESET}\n`);

  try {
    await server.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ${RED}Failed to start gateway:${RESET} ${message}`);
    process.exitCode = 1;
    return;
  }

  const addr = server.getAddress();
  const bindDisplay = addr ? `${addr.host}:${addr.port}` : `${host}:${port}`;

  console.log(`  ${GREEN}${BOLD}Server listening${RESET} on ${bindDisplay}`);
  console.log(`  ${BOLD}Pairing${RESET}       ${requirePairing ? `${GREEN}required${RESET}` : `${YELLOW}disabled${RESET}`}`);
  console.log(`  ${BOLD}Tunnel${RESET}        ${config.tunnel.provider === 'none' ? `${DIM}disabled${RESET}` : config.tunnel.provider}`);
  console.log('');
  console.log(`  ${DIM}Routes:${RESET}`);
  console.log(`  ${DIM}  GET    /health              - liveness probe${RESET}`);
  console.log(`  ${DIM}  POST   /pair                - exchange pairing code for token${RESET}`);
  console.log(`  ${DIM}  GET    /sessions            - list active sessions${RESET}`);
  console.log(`  ${DIM}  POST   /sessions            - create a new session${RESET}`);
  console.log(`  ${DIM}  GET    /sessions/:id        - get session details${RESET}`);
  console.log(`  ${DIM}  POST   /sessions/:id/steer  - inject message into session${RESET}`);
  console.log(`  ${DIM}  DELETE /sessions/:id        - end a session${RESET}`);
  console.log('');

  if (requirePairing && pairingManager) {
    const code = pairingManager.generateCode('CLI startup');
    console.log(`  ${BOLD}Initial pairing code:${RESET} ${CYAN}${BOLD}${code.code}${RESET}`);
    console.log(`  ${DIM}Expires in 5 minutes. Use POST /pair to exchange for a token.${RESET}`);
    console.log('');
  }

  console.log(`  ${DIM}Press Ctrl+C to stop.${RESET}\n`);

  // Keep the process alive until interrupted.
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      console.log(`\n  ${DIM}Shutting down gateway...${RESET}`);
      await server.stop();
      console.log(`  ${DIM}Goodbye!${RESET}\n`);
      resolve();
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });
}
