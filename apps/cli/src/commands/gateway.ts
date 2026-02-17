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

import type { Ch4pConfig, IChannel, InboundMessage, ISecurityPolicy, ITunnelProvider } from '@ch4p/core';
import { generateId } from '@ch4p/core';
import { loadConfig, getLogsDir } from '../config.js';
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
import { Session, AgentLoop, ContextManager, FormatVerifier, LLMVerifier, createAutoRecallHook, createAutoSummarizeHook } from '@ch4p/agent';
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
    } catch {
      // Fall through to native.
    }
  }

  if (engineId === 'codex-cli') {
    try {
      return createCodexCliEngine({
        command: (engineConfig?.command as string) ?? undefined,
        cwd: (engineConfig?.cwd as string) ?? undefined,
        timeout: (engineConfig?.timeout as number) ?? undefined,
      });
    } catch {
      // Fall through to native.
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

  const defaultSessionConfig = {
    engineId: config.engines?.default ?? 'native',
    model: config.agent.model,
    provider: config.agent.provider,
    systemPrompt:
      'You are ch4p, a personal AI assistant. ' +
      'You are helpful, concise, and security-conscious.',
  };

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

  // Create MessageRouter for channel → session routing.
  const messageRouter = new MessageRouter(sessionManager, defaultSessionConfig);

  // Create the engine for processing channel messages.
  const engine = createGatewayEngine(config);

  // Create skill registry (optional).
  let skillRegistry: SkillRegistry | undefined;
  try {
    if (config.skills?.enabled && config.skills?.paths?.length) {
      skillRegistry = SkillRegistry.createFromPaths(config.skills.paths);
    }
  } catch {
    // Skills not critical for gateway.
  }

  // Create memory backend (optional).
  let memoryBackend;
  try {
    const memCfg: MemoryConfig = {
      backend: config.memory.backend,
      vectorWeight: config.memory.vectorWeight,
      keywordWeight: config.memory.keywordWeight,
      embeddingProvider: config.memory.embeddingProvider,
      openaiApiKey: (config.providers?.openai?.apiKey as string) || undefined,
    };
    memoryBackend = createMemoryBackend(memCfg);
  } catch {
    // Memory not critical for gateway.
  }

  // Create observer.
  const obsCfg: ObservabilityConfig = {
    observers: config.observability.observers ?? ['console'],
    logLevel: config.observability.logLevel ?? 'info',
    logPath: `${getLogsDir()}/gateway.jsonl`,
  };
  const observer = createObserver(obsCfg);

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

  // Per-user conversation context so messages within the same channel+user
  // share history (like the REPL's sharedContext).
  const conversationContexts = new Map<string, ContextManager>();

  // Create LogChannel for cron/webhook responses (logs to observer).
  const logChannel = new LogChannel({
    onResponse: (_to, msg) => {
      observer.onEvent?.({
        type: 'cron_response',
        timestamp: new Date(),
        data: { text: msg.text },
      });
    },
  });

  const server = new GatewayServer({
    port,
    host,
    sessionManager,
    pairingManager,
    defaultSessionConfig,
    agentRegistration,
    onWebhook: (name, payload) => {
      const syntheticMsg: InboundMessage = {
        id: generateId(16),
        channelId: `webhook:${name}`,
        from: { channelId: `webhook:${name}`, userId: payload.userId ?? 'webhook' },
        text: payload.message,
        timestamp: new Date(),
      };
      handleInboundMessage(
        syntheticMsg, logChannel as unknown as IChannel, messageRouter, engine, config, observer,
        conversationContexts, memoryBackend, skillRegistry, voiceProcessor,
      );
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
    kvRow('Identity', agentRegistration ? `${GREEN}enabled${RESET} (chain ${config.identity?.chainId ?? 8453})` : `${DIM}disabled${RESET}`),
  ]));
  console.log('');
  console.log(`  ${DIM}Routes:${RESET}`);
  console.log(`  ${DIM}  GET    /health              - liveness probe${RESET}`);
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

      try {
        await channel.start(channelCfg);
        channelRegistry.register(channel);
        startedChannels.push(channel);

        // Wire inbound messages: channel → voice → messageRouter → AgentLoop → channel.send()
        channel.onMessage((msg: InboundMessage) => {
          handleInboundMessage(
            msg, channel, messageRouter, engine, config, observer,
            conversationContexts, memoryBackend, skillRegistry, voiceProcessor,
          );
        });

        // Register with supervisor for crash recovery. The channel is already
        // started, so start() is a no-op reconnect and shutdown() calls stop().
        let alive = true;
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

        console.log(`    ${GREEN}✓${RESET} ${channelName} ${DIM}(${channel.name})${RESET}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`    ${RED}✗${RESET} ${channelName}: ${errMsg}`);
      }
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
        localPort: port,
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
  const schedulerCfg = (config as Record<string, unknown>).scheduler as Record<string, unknown> | undefined;
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
          handleInboundMessage(
            syntheticMsg, logChannel as unknown as IChannel, messageRouter, engine, config, observer,
            conversationContexts, memoryBackend, skillRegistry, voiceProcessor,
          );
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

  // Keep the process alive until interrupted.
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      console.log(`\n  ${DIM}Shutting down gateway...${RESET}`);

      // Stop scheduler.
      if (scheduler) {
        scheduler.stop();
      }

      // Stop channels via supervisor (handles graceful shutdown).
      if (channelSupervisor.isRunning) {
        try {
          await channelSupervisor.stop();
        } catch {
          // Best-effort stop.
        }
      }

      // Stop tunnel.
      if (tunnel) {
        try {
          await tunnel.stop();
        } catch {
          // Best-effort stop.
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

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });
}

// ---------------------------------------------------------------------------
// Inbound message handler
// ---------------------------------------------------------------------------

/**
 * Handle an inbound message from a channel:
 *   1. Process voice attachments via VoiceProcessor (STT)
 *   2. Route via MessageRouter to find/create a session
 *   3. Run through AgentLoop to generate a response
 *   4. Optionally synthesize response audio via VoiceProcessor (TTS)
 *   5. Send the response back via the originating channel
 */
function handleInboundMessage(
  msg: InboundMessage,
  channel: IChannel,
  router: MessageRouter,
  engine: ReturnType<typeof createGatewayEngine>,
  config: Ch4pConfig,
  observer: ReturnType<typeof createObserver>,
  conversationContexts: Map<string, ContextManager>,
  memoryBackend?: ReturnType<typeof createMemoryBackend>,
  skillRegistry?: SkillRegistry,
  voiceProcessor?: VoiceProcessor,
): void {
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

  // Route the message to a session.
  const routeResult = router.route(msg);
  if (!routeResult) return;

  // Run the agent asynchronously — don't block the channel handler.
  void (async () => {
    try {
      // Process voice attachments (STT) if voice is enabled.
      const processedMsg = voiceProcessor
        ? await voiceProcessor.processInbound(msg)
        : msg;

      // After voice processing, ensure we have text to work with.
      if (!processedMsg.text) return;

      // Get or create a shared context for this channel+user so conversation
      // history persists across messages (like the REPL's sharedContext).
      const contextKey = `${msg.channelId ?? ''}:${msg.from.userId ?? 'anon'}`;
      let sharedContext = conversationContexts.get(contextKey);
      if (!sharedContext) {
        sharedContext = new ContextManager();
        if (routeResult.config.systemPrompt) {
          sharedContext.setSystemPrompt(routeResult.config.systemPrompt);
        }
        conversationContexts.set(contextKey, sharedContext);
      }

      const session = new Session(routeResult.config, { sharedContext });
      // Build exclusion list based on autonomy level and feature flags.
      const toolExclude = config.autonomy.level === 'readonly'
        ? ['bash', 'file_write', 'file_edit', 'delegate', 'browser']
        : ['delegate', 'browser'];
      if (!config.mesh?.enabled) {
        toolExclude.push('mesh');
      }
      const tools = ToolRegistry.createDefault({ exclude: toolExclude });

      // Register load_skill tool when skills are available.
      if (skillRegistry && skillRegistry.size > 0) {
        tools.register(new LoadSkillTool(skillRegistry));
      }

      const securityPolicy = new DefaultSecurityPolicy({
        workspace: routeResult.config.cwd ?? process.cwd(),
        autonomyLevel: config.autonomy.level,
        allowedCommands: config.autonomy.allowedCommands,
        blockedPaths: config.security.blockedPaths,
      });

      // Wire auto-memory hooks when memory is available and autoSave is on.
      const autoSave = config.memory.autoSave !== false;
      const onBeforeFirstRun = (memoryBackend && autoSave)
        ? createAutoRecallHook(memoryBackend)
        : undefined;
      const onAfterComplete = (memoryBackend && autoSave)
        ? createAutoSummarizeHook(memoryBackend)
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

      // AWM verifier — runs task-level verification after each agent response.
      const vCfg = config.verification;
      let verifier;
      if (vCfg?.enabled) {
        const formatOpts = { maxToolErrorRatio: vCfg.maxToolErrorRatio ?? 0.5 };
        if (vCfg.semantic && engine) {
          try {
            const providerName = config.agent.provider;
            const providerConfig = config.providers?.[providerName] as Record<string, unknown> | undefined;
            const provider = ProviderRegistry.createProvider({
              id: `${providerName}-verifier`,
              type: providerName,
              ...providerConfig,
            });
            verifier = new LLMVerifier({ provider, model: config.agent.model, formatOpts });
          } catch {
            verifier = new FormatVerifier(formatOpts);
          }
        } else {
          verifier = new FormatVerifier(formatOpts);
        }
      }

      const loop = new AgentLoop(session, engine, tools.list(), observer, {
        maxIterations: 20, // Lower limit for channel messages.
        maxRetries: 2,
        enableStateSnapshots: true,
        verifier,
        memoryBackend,
        securityPolicy,
        onBeforeFirstRun,
        onAfterComplete,
        toolContextExtensions: Object.keys(toolContextExtensions).length > 0
          ? toolContextExtensions
          : undefined,
      });

      let responseText = '';

      for await (const event of loop.run(processedMsg.text)) {
        if (event.type === 'text') {
          responseText = event.partial;
        } else if (event.type === 'complete') {
          responseText = event.answer;
        } else if (event.type === 'error') {
          responseText = `Error: ${event.error.message}`;
        }
      }

      if (responseText) {
        const outbound = {
          text: responseText,
          replyTo: msg.id,
          format: 'text' as const,
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
    }
  })();
}
