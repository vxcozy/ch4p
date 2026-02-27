/**
 * Gateway command — start the ch4p gateway server.
 *
 * The gateway is the central HTTP server that channels, web clients,
 * and native apps connect to. It provides:
 *   - REST API for session management
 *   - Pairing code authentication
 *   - Session steering (live message injection)
 *   - Channel adapters (Telegram, Discord, Slack) for multi-surface messaging
 *   - Message routing from channels → AgentLoop → channel response
 *   - Optional tunnel for public exposure (Cloudflare, Tailscale, ngrok)
 *
 * Usage:
 *   ch4p gateway          — start the gateway server
 *   ch4p gateway --port N — override the configured port
 */

import { createRequire } from 'node:module';
import type { Ch4pConfig, IChannel, IMemoryBackend, InboundMessage, ITunnelProvider } from '@ch4p/core';
import { createX402Middleware, X402PayTool, createEIP712Signer, walletAddress } from '@ch4p/plugin-x402';
import type { X402Config } from '@ch4p/plugin-x402';
import { generateId } from '@ch4p/core';
import { loadConfig, saveConfig, getLogsDir, getCh4pDir } from '../config.js';
import { SessionNotes } from '../session-notes.js';
import { SessionManager, GatewayServer, MessageRouter, PairingManager, Scheduler, LogChannel } from '@ch4p/gateway';
import type { CronJob } from '@ch4p/gateway';
import {
  ChannelRegistry,
  TelegramChannel,
  DiscordChannel,
  SlackChannel,
  CliChannel,
  MatrixChannel,
  WhatsAppChannel,
  SignalChannel,
  IMessageChannel,
  TeamsChannel,
  ZaloChannel,
  ZaloPersonalChannel,
  BlueBubblesChannel,
  GoogleChatChannel,
  WebChatChannel,
  IrcChannel,
  MacOSChannel,
} from '@ch4p/channels';
import { createTunnelProvider } from '@ch4p/tunnels';
import { Session, AgentLoop, ContextManager, FormatVerifier, LLMVerifier, createAutoRecallHook, createAutoSummarizeHook, ToolWorkerPool } from '@ch4p/agent';
import { NativeEngine, createClaudeCliEngine, createCodexCliEngine } from '@ch4p/engines';
import { ProviderRegistry } from '@ch4p/providers';
import { ToolRegistry, LoadSkillTool } from '@ch4p/tools';
import { SkillRegistry } from '@ch4p/skills';
import { createObserver } from '@ch4p/observability';
import type { ObservabilityConfig } from '@ch4p/observability';
import { createMemoryBackend } from '@ch4p/memory';
import type { MemoryConfig } from '@ch4p/memory';
import { DefaultSecurityPolicy } from '@ch4p/security';
import { Supervisor } from '@ch4p/supervisor';
import type { ChildHandle } from '@ch4p/supervisor';
import { VoiceProcessor, WhisperSTT, DeepgramSTT, ElevenLabsTTS } from '@ch4p/voice';
import type { VoiceConfig } from '@ch4p/voice';
import { TEAL, RESET, BOLD, DIM, GREEN, YELLOW, RED, box, kvRow } from '../ui.js';
import { buildSystemPrompt } from '../system-prompt.js';
import { AgentRouter } from '../agent-router.js';

// ---------------------------------------------------------------------------
// Channel factory
// ---------------------------------------------------------------------------

/**
 * Create a channel adapter instance by name.
 */
function createChannelInstance(channelName: string): IChannel | null {
  switch (channelName) {
    case 'telegram':
      return new TelegramChannel();
    case 'discord':
      return new DiscordChannel();
    case 'slack':
      return new SlackChannel();
    case 'cli':
      return new CliChannel();
    case 'matrix':
      return new MatrixChannel();
    case 'whatsapp':
      return new WhatsAppChannel();
    case 'signal':
      return new SignalChannel();
    case 'imessage':
      return new IMessageChannel();
    case 'teams':
      return new TeamsChannel();
    case 'zalo':
      return new ZaloChannel();
    case 'zalo-personal':
      return new ZaloPersonalChannel();
    case 'bluebubbles':
      return new BlueBubblesChannel();
    case 'googlechat':
      return new GoogleChatChannel();
    case 'webchat':
      return new WebChatChannel();
    case 'irc':
      return new IrcChannel();
    case 'macos':
      return new MacOSChannel();
    default:
      return null;
  }
}

/**
 * Create the engine for gateway sessions.
 * Mirrors the logic in agent.ts but returns a shared engine for all sessions.
 */
function createGatewayEngine(config: Ch4pConfig) {
  const engineId = config.engines?.default ?? 'native';
  const engineConfig = config.engines?.available?.[engineId] as Record<string, unknown> | undefined;

  if (engineId === 'claude-cli') {
    try {
      return createClaudeCliEngine({
        command: (engineConfig?.command as string) ?? undefined,
        cwd: (engineConfig?.cwd as string) ?? undefined,
        timeout: (engineConfig?.timeout as number) ?? undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ${YELLOW}⚠ ${engineId} engine failed to initialize: ${msg}${RESET}`);
      console.warn(`  ${DIM}Falling back to native SDK engine.${RESET}`);
    }
  }

  if (engineId === 'codex-cli') {
    try {
      return createCodexCliEngine({
        command: (engineConfig?.command as string) ?? undefined,
        cwd: (engineConfig?.cwd as string) ?? undefined,
        timeout: (engineConfig?.timeout as number) ?? undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ${YELLOW}⚠ ${engineId} engine failed to initialize: ${msg}${RESET}`);
      console.warn(`  ${DIM}Falling back to native SDK engine.${RESET}`);
    }
  }

  // Native engine.
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
// Gateway constants — module scope so both gateway() and handleInboundMessage()
// can access them.
// ---------------------------------------------------------------------------

/** Hard cap on simultaneous conversation contexts to prevent OOM. LRU eviction. */
const MAX_CONTEXTS = 500;

/** Reduced token budget for gateway contexts (vs full 128K default). */
const GATEWAY_CONTEXT_MAX_TOKENS = 32_000;

/** Max depth of per-user pending message queue before older messages are replaced. */
const MAX_PENDING_PER_USER = 2;

// ---------------------------------------------------------------------------
// Settings panel helpers
// ---------------------------------------------------------------------------

/**
 * Returns a safe subset of Ch4pConfig for the settings panel.
 * API keys, private keys, provider credentials, and channel configs are
 * intentionally omitted — they are never returned or accepted via the API.
 */
export function buildSafeConfig(cfg: Ch4pConfig): Record<string, unknown> {
  return {
    agent: {
      model: cfg.agent.model,
      provider: cfg.agent.provider,
      thinkingLevel: cfg.agent.thinkingLevel,
    },
    gateway: { requirePairing: cfg.gateway.requirePairing },
    memory: { autoSave: cfg.memory.autoSave },
    autonomy: { level: cfg.autonomy.level },
    observability: { logLevel: cfg.observability.logLevel },
    skills: { enabled: cfg.skills.enabled },
    tunnel: { provider: cfg.tunnel.provider },
  };
}

/**
 * Applies a safe-field update to the current config.
 * Only the fields exposed by buildSafeConfig can be modified.
 * Returns a new config object (does not mutate the original).
 */
export function applySafeUpdates(current: Ch4pConfig, updates: Record<string, unknown>): Ch4pConfig {
  const result: Ch4pConfig = { ...current };
  if (updates.agent && typeof updates.agent === 'object') {
    const u = updates.agent as Record<string, unknown>;
    result.agent = {
      ...current.agent,
      ...(u.model !== undefined && { model: String(u.model) }),
      ...(u.provider !== undefined && { provider: String(u.provider) }),
      ...(u.thinkingLevel !== undefined && { thinkingLevel: u.thinkingLevel as 'low' | 'medium' | 'high' }),
    };
  }
  if (updates.gateway && typeof updates.gateway === 'object') {
    const u = updates.gateway as Record<string, unknown>;
    result.gateway = {
      ...current.gateway,
      ...(u.requirePairing !== undefined && { requirePairing: Boolean(u.requirePairing) }),
    };
  }
  if (updates.memory && typeof updates.memory === 'object') {
    const u = updates.memory as Record<string, unknown>;
    result.memory = {
      ...current.memory,
      ...(u.autoSave !== undefined && { autoSave: Boolean(u.autoSave) }),
    };
  }
  if (updates.autonomy && typeof updates.autonomy === 'object') {
    const u = updates.autonomy as Record<string, unknown>;
    result.autonomy = {
      ...current.autonomy,
      ...(u.level !== undefined && { level: u.level as 'readonly' | 'supervised' | 'full' }),
    };
  }
  if (updates.observability && typeof updates.observability === 'object') {
    const u = updates.observability as Record<string, unknown>;
    result.observability = {
      ...current.observability,
      ...(u.logLevel !== undefined && { logLevel: u.logLevel as 'debug' | 'info' | 'warn' | 'error' }),
    };
  }
  if (updates.skills && typeof updates.skills === 'object') {
    const u = updates.skills as Record<string, unknown>;
    result.skills = {
      ...current.skills,
      ...(u.enabled !== undefined && { enabled: Boolean(u.enabled) }),
    };
  }
  if (updates.tunnel && typeof updates.tunnel === 'object') {
    const u = updates.tunnel as Record<string, unknown>;
    result.tunnel = {
      ...current.tunnel,
      ...(u.provider !== undefined && { provider: String(u.provider) }),
    };
  }
  return result;
}

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
    console.error(`  ${DIM}Run ${TEAL}ch4p onboard${DIM} to set up ch4p.${RESET}\n`);
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

  // Create the engine for processing channel messages.
  const engine = createGatewayEngine(config);

  if (!engine) {
    const providerName = config.agent?.provider ?? 'unknown';
    console.error(`\n  ${RED}No engine available.${RESET} Provider "${providerName}" has no API key.`);
    console.error(`  ${DIM}Run ${TEAL}ch4p onboard${DIM} to configure a provider, or set the API key`);
    console.error(`  ${DIM}in ${TEAL}~/.ch4p/.env${DIM} as ${TEAL}${providerName.toUpperCase()}_API_KEY${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  // Create skill registry (optional) — needed before system prompt is built.
  let skillRegistry: SkillRegistry | undefined;
  try {
    if (config.skills?.enabled && config.skills?.paths?.length) {
      skillRegistry = SkillRegistry.createFromPaths(config.skills.paths);
    }
  } catch {
    // Skills not critical for gateway.
  }

  // Create memory backend (optional) — needed before system prompt is built.
  let memoryBackend: IMemoryBackend | undefined;
  try {
    const memCfg: MemoryConfig = {
      backend: config.memory.backend,
      vectorWeight: config.memory.vectorWeight,
      keywordWeight: config.memory.keywordWeight,
      embeddingProvider: config.memory.embeddingProvider,
      embeddingProviders: config.memory.embeddingProviders,
      embeddingDimensions: config.memory.embeddingDimensions ?? 768,
      openaiApiKey: (config.providers?.openai?.apiKey as string) || undefined,
      ollamaBaseUrl: config.memory.ollama?.baseUrl,
      ollamaEmbeddingModel: config.memory.ollama?.embeddingModel,
    };
    memoryBackend = createMemoryBackend(memCfg);
  } catch {
    // Memory not critical for gateway.
  }

  // Build the system prompt with accurate capability hints now that we know
  // which features are available.  The model must be told about memory and
  // web search here — without these hints it tells users it has no memory and
  // ignores tool capabilities entirely.
  const hasMemory = !!memoryBackend;
  const hasSearch = !!(config.search?.enabled && config.search.apiKey);
  const defaultSystemPrompt = buildSystemPrompt({ hasMemory, hasSearch, skillRegistry });

  const defaultSessionConfig = {
    engineId: config.engines?.default ?? 'native',
    model: config.agent.model,
    provider: config.agent.provider,
    systemPrompt: defaultSystemPrompt,
  };

  // Create the shared verifier once at startup — avoids creating a new
  // provider + verifier per inbound message (was 72K throwaway objects/hour).
  let sharedVerifier: FormatVerifier | LLMVerifier | undefined;
  const vCfg = config.verification;
  if (vCfg?.enabled) {
    const formatOpts = { maxToolErrorRatio: vCfg.maxToolErrorRatio ?? 0.5 };
    if (vCfg.semantic && engine) {
      try {
        const providerName = config.agent.provider;
        const providerConfig = config.providers?.[providerName] as Record<string, unknown> | undefined;
        const verifierProvider = ProviderRegistry.createProvider({
          id: `${providerName}-verifier`,
          type: providerName,
          ...providerConfig,
        });
        sharedVerifier = new LLMVerifier({ provider: verifierProvider, model: config.agent.model, formatOpts });
      } catch {
        sharedVerifier = new FormatVerifier(formatOpts);
      }
    } else {
      sharedVerifier = new FormatVerifier(formatOpts);
    }
  }

  // Create agent router — evaluates config.routing rules per inbound message.
  const agentRouter = new AgentRouter(config);

  // Warn early if routing rules reference agent names that aren't defined.
  // Without this, mis-spelled agent names silently fall back to default.
  if (agentRouter.hasRules()) {
    const agents = config.routing?.agents ?? {};
    const rules = config.routing?.rules ?? [];
    for (const rule of rules) {
      if (rule.agent && !agents[rule.agent]) {
        console.warn(
          `  ${YELLOW}⚠ Routing rule references undefined agent "${rule.agent}" — rule will be skipped.${RESET}`,
        );
      }
    }
  }

  // Build agent registration file for ERC-8004 service discovery.
  let agentRegistration: Record<string, unknown> | undefined;
  if (config.identity?.enabled) {
    agentRegistration = {
      type: 'AgentRegistrationFile',
      name: 'ch4p',
      description: 'ch4p personal AI assistant',
      image: '',
      services: [],
      active: true,
      ...(config.identity.agentId ? { agentId: config.identity.agentId } : {}),
      ...(config.identity.chainId ? { chainId: config.identity.chainId } : {}),
    };
  }

  // Create x402 middleware if configured.
  const x402Cfg = (config as unknown as Record<string, unknown>).x402 as X402Config | undefined;
  const x402Middleware = x402Cfg ? createX402Middleware(x402Cfg) : null;

  // Validate x402 client private key at startup — fail fast before bind.
  if (x402Cfg?.enabled && x402Cfg.client?.privateKey) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(x402Cfg.client.privateKey)) {
      console.error(`\n  ${RED}x402.client.privateKey is invalid:${RESET} expected a 0x-prefixed 64-character hex string.`);
      console.error(`  ${DIM}Set it via the X402_PRIVATE_KEY env var: ${TEAL}"privateKey": "\${X402_PRIVATE_KEY}"${RESET}\n`);
      process.exitCode = 1;
      return;
    }
  }

  // Create MessageRouter for channel → session routing.
  const messageRouter = new MessageRouter(sessionManager, defaultSessionConfig);

  // Create observer.
  const obsCfg: ObservabilityConfig = {
    observers: config.observability.observers ?? ['console'],
    logLevel: config.observability.logLevel ?? 'info',
    logPath: `${getLogsDir()}/gateway.jsonl`,
  };
  const observer = createObserver(obsCfg);

  // Create tool worker pool — provides process isolation for heavyweight tools
  // (web_fetch, browser). The pool is created once and shared across all sessions.
  // NOTE: x402Signer is not available in worker context (functions are not
  // serialisable across thread boundaries). If web_fetch hits a 402 in the worker,
  // it returns x402Required: true and the agent uses x402_pay manually.
  const _require = createRequire(import.meta.url);
  let workerPool: ToolWorkerPool | undefined;
  try {
    const workerScriptPath = _require.resolve('@ch4p/agent/worker');
    workerPool = new ToolWorkerPool({
      workerScript: workerScriptPath,
      maxWorkers: 4,
      taskTimeoutMs: 60_000,
    });
  } catch {
    // Worker script not built yet — heavyweight tools run inline.
    workerPool = undefined;
  }

  // Create voice processor (optional).
  let voiceProcessor: VoiceProcessor | undefined;
  const voiceCfg = config.voice;
  if (voiceCfg?.enabled) {
    try {
      const sttProvider = voiceCfg.stt.provider === 'deepgram'
        ? new DeepgramSTT({ apiKey: voiceCfg.stt.apiKey ?? '' })
        : new WhisperSTT({ apiKey: voiceCfg.stt.apiKey ?? '' });
      const ttsProvider = voiceCfg.tts.provider === 'elevenlabs'
        ? new ElevenLabsTTS({ apiKey: voiceCfg.tts.apiKey ?? '', voiceId: voiceCfg.tts.voiceId })
        : undefined;
      voiceProcessor = new VoiceProcessor({
        stt: sttProvider,
        tts: ttsProvider,
        config: voiceCfg as VoiceConfig,
      });
    } catch {
      // Voice not critical for gateway.
    }
  }

  // In-flight tracker for graceful drain on SIGTERM.
  // Incremented when an agent run starts, decremented when it finishes.
  let inFlightCount = 0;
  let drainResolve: (() => void) | null = null;

  function waitForDrain(timeoutMs = 30_000): Promise<void> {
    if (inFlightCount === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        drainResolve = null;
        console.log(`  ${YELLOW}⚠ Drain timeout after ${timeoutMs / 1000}s — ${inFlightCount} message(s) still in flight${RESET}`);
        resolve();
      }, timeoutMs);
      drainResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  function trackInflight(delta: 1 | -1): void {
    inFlightCount += delta;
    if (inFlightCount <= 0 && drainResolve) {
      inFlightCount = 0;
      const cb = drainResolve;
      drainResolve = null;
      cb();
    }
  }

  // Per-user conversation context so messages within the same channel+user
  // share history (like the REPL's sharedContext).
  // Each entry tracks lastActiveAt for idle eviction.
  // Hard cap prevents unbounded growth when many users are simultaneously active.
  const conversationContexts = new Map<string, { ctx: ContextManager; lastActiveAt: number }>();

  // Session notes — lightweight JSON files written before each agent run so the
  // gateway can resume in-flight work after a crash or OOM restart.
  // Files live at ~/.ch4p/sessions/{hash}.json; deleted on successful completion.
  const sessionNotes = new SessionNotes(getCh4pDir());

  // Track in-flight agent loops per user so permission-prompt replies from the
  // channel can be forwarded to the subprocess stdin instead of spawning a new loop.
  const inFlightLoops = new Map<string, { loop: AgentLoop; permissionPending: boolean }>();

  // Per-user pending message queue (max depth MAX_PENDING_PER_USER). When a user sends
  // follow-ups while an agent run is active, up to 2 messages are queued and processed
  // in order after the current run finishes. Messages beyond the cap replace the last entry.
  const pendingMessages = new Map<string, Array<{ msg: InboundMessage; channel: IChannel }>>();

  // Map of channel names to their raw webhook handlers (Teams, Google Chat).
  // Populated during channel startup; the server's onRawWebhook callback
  // routes to these when the webhook name matches a registered channel.
  const rawWebhookHandlers = new Map<string, (body: string) => void>();

  // Create LogChannel for cron/webhook responses (logs to observer).
  const logChannel = new LogChannel({
    onResponse: () => {
      // Cron/webhook responses are handled by the channel itself.
    },
  });

  const server = new GatewayServer({
    port,
    host,
    sessionManager,
    pairingManager,
    defaultSessionConfig,
    agentRegistration,
    preHandler: x402Middleware ?? undefined,
    onWebhook: (name, payload) => {
      const syntheticMsg: InboundMessage = {
        id: generateId(16),
        channelId: `webhook:${name}`,
        from: { channelId: `webhook:${name}`, userId: payload.userId ?? 'webhook' },
        text: payload.message,
        timestamp: new Date(),
      };
      handleInboundMessage({
        msg: syntheticMsg, channel: logChannel as unknown as IChannel, router: messageRouter,
        engine, config, observer, conversationContexts, agentRouter, defaultSystemPrompt,
        memoryBackend, skillRegistry, voiceProcessor, onInflightChange: trackInflight,
        workerPool, inFlightLoops, pendingMessages, sharedVerifier,
      });
    },
    onRawWebhook: (name, body) => {
      const handler = rawWebhookHandlers.get(name);
      if (!handler) return false;
      handler(body);
      return true;
    },
    onSteer: (sessionId, message) => {
      // Route steer messages to in-flight agent loops matching the session.
      for (const entry of inFlightLoops.values()) {
        if (entry.loop.getSessionId() === sessionId) {
          entry.loop.steerEngine(message);
          return;
        }
      }
    },
    onGetConfig: () => buildSafeConfig(config),
    onSaveConfig: async (updates) => {
      config = applySafeUpdates(config, updates);
      saveConfig(config);
    },
  });

  // Print startup banner.
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

  console.log('\n' + box('ch4p Gateway', [
    kvRow('Server', `${GREEN}${BOLD}listening${RESET} on ${bindDisplay}`),
    kvRow('Pairing', requirePairing ? `${GREEN}required${RESET}` : `${YELLOW}disabled${RESET}`),
    kvRow('Engine', engine ? engine.name : `${YELLOW}none (no API key)${RESET}`),
    kvRow('Memory', memoryBackend ? config.memory.backend : `${DIM}disabled${RESET}`),
    kvRow('Voice', voiceProcessor ? `${GREEN}enabled${RESET} (STT: ${voiceCfg?.stt.provider ?? '?'}, TTS: ${voiceCfg?.tts.provider ?? 'none'})` : `${DIM}disabled${RESET}`),
    kvRow('Workers', workerPool ? `${GREEN}enabled${RESET} ${DIM}(max 4 threads)${RESET}` : `${DIM}inline (worker script not built)${RESET}`),
    kvRow('Identity', agentRegistration ? `${GREEN}enabled${RESET} (chain ${config.identity?.chainId ?? 8453})` : `${DIM}disabled${RESET}`),
    kvRow('x402', x402Cfg?.enabled ? `${GREEN}enabled${RESET} ${DIM}(${x402Cfg.server?.network ?? 'base'})${RESET}` : `${DIM}disabled${RESET}`),
  ]));
  console.log('');
  console.log(`  ${DIM}Routes:${RESET}`);
  console.log(`  ${DIM}  GET    /health              - liveness probe${RESET}`);
  console.log(`  ${DIM}  GET    /ready               - readiness probe${RESET}`);
  if (agentRegistration) {
    console.log(`  ${DIM}  GET    /.well-known/agent.json - agent discovery${RESET}`);
  }
  console.log(`  ${DIM}  POST   /pair                - exchange pairing code for token${RESET}`);
  console.log(`  ${DIM}  GET    /sessions            - list active sessions${RESET}`);
  console.log(`  ${DIM}  POST   /sessions            - create a new session${RESET}`);
  console.log(`  ${DIM}  GET    /sessions/:id        - get session details${RESET}`);
  console.log(`  ${DIM}  POST   /sessions/:id/steer  - inject message into session${RESET}`);
  console.log(`  ${DIM}  DELETE /sessions/:id        - end a session${RESET}`);
  console.log('');

  // ----- Start channel adapters (supervised) -----
  const channelRegistry = new ChannelRegistry();
  const startedChannels: IChannel[] = [];
  const channelNames = Object.keys(config.channels);

  // Supervisor wraps channel lifecycles for automatic crash recovery.
  const channelSupervisor = new Supervisor({ strategy: 'one-for-one', maxRestarts: 5, windowMs: 60_000 });

  channelSupervisor.on('child:crashed', (childId, error) => {
    console.log(`  ${YELLOW}⚠ Channel ${childId} crashed:${RESET} ${error.message}`);
  });
  channelSupervisor.on('child:restarted', (childId, _handle, attempt) => {
    console.log(`  ${GREEN}✓${RESET} Channel ${childId} restarted ${DIM}(attempt ${attempt})${RESET}`);
  });
  channelSupervisor.on('supervisor:max_restarts_exceeded', (childId, count, windowMs) => {
    console.log(`  ${RED}✗${RESET} Channel ${childId} exceeded max restarts (${count} in ${Math.round(windowMs / 1000)}s)`);
  });

  if (channelNames.length > 0) {
    console.log(`  ${BOLD}Channels:${RESET}`);
    for (const channelName of channelNames) {
      const channelCfg = config.channels[channelName]!;
      const channel = createChannelInstance(channelName);
      if (!channel) {
        console.log(`    ${YELLOW}⚠ Unknown channel type: ${channelName}${RESET}`);
        continue;
      }

      // Retry initial channel connection up to 3 times with exponential backoff.
      // Transient network issues (DNS, TCP timeouts) shouldn't permanently
      // disable a channel — especially after an OOM-triggered restart.
      const MAX_START_RETRIES = 3;
      let started = false;
      for (let attempt = 1; attempt <= MAX_START_RETRIES; attempt++) {
        try {
          await channel.start(channelCfg);
          started = true;
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (attempt < MAX_START_RETRIES) {
            const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
            console.log(`    ${YELLOW}⚠${RESET} ${channelName}: ${errMsg} ${DIM}(retry ${attempt}/${MAX_START_RETRIES} in ${delayMs / 1000}s)${RESET}`);
            await new Promise((r) => setTimeout(r, delayMs));
          } else {
            console.log(`    ${RED}✗${RESET} ${channelName}: ${errMsg} ${DIM}(failed after ${MAX_START_RETRIES} attempts)${RESET}`);
          }
        }
      }

      if (!started) continue;

      channelRegistry.register(channel);
      startedChannels.push(channel);

      // Wire inbound messages: channel → voice → messageRouter → AgentLoop → channel.send()
      channel.onMessage((msg: InboundMessage) => {
        handleInboundMessage({
          msg, channel, router: messageRouter, engine, config, observer,
          conversationContexts, agentRouter, defaultSystemPrompt,
          memoryBackend, skillRegistry, voiceProcessor, onInflightChange: trackInflight,
          workerPool, inFlightLoops, pendingMessages, sharedVerifier, sessionNotes,
        });
      });

      // Register raw webhook handlers for channels that receive structured
      // webhook payloads (Teams Bot Framework activities, Google Chat events).
      if (channelName === 'teams' && 'handleIncomingActivity' in channel) {
        rawWebhookHandlers.set('teams', (body: string) => {
          try {
            const activity = JSON.parse(body);
            (channel as TeamsChannel).handleIncomingActivity(activity);
          } catch { /* malformed payload — silently drop */ }
        });
      }
      if (channelName === 'googlechat' && 'handleIncomingEvent' in channel) {
        rawWebhookHandlers.set('googlechat', (body: string) => {
          try {
            const event = JSON.parse(body);
            (channel as GoogleChatChannel).handleIncomingEvent(event);
          } catch { /* malformed payload — silently drop */ }
        });
      }

      // Register with supervisor for crash recovery. The channel is already
      // started, so start() is a no-op reconnect and shutdown() calls stop().
      let alive = true;
      try {
        await channelSupervisor.addChild({
          id: channelName,
          start: async () => {
            // On restart, re-start the channel with its original config.
            if (!alive) {
              await channel.start(channelCfg);
            }
            alive = true;
            return {
              id: channelName,
              kill: () => { alive = false; void channel.stop(); },
              isAlive: () => alive,
            } satisfies ChildHandle;
          },
          shutdown: async () => {
            alive = false;
            await channel.stop();
          },
        });
      } catch {
        // Supervisor registration is best-effort; channel still works without crash recovery.
      }

      console.log(`    ${GREEN}✓${RESET} ${channelName} ${DIM}(${channel.name})${RESET}`);
    }

    await channelSupervisor.start();
    console.log('');
  } else {
    console.log(`  ${DIM}No channels configured. Add channels to ~/.ch4p/config.json.${RESET}`);
    console.log('');
  }

  // ----- Start tunnel (optional) -----
  let tunnel: ITunnelProvider | null = null;
  const tunnelProvider = config.tunnel.provider;
  if (tunnelProvider && tunnelProvider !== 'none') {
    try {
      tunnel = createTunnelProvider(tunnelProvider);
      const tunnelCfg = {
        ...config.tunnel,
        port,
        localHost: host,
      };
      const tunnelInfo = await tunnel.start(tunnelCfg);
      server.setTunnelUrl(tunnelInfo.publicUrl);
      console.log(`  ${GREEN}${BOLD}Tunnel active${RESET} ${DIM}(${tunnelProvider})${RESET}`);
      console.log(`  ${BOLD}Public URL${RESET}    ${TEAL}${tunnelInfo.publicUrl}${RESET}`);
      console.log('');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`  ${YELLOW}⚠ Tunnel failed to start:${RESET} ${errMsg}`);
      console.log(`  ${DIM}Gateway is still accessible locally at ${bindDisplay}.${RESET}`);
      console.log('');
      tunnel = null;
    }
  } else {
    console.log(`  ${BOLD}Tunnel${RESET}        ${DIM}disabled${RESET}`);
    console.log('');
  }

  // ----- Start cron scheduler (optional) -----
  let scheduler: Scheduler | undefined;
  const schedulerCfg = (config as unknown as Record<string, unknown>).scheduler as Record<string, unknown> | undefined;
  if (schedulerCfg?.enabled) {
    const jobs = (schedulerCfg.jobs ?? []) as Array<{ name: string; schedule: string; message: string; enabled?: boolean; userId?: string }>;
    if (jobs.length > 0) {
      scheduler = new Scheduler({
        onTrigger: (job: CronJob) => {
          const syntheticMsg: InboundMessage = {
            id: generateId(16),
            channelId: `cron:${job.name}`,
            from: { channelId: `cron:${job.name}`, userId: job.userId ?? 'cron' },
            text: job.message,
            timestamp: new Date(),
          };
          handleInboundMessage({
            msg: syntheticMsg, channel: logChannel as unknown as IChannel, router: messageRouter,
            engine, config, observer, conversationContexts, agentRouter, defaultSystemPrompt,
            memoryBackend, skillRegistry, voiceProcessor, onInflightChange: trackInflight,
            workerPool, inFlightLoops, pendingMessages, sharedVerifier,
          });
        },
      });

      for (const job of jobs) {
        try {
          scheduler.addJob(job);
          console.log(`  ${GREEN}✓${RESET} cron: ${job.name} ${DIM}(${job.schedule})${RESET}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log(`  ${RED}✗${RESET} cron: ${job.name}: ${errMsg}`);
        }
      }

      scheduler.start();
      console.log(`  ${BOLD}Scheduler${RESET}     ${GREEN}running${RESET} (${scheduler.size} job${scheduler.size === 1 ? '' : 's'})`);
      console.log('');
    }
  }

  // Print webhook status.
  console.log(`  ${BOLD}Webhooks${RESET}      ${GREEN}enabled${RESET} ${DIM}(POST /webhooks/:name)${RESET}`);
  console.log('');

  if (requirePairing && pairingManager) {
    const code = pairingManager.generateCode('CLI startup');
    console.log(`  ${BOLD}Initial pairing code:${RESET} ${TEAL}${BOLD}${code.code}${RESET}`);
    console.log(`  ${DIM}Expires in 5 minutes. Use POST /pair to exchange for a token.${RESET}`);
    console.log('');
  }

  console.log(`  ${DIM}Press Ctrl+C to stop.${RESET}\n`);

  // Crash recovery: re-inject any in-flight sessions that were active when the
  // gateway last crashed or was killed.  Wait 5 s to give channels time to finish
  // connecting before we attempt to look them up in the registry.
  const RESUME_MAX_AGE_MS = 10 * 60_000; // 10 minutes
  void (async () => {
    await new Promise<void>((r) => setTimeout(r, 5_000));
    const staleNotes = sessionNotes.loadRecent(RESUME_MAX_AGE_MS);
    if (staleNotes.length === 0) return;
    let resumed = 0;
    for (const note of staleNotes) {
      const ch = channelRegistry.get(note.channelId);
      if (!ch) continue; // channel not available — skip
      const preamble = note.recentActivity.length > 0
        ? `[Resuming after gateway restart. Recent progress: ${note.recentActivity.join(' ')}]\n`
        : '[Resuming after gateway restart.]\n';
      const syntheticMsg: InboundMessage = {
        id: `resume:${note.contextKey}:${Date.now()}`,
        channelId: note.channelId,
        from: {
          channelId: note.channelId,
          userId: note.userId || undefined,
          groupId: note.groupId || undefined,
          threadId: note.threadId || undefined,
        },
        text: preamble + note.request,
        timestamp: new Date(),
      };
      handleInboundMessage({
        msg: syntheticMsg, channel: ch, router: messageRouter, engine, config, observer,
        conversationContexts, agentRouter, defaultSystemPrompt,
        memoryBackend, skillRegistry, voiceProcessor, onInflightChange: trackInflight,
        workerPool, inFlightLoops, pendingMessages, sharedVerifier, sessionNotes,
      });
      resumed++;
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    if (resumed > 0) {
      console.log(`  ${GREEN}[recovery]${RESET} Resumed ${resumed} in-flight session(s) from notes.`);
    }
  })();

  // Periodic eviction of stale entries from unbounded maps (every 5 minutes).
  const CONTEXT_IDLE_MS = 60 * 60_000; // 1 hour
  const evictionTimer = setInterval(() => {
    gatewayRateLimiter.evictStale();

    // Measure heap before eviction so we can apply pressure-sensitive idle windows.
    const heap = process.memoryUsage();
    const heapMB = Math.round(heap.heapUsed / 1024 / 1024);
    const rssMB = Math.round(heap.rss / 1024 / 1024);

    // Under memory pressure shrink the idle window so contexts evict much sooner
    // rather than waiting a full hour.  This frees V8 strings / closures held by
    // ContextManager entries and lets the GC reclaim pages.
    const contextIdleMs = heapMB > 500 ? 5 * 60_000 : CONTEXT_IDLE_MS;

    // Evict conversation contexts that have been inactive too long.
    const now = Date.now();
    for (const [key, entry] of conversationContexts) {
      if (now - entry.lastActiveAt > contextIdleMs) {
        conversationContexts.delete(key);
        sessionNotes.delete(key); // clean up any associated session note
      }
    }

    // Evict idle sessions, stale routes, and idle canvas sessions.
    sessionManager.evictIdle(contextIdleMs);
    messageRouter.evictStale();
    server.evictIdleCanvas(contextIdleMs);

    // Nudge the GC so the heap measurement reflects actual retained memory,
    // not uncollected garbage.  Without this, V8's lazy GC shows a slow
    // creep at idle that isn't a real leak — just deferred collection.
    // Only available when Node is started with --expose-gc.
    const gc = (globalThis as { gc?: () => void }).gc;
    if (gc) gc();

    // Re-read heap after GC for accurate measurement.
    const postGC = process.memoryUsage();
    const postHeapMB = Math.round(postGC.heapUsed / 1024 / 1024);
    const postRssMB = Math.round(postGC.rss / 1024 / 1024);

    // Log heap usage and context count for diagnostics.
    // Include external + arrayBuffers to detect Buffer/native memory leaks
    // (these are outside V8 heap but inside RSS).
    const extMB = Math.round(postGC.external / 1024 / 1024);
    const bufMB = Math.round((postGC.arrayBuffers ?? 0) / 1024 / 1024);
    console.log(
      `  ${DIM}[eviction] heap=${postHeapMB}MB ext=${extMB}MB buf=${bufMB}MB rss=${postRssMB}MB contexts=${conversationContexts.size} sessions=${sessionManager.size}${RESET}`,
    );

    // Warn at elevated heap levels.  Do NOT call v8.writeHeapSnapshot() here —
    // serialising the heap allocates 2–4× its current size and will OOM a
    // process that is already under pressure.  Use the Node flag
    // --heapsnapshot-near-heap-limit=1 at startup instead; it writes a snapshot
    // via a separate OOM handler that does not allocate on the main heap.
    if (postHeapMB > 1500) {
      console.log(
        `  ${YELLOW}[OOM warning]${RESET} Heap at ${postHeapMB}MB — restart the gateway or set NODE_OPTIONS=--max-old-space-size=512`,
      );
    } else if (postHeapMB > 500) {
      console.log(`  ${DIM}[mem pressure]${RESET} Heap at ${postHeapMB}MB — evicting with 5 min idle window${RESET}`);
    }
  }, 5 * 60_000);

  // Keep the process alive until interrupted.
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      clearInterval(evictionTimer);
      console.log(`\n  ${DIM}Shutting down gateway...${RESET}`);

      // Stop scheduler so no new cron triggers fire.
      if (scheduler) {
        scheduler.stop();
      }

      // Stop channels: no new inbound messages will arrive after this.
      if (channelSupervisor.isRunning) {
        try {
          await channelSupervisor.stop();
        } catch {
          // Best-effort stop.
        }
      }

      // Drain: wait for any in-flight agent runs to complete (30s timeout).
      if (inFlightCount > 0) {
        console.log(`  ${DIM}Draining ${inFlightCount} in-flight message(s)...${RESET}`);
        await waitForDrain(30_000);
      }

      // Stop tunnel.
      if (tunnel) {
        try {
          await tunnel.stop();
        } catch {
          // Best-effort stop.
        }
      }

      // Shut down the tool worker pool — terminates all worker threads.
      if (workerPool) {
        try {
          await workerPool.shutdown();
        } catch {
          // Best-effort shutdown.
        }
      }

      // Close memory backend so WAL is checkpointed before exit.
      if (memoryBackend) {
        try {
          await memoryBackend.close();
        } catch {
          // Best-effort close.
        }
      }

      await server.stop();
      await observer.flush?.();
      console.log(`  ${DIM}Goodbye!${RESET}\n`);
      resolve();
    };

    const onSignal = () => void shutdown();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    // Catch unhandled rejections so the gateway never silently dies.
    process.on('unhandledRejection', (reason) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      console.error(`  ${RED}✗ Unhandled rejection:${RESET} ${msg}`);
      observer.onError(new Error(`Unhandled rejection: ${msg}`), { source: 'gateway' });
    });
  });
}

// ---------------------------------------------------------------------------
// Per-user rate limiter (sliding window)
// ---------------------------------------------------------------------------

/**
 * Sliding-window rate limiter. Allows up to `maxRequests` within a rolling
 * `windowMs` period per key. Keys are auto-evicted after one full window
 * of inactivity.
 */
class RateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the request is allowed; false if rate-limited. */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const timestamps = (this.windows.get(key) ?? []).filter((t) => t > cutoff);
    if (timestamps.length >= this.maxRequests) {
      return false;
    }
    timestamps.push(now);
    this.windows.set(key, timestamps);
    return true;
  }

  /** Remove expired timestamps from all keys; delete keys that are fully expired. */
  evictStale(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      const filtered = timestamps.filter((t) => t > cutoff);
      if (filtered.length === 0) {
        this.windows.delete(key);
      } else if (filtered.length < timestamps.length) {
        this.windows.set(key, filtered);
      }
    }
  }
}

/** Gateway-level per-user rate limiter: max 20 messages per 60 s window. */
const gatewayRateLimiter = new RateLimiter(20, 60_000);

// ---------------------------------------------------------------------------
// Inbound message handler
// ---------------------------------------------------------------------------

/**
 * All dependencies required by handleInboundMessage, passed as a single
 * typed object so TypeScript catches missing fields at compile time.
 * (Replaces the previous 17-parameter positional signature that allowed
 * closure-scoped variables to slip through as runtime ReferenceErrors.)
 */
interface InboundMessageOpts {
  msg: InboundMessage;
  channel: IChannel;
  router: MessageRouter;
  engine: ReturnType<typeof createGatewayEngine>;
  config: Ch4pConfig;
  observer: ReturnType<typeof createObserver>;
  conversationContexts: Map<string, { ctx: ContextManager; lastActiveAt: number }>;
  agentRouter: AgentRouter;
  defaultSystemPrompt: string;
  memoryBackend?: ReturnType<typeof createMemoryBackend>;
  skillRegistry?: SkillRegistry;
  voiceProcessor?: VoiceProcessor;
  onInflightChange?: (delta: 1 | -1) => void;
  workerPool?: ToolWorkerPool;
  inFlightLoops?: Map<string, { loop: AgentLoop; permissionPending: boolean }>;
  pendingMessages?: Map<string, Array<{ msg: InboundMessage; channel: IChannel }>>;
  sharedVerifier?: FormatVerifier | LLMVerifier;
  sessionNotes?: SessionNotes;
}

/**
 * Handle an inbound message from a channel:
 *   1. Process voice attachments via VoiceProcessor (STT)
 *   2. Route via MessageRouter to find/create a session
 *   3. Run through AgentLoop to generate a response
 *   4. Optionally synthesize response audio via VoiceProcessor (TTS)
 *   5. Send the response back via the originating channel
 *
 * onInflightChange is called with +1 when processing starts and -1 when done,
 * enabling the gateway to drain in-flight work before exiting.
 */
function handleInboundMessage(opts: InboundMessageOpts): void {
  const {
    msg, channel, router, engine, config, observer,
    conversationContexts, agentRouter, defaultSystemPrompt,
    memoryBackend, skillRegistry, voiceProcessor,
    onInflightChange, workerPool, inFlightLoops, pendingMessages, sharedVerifier,
    sessionNotes,
  } = opts;
  if (!engine) {
    // No engine available — send a polite error back.
    channel.send(msg.from, {
      text: 'ch4p is not configured with an LLM engine. Please set up an API key via `ch4p onboard`.',
      replyTo: msg.id,
    }).catch(() => {});
    return;
  }

  // Allow voice-only messages through — they may contain audio attachments
  // that the VoiceProcessor will transcribe.
  const hasAudio = msg.attachments?.some((a) => a.type === 'audio') ?? false;
  if (!msg.text && !hasAudio) return;

  // Per-user rate limit — reject excess messages to prevent DoS.
  const { userId } = msg.from;
  const rateLimitKey = `${msg.channelId ?? 'unknown'}:${userId ?? 'anonymous'}`;
  if (!gatewayRateLimiter.allow(rateLimitKey)) {
    channel.send(msg.from, {
      text: 'You are sending messages too quickly. Please wait a moment.',
      replyTo: msg.id,
    }).catch(() => {});
    return;
  }

  // Per-user concurrency guard — only one active agent run per user.
  // Without this, rapid messages spawn parallel AgentLoops that each hold
  // Session + ToolRegistry + engine connections, causing O(N) memory growth.
  const userKey = `${msg.channelId ?? 'unknown'}:${msg.from.userId ?? 'anonymous'}`;
  if (inFlightLoops) {
    const inflight = inFlightLoops.get(userKey);
    if (inflight) {
      if (inflight.permissionPending) {
        // Forward to subprocess stdin for permission-prompt responses.
        inflight.loop.steerEngine(msg.text ?? '');
        inflight.permissionPending = false;
      } else if (pendingMessages) {
        // Queue follow-up messages (max depth 2). Beyond the cap, replace the last entry.
        const queue = pendingMessages.get(userKey) ?? [];
        if (queue.length < MAX_PENDING_PER_USER) {
          queue.push({ msg, channel });
        } else {
          // Cap reached — replace the last entry with the newest message.
          queue[queue.length - 1] = { msg, channel };
        }
        pendingMessages.set(userKey, queue);
        // Acknowledge the first queued message; don't spam on repeated follow-ups.
        if (queue.length === 1) {
          channel.send(msg.from, {
            text: "Got it — I'll get to your message once I finish what I'm working on.",
            replyTo: msg.id,
          }).catch(() => {});
        }
      } else {
        // No queue available — reject to prevent concurrent memory pressure.
        channel.send(msg.from, {
          text: "I'm still working on your previous message. Please wait for me to finish.",
          replyTo: msg.id,
        }).catch(() => {});
      }
      return;
    }
  }

  // Route the message to a session.
  const routeResult = router.route(msg);
  if (!routeResult) return;

  // Run the agent asynchronously — don't block the channel handler.
  onInflightChange?.(1);
  void (async () => {
    let runTimer: ReturnType<typeof setTimeout> | undefined;
    // Declared here (not inside try) so the finally block can access it for
    // session-note cleanup even when an exception fires before the assignment.
    let contextKey = '';
    try {
      // Process voice attachments (STT) if voice is enabled.
      const processedMsg = voiceProcessor
        ? await voiceProcessor.processInbound(msg)
        : msg;

      // After voice processing, ensure we have text to work with.
      if (!processedMsg.text) return;

      // Resolve routing decision early — before context creation so the
      // routed system prompt is used on the very first message.
      const routing = agentRouter.route(processedMsg, defaultSystemPrompt);

      // Get or create a shared context — key mirrors MessageRouter.buildRouteKey
      // so topic/thread conversations are isolated from each other.
      const { userId, groupId, threadId } = msg.from;
      contextKey = (groupId && threadId)
        ? `${msg.channelId ?? ''}:group:${groupId}:thread:${threadId}`
        : groupId
          ? `${msg.channelId ?? ''}:group:${groupId}:user:${userId ?? 'anonymous'}`
          : `${msg.channelId ?? ''}:${userId ?? 'anonymous'}`;
      let contextEntry = conversationContexts.get(contextKey);
      if (!contextEntry) {
        // Evict least-recently-used context when at capacity.
        if (conversationContexts.size >= MAX_CONTEXTS) {
          let oldestKey: string | undefined;
          let oldestTime = Infinity;
          for (const [k, v] of conversationContexts) {
            if (v.lastActiveAt < oldestTime) {
              oldestTime = v.lastActiveAt;
              oldestKey = k;
            }
          }
          if (oldestKey) conversationContexts.delete(oldestKey);
        }
        const ctx = new ContextManager({ maxTokens: GATEWAY_CONTEXT_MAX_TOKENS });
        // Use the routed system prompt (may be agent-specific or the default).
        const initPrompt = routing.systemPrompt
          ?? routeResult.config.systemPrompt
          ?? defaultSystemPrompt;
        ctx.setSystemPrompt(initPrompt);
        contextEntry = { ctx, lastActiveAt: Date.now() };
        conversationContexts.set(contextKey, contextEntry);
      } else {
        contextEntry.lastActiveAt = Date.now();
      }
      const sharedContext = contextEntry.ctx;

      // Write a session note before the run starts so a crash mid-run leaves
      // enough information to resume.  The note is deleted in the finally block
      // on successful (or error) completion.
      sessionNotes?.upsert({
        contextKey,
        channelId: msg.channelId,
        userId: userId ?? 'anonymous',
        groupId: msg.from.groupId,
        threadId: msg.from.threadId,
        request: processedMsg.text,
        requestAt: Date.now(),
        recentActivity: [],
      });

      // Build routed session config.
      const routedSessionConfig = {
        ...routeResult.config,
        model: routing.model ?? routeResult.config.model,
        systemPrompt: routing.systemPrompt ?? routeResult.config.systemPrompt,
      };

      const session = new Session(routedSessionConfig, {
        sharedContext,
        maxErrors: config.agent.maxSessionErrors,
      });
      // Build exclusion list based on autonomy level and feature flags.
      const toolExclude = config.autonomy.level === 'readonly'
        ? ['bash', 'file_write', 'file_edit', 'delegate', 'browser']
        : ['delegate', 'browser'];
      if (!config.mesh?.enabled) {
        toolExclude.push('mesh');
      }
      // Merge per-agent tool exclusions from routing decision.
      for (const t of routing.toolExclude) {
        if (!toolExclude.includes(t)) toolExclude.push(t);
      }
      const tools = ToolRegistry.createDefault({ exclude: toolExclude });

      // Register load_skill tool when skills are available.
      if (skillRegistry && skillRegistry.size > 0) {
        tools.register(new LoadSkillTool(skillRegistry));
      }

      // Register x402_pay tool when x402 plugin is enabled.
      const x402PluginCfg = (config as unknown as Record<string, unknown>).x402 as X402Config | undefined;
      if (x402PluginCfg?.enabled) {
        tools.register(new X402PayTool());
      }

      const securityPolicy = new DefaultSecurityPolicy({
        workspace: routeResult.config.cwd ?? process.cwd(),
        autonomyLevel: config.autonomy.level,
        allowedCommands: config.autonomy.allowedCommands,
        blockedPaths: config.security.blockedPaths,
      });

      // Wire auto-memory hooks when memory is available and autoSave is on.
      // Use a per-user namespace (u:{channelId}:{userId}) so memories are
      // scoped per user per channel — preventing cross-user and cross-channel
      // memory bleed in multi-tenant gateway deployments.
      const autoSave = config.memory.autoSave !== false;
      const memNamespace = `u:${msg.channelId ?? 'unknown'}:${userId ?? 'anonymous'}`;
      const onBeforeFirstRun = (memoryBackend && autoSave)
        ? createAutoRecallHook(memoryBackend, { namespace: memNamespace })
        : undefined;
      const onAfterComplete = (memoryBackend && autoSave)
        ? createAutoSummarizeHook(memoryBackend, { namespace: memNamespace })
        : undefined;

      // Build toolContextExtensions for search config when available.
      const toolContextExtensions: Record<string, unknown> = {};
      if (config.search?.enabled && config.search.apiKey) {
        toolContextExtensions.searchApiKey = config.search.apiKey;
        toolContextExtensions.searchConfig = {
          maxResults: config.search.maxResults,
          country: config.search.country,
          searchLang: config.search.searchLang,
        };
      }

      // Wire x402 EIP-712 signer when client private key is configured.
      // This enables the X402PayTool to produce real on-chain payment signatures
      // instead of the zero-filled placeholder used when no signer is provided.
      // x402 key format is validated at startup; safe to use directly here.
      if (x402PluginCfg?.enabled && x402PluginCfg.client?.privateKey) {
        const cc = x402PluginCfg.client;
        toolContextExtensions.x402Signer = createEIP712Signer(cc.privateKey!, {
          chainId:      cc.chainId,
          tokenAddress: cc.tokenAddress,
          tokenName:    cc.tokenName,
          tokenVersion: cc.tokenVersion,
        });
        toolContextExtensions.agentWalletAddress = walletAddress(cc.privateKey!);
      }

      // Provide resolveEngine so the DelegateTool can spawn sub-agent loops.
      // For now, resolve always returns the shared gateway engine (single-engine).
      toolContextExtensions.resolveEngine = (_engineId?: string) => engine;

      // AWM verifier — shared instance created at gateway startup.

      const loop = new AgentLoop(session, engine, tools.list(), observer, {
        maxIterations: routing.maxIterations, // Per-agent routing override.
        maxRetries: 2,
        enableStateSnapshots: true,
        verifier: sharedVerifier,
        memoryBackend,
        securityPolicy,
        onBeforeFirstRun,
        onAfterComplete,
        toolContextExtensions: Object.keys(toolContextExtensions).length > 0
          ? toolContextExtensions
          : undefined,
        workerPool,
        maxToolResults: config.agent.maxToolResults,
        maxToolOutputLen: config.agent.maxToolOutputLen,
        maxStateRecords: config.agent.maxStateRecords,
      });

      // Register loop so permission-prompt replies can be routed to subprocess stdin.
      if (inFlightLoops) {
        inFlightLoops.set(userKey, { loop, permissionPending: false });
      }

      // Per-run timeout — abort the loop if it exceeds the configured duration.
      // Prevents stuck subprocess/engine calls from locking out users indefinitely.
      const DEFAULT_RUN_TIMEOUT_MS = 300_000; // 5 minutes
      const runTimeoutMs = config.agent.runTimeout ?? DEFAULT_RUN_TIMEOUT_MS;
      runTimer = setTimeout(() => {
        loop.abort('Gateway run timeout exceeded');
      }, runTimeoutMs);

      let responseText = '';

      // Pattern that indicates the subprocess is waiting for user permission input.
      const PERM_RE = /\[y\/n\]|\[Y\/N\]|do you want to|allow this|permission required/i;

      for await (const event of loop.run(processedMsg.text)) {
        if (event.type === 'text') {
          responseText = event.partial;
          // Detect permission prompts and flag the loop as waiting for user response.
          if (inFlightLoops && PERM_RE.test(event.partial)) {
            const entry = inFlightLoops.get(userKey);
            if (entry) entry.permissionPending = true;
          }
        } else if (event.type === 'complete') {
          responseText = event.answer;
          // Update the session note with a brief progress snippet so a subsequent
          // crash still has recent context.
          if (event.answer) sessionNotes?.appendActivity(contextKey, event.answer);
        } else if (event.type === 'error') {
          responseText = `Error: ${event.error.message}`;
        }
      }

      if (responseText) {
        const outbound = {
          text: responseText,
          replyTo: msg.id,
          format: 'markdown' as const,
        };

        // Synthesize response audio (TTS) if voice is enabled.
        const finalOutbound = voiceProcessor
          ? await voiceProcessor.processOutbound(outbound)
          : outbound;

        await channel.send(msg.from, finalOutbound);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await channel.send(msg.from, {
        text: `Sorry, I encountered an error: ${errMsg}`,
        replyTo: msg.id,
      }).catch(() => {});
    } finally {
      clearTimeout(runTimer);

      // Remove the session note — the run completed (successfully or with an error),
      // so there is nothing left to resume on next startup.
      sessionNotes?.delete(contextKey);

      // Process the next queued message for this user, if any.
      const queue = pendingMessages?.get(userKey);
      const next = queue?.shift();
      if (queue && queue.length === 0) pendingMessages.delete(userKey);
      if (next) {
        // Remove the in-flight entry so the recursive call doesn't hit the guard.
        inFlightLoops?.delete(userKey);
        // Don't decrement inflight count — the next run continues the work.
        handleInboundMessage({ ...opts, msg: next.msg, channel: next.channel });
      } else {
        inFlightLoops?.delete(userKey);
        onInflightChange?.(-1);
      }
    }
  })();
}
