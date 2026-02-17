/**
 * Canvas command — start the ch4p interactive canvas workspace.
 *
 * Starts a gateway server with WebSocket support, serves the built
 * web UI as static files, creates a default canvas session, and
 * optionally opens the browser.
 *
 * Usage:
 *   ch4p canvas              — start canvas and open browser
 *   ch4p canvas --port N     — override the configured port
 *   ch4p canvas --no-open    — don't auto-open browser
 */

import type { Ch4pConfig, ISecurityPolicy, InboundMessage } from '@ch4p/core';
import { generateId } from '@ch4p/core';
import { loadConfig, getLogsDir } from '../config.js';
import { SessionManager, GatewayServer, PairingManager, CanvasSessionManager, type WebSocketBridge } from '@ch4p/gateway';
import { CanvasTool, CanvasChannel, type CanvasToolContext } from '@ch4p/canvas';
import { Session, AgentLoop } from '@ch4p/agent';
import { NativeEngine } from '@ch4p/engines';
import { ProviderRegistry } from '@ch4p/providers';
import { ToolRegistry, LoadSkillTool } from '@ch4p/tools';
import { SkillRegistry } from '@ch4p/skills';
import { createObserver } from '@ch4p/observability';
import type { ObservabilityConfig } from '@ch4p/observability';
import { createMemoryBackend } from '@ch4p/memory';
import type { MemoryConfig } from '@ch4p/memory';
import { DefaultSecurityPolicy } from '@ch4p/security';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

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

export async function canvas(args: string[]): Promise<void> {
  let config: Ch4pConfig;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${RED}Failed to load config:${RESET} ${message}`);
    console.error(`  ${DIM}Run ${CYAN}ch4p onboard${DIM} to set up ch4p.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  // Parse arguments.
  let port = config.canvas?.port ?? config.gateway.port ?? 4800;
  let autoOpen = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      const parsed = parseInt(args[i + 1]!, 10);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
        port = parsed;
      }
    }
    if (args[i] === '--no-open') {
      autoOpen = false;
    }
  }

  const host = '127.0.0.1';

  // Find the built web UI directory.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const staticDir = resolve(__dirname, '..', '..', '..', 'apps', 'web', 'dist');

  // Create gateway components.
  const sessionManager = new SessionManager();
  const pairingManager = config.gateway.requirePairing ? new PairingManager() : undefined;
  const canvasSessionManager = new CanvasSessionManager(config.canvas?.maxComponents);

  // Create the engine.
  const engine = createCanvasEngine(config);
  if (!engine) {
    console.error(`\n  ${RED}No LLM engine available.${RESET}`);
    console.error(`  ${DIM}Ensure an API key is configured. Run ${CYAN}ch4p onboard${DIM}.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  // Create observer.
  const obsCfg: ObservabilityConfig = {
    observers: config.observability.observers ?? ['console'],
    logLevel: config.observability.logLevel ?? 'info',
    logPath: `${getLogsDir()}/canvas.jsonl`,
  };
  const observer = createObserver(obsCfg);

  // Create memory backend (optional).
  let memoryBackend;
  try {
    const memCfg: MemoryConfig = {
      backend: config.memory.backend,
      vectorWeight: config.memory.vectorWeight,
      keywordWeight: config.memory.keywordWeight,
      embeddingProvider: config.memory.embeddingProvider,
    };
    memoryBackend = createMemoryBackend(memCfg);
  } catch {
    // Not critical.
  }

  // Create skill registry (optional).
  let skillRegistry: SkillRegistry | undefined;
  try {
    if (config.skills?.enabled && config.skills?.paths?.length) {
      skillRegistry = SkillRegistry.createFromPaths(config.skills.paths);
    }
  } catch {
    // Not critical.
  }

  // Default session ID.
  const sessionId = generateId(16);

  const defaultSessionConfig = {
    engineId: config.engines?.default ?? 'native',
    model: config.agent.model,
    provider: config.agent.provider,
    systemPrompt:
      'You are ch4p, an AI assistant with an interactive canvas workspace. ' +
      'You can render visual components on the canvas using the canvas_render tool. ' +
      'Available component types: card, chart, form, button, text_field, data_table, ' +
      'code_block, markdown, image, progress, status. ' +
      'Components are placed at (x, y) positions on a spatial canvas. ' +
      'You can connect components with directional edges to show relationships. ' +
      'Use the canvas to create rich, visual responses when appropriate.',
  };

  // Create the gateway server with canvas support.
  const server = new GatewayServer({
    port,
    host,
    sessionManager,
    pairingManager,
    canvasSessionManager,
    staticDir,
    defaultSessionConfig,
    onCanvasConnection: (connSessionId: string, bridge: WebSocketBridge) => {
      wireCanvasSession(
        connSessionId, bridge, canvasSessionManager, engine, config,
        observer, memoryBackend, skillRegistry, defaultSessionConfig,
      );
    },
  });

  // Print startup banner.
  console.log(`\n  ${CYAN}${BOLD}ch4p Canvas${RESET}`);
  console.log(`  ${DIM}${'='.repeat(50)}${RESET}\n`);

  try {
    await server.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ${RED}Failed to start server:${RESET} ${message}`);
    process.exitCode = 1;
    return;
  }

  const addr = server.getAddress();
  const bindDisplay = addr ? `${addr.host}:${addr.port}` : `${host}:${port}`;
  const url = `http://${bindDisplay}/?session=${sessionId}`;

  console.log(`  ${GREEN}${BOLD}Server listening${RESET} on ${bindDisplay}`);
  console.log(`  ${BOLD}Session${RESET}       ${sessionId}`);
  console.log(`  ${BOLD}Engine${RESET}        ${engine.name}`);
  console.log(`  ${BOLD}Static dir${RESET}    ${DIM}${staticDir}${RESET}`);
  console.log('');
  console.log(`  ${BOLD}Routes:${RESET}`);
  console.log(`  ${DIM}  WS     /ws/:sessionId       - WebSocket canvas connection${RESET}`);
  console.log(`  ${DIM}  GET    /health               - liveness probe${RESET}`);
  console.log(`  ${DIM}  GET    /*                    - static files (web UI)${RESET}`);
  console.log('');

  if (pairingManager) {
    const code = pairingManager.generateCode('Canvas startup');
    console.log(`  ${BOLD}Pairing code:${RESET} ${CYAN}${BOLD}${code.code}${RESET}`);
    console.log(`  ${DIM}Add ?token=YOUR_TOKEN to the URL after pairing.${RESET}`);
    console.log('');
  }

  console.log(`  ${GREEN}${BOLD}Canvas URL:${RESET} ${CYAN}${url}${RESET}`);
  console.log('');

  // Auto-open browser.
  if (autoOpen) {
    try {
      const platform = process.platform;
      const openCmd = platform === 'darwin'
        ? 'open'
        : platform === 'win32'
          ? 'start'
          : 'xdg-open';
      execSync(`${openCmd} "${url}"`, { stdio: 'ignore' });
      console.log(`  ${DIM}Browser opened.${RESET}`);
    } catch {
      console.log(`  ${DIM}Couldn't auto-open browser. Open the URL above manually.${RESET}`);
    }
  }

  console.log(`  ${DIM}Press Ctrl+C to stop.${RESET}\n`);

  // Keep the process alive.
  await new Promise<void>((resolvePromise) => {
    const shutdown = async () => {
      console.log(`\n  ${DIM}Shutting down canvas...${RESET}`);
      canvasSessionManager.endAll();
      await server.stop();
      await observer.flush?.();
      console.log(`  ${DIM}Goodbye!${RESET}\n`);
      resolvePromise();
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });
}

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

function createCanvasEngine(config: Ch4pConfig) {
  const providerName = config.agent.provider;
  const providerConfig = config.providers?.[providerName] as Record<string, unknown> | undefined;
  const apiKey = providerConfig?.apiKey as string | undefined;

  if (providerName !== 'ollama' && (!apiKey || apiKey.trim().length === 0)) {
    return null;
  }

  try {
    const provider = ProviderRegistry.createProvider({
      id: providerName,
      type: providerName,
      ...providerConfig,
    });
    return new NativeEngine({ provider, defaultModel: config.agent.model });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Canvas session wiring
// ---------------------------------------------------------------------------

/**
 * Wire a newly connected canvas WebSocket session:
 *   - Create CanvasChannel + CanvasTool
 *   - Start CanvasChannel, set up message handler
 *   - On inbound messages, run AgentLoop and bridge events to WS
 */
function wireCanvasSession(
  sessionId: string,
  bridge: WebSocketBridge,
  canvasSessionManager: CanvasSessionManager,
  engine: NativeEngine,
  config: Ch4pConfig,
  observer: ReturnType<typeof createObserver>,
  memoryBackend?: ReturnType<typeof createMemoryBackend>,
  skillRegistry?: SkillRegistry,
  defaultSessionConfig?: Record<string, unknown>,
): void {
  const entry = canvasSessionManager.getSession(sessionId);
  if (!entry) return;

  const { canvasState, canvasChannel } = entry;

  // Start the canvas channel.
  canvasChannel.start({ sessionId }).catch(() => {});

  // Set up inbound message handler: when user sends a message, run the agent loop.
  canvasChannel.onMessage((msg: InboundMessage) => {
    void (async () => {
      try {
        // Handle abort
        if (msg.text.startsWith('[ABORT]')) {
          // Abort handling is done at the loop level
          return;
        }

        const session = new (await import('@ch4p/agent')).Session({
          sessionId,
          ...defaultSessionConfig,
        });

        // Create tool registry with the CanvasTool.
        const tools = ToolRegistry.createDefault({
          exclude: config.autonomy.level === 'readonly'
            ? ['bash', 'file_write', 'file_edit', 'delegate']
            : ['delegate'],
        });
        tools.register(new CanvasTool());

        // Register load_skill tool when skills are available.
        if (skillRegistry && skillRegistry.size > 0) {
          tools.register(new LoadSkillTool(skillRegistry));
        }

        const securityPolicy = new DefaultSecurityPolicy({
          workspace: process.cwd(),
          autonomyLevel: config.autonomy.level,
          allowedCommands: config.autonomy.allowedCommands,
          blockedPaths: config.security.blockedPaths,
        });

        // Inject canvasState (and search config when available) into the tool context.
        const toolContextExtensions: Record<string, unknown> = {
          canvasState,
        };
        if (config.search?.enabled && config.search.apiKey) {
          toolContextExtensions.searchApiKey = config.search.apiKey;
          toolContextExtensions.searchConfig = {
            maxResults: config.search.maxResults,
            country: config.search.country,
            searchLang: config.search.searchLang,
          };
        }

        const loop = new AgentLoop(session, engine, tools.list(), observer, {
          maxIterations: 30,
          maxRetries: 2,
          enableStateSnapshots: true,
          memoryBackend,
          securityPolicy,
          toolContextExtensions,
        });

        // Run the agent loop and bridge events to the WebSocket.
        for await (const event of loop.run(msg.text)) {
          bridge.handleAgentEvent(event);
        }
      } catch (err) {
        bridge.handleAgentEvent({
          type: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })();
  });
}
