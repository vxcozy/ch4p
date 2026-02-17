/**
 * Agent command — interactive REPL and single-message mode.
 *
 * Two modes:
 *   1. `ch4p agent -m "message"` — Single message, stream response, exit.
 *   2. `ch4p agent` or `ch4p`   — Interactive REPL with special commands.
 *
 * Both modes route through the full AgentLoop pipeline:
 *   Session → AgentLoop → Engine → Provider → Tools (with AWM validation)
 *
 * The old "direct engine" path has been replaced — every message now flows
 * through AgentLoop for mandatory tool validation, state snapshots, and
 * optional task-level verification.
 */

import * as readline from 'node:readline';
import type { Ch4pConfig, IEngine, IMemoryBackend, ISecurityPolicy, SessionConfig } from '@ch4p/core';
import { generateId } from '@ch4p/core';
import { NativeEngine, createClaudeCliEngine, createCodexCliEngine, SubprocessEngine } from '@ch4p/engines';
import type { SubprocessEngineConfig } from '@ch4p/engines';
import { ProviderRegistry } from '@ch4p/providers';
import { Session, AgentLoop, ContextManager, FormatVerifier, LLMVerifier, createAutoRecallHook, createAutoSummarizeHook } from '@ch4p/agent';
import type { AgentEvent, AgentLoopOpts, SessionOpts } from '@ch4p/agent';
import { ToolRegistry, LoadSkillTool } from '@ch4p/tools';
import { createObserver } from '@ch4p/observability';
import type { ObservabilityConfig } from '@ch4p/observability';
import { createMemoryBackend } from '@ch4p/memory';
import type { MemoryConfig } from '@ch4p/memory';
import { DefaultSecurityPolicy } from '@ch4p/security';
import { SkillRegistry } from '@ch4p/skills';
import { loadConfig, getLogsDir } from '../config.js';
import { playBriefSplash } from './splash.js';
import {
  TEAL, TEAL_DIM, RESET, BOLD, DIM, GREEN, YELLOW, RED, MAGENTA, BLUE,
  BOX, CHECK, CROSS, WARN,
  CHAPPIE_GLYPH, PROMPT_CHAR,
  chatHeader, sessionBanner, tokenFooter, separator,
} from '../ui.js';

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

function truncateArgs(args: unknown): string {
  const str = typeof args === 'string' ? args : JSON.stringify(args);
  return truncate(str, 80);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

// ---------------------------------------------------------------------------
// Teal gutter for tool/verification blocks
// ---------------------------------------------------------------------------

const GUTTER = `  ${TEAL_DIM}${BOX.vertical}${RESET} `;

// ---------------------------------------------------------------------------
// Stateful AgentEvent output handler (Claude CLI-inspired)
// ---------------------------------------------------------------------------

interface ChatRenderState {
  /** Whether the assistant header (◆ ch4p) has been printed for this turn. */
  headerPrinted: boolean;
  /** Whether we are currently inside streaming text output. */
  inTextStream: boolean;
  /** Whether we were in a thinking block (to add separator before text). */
  wasThinking: boolean;
}

function createChatRenderState(): ChatRenderState {
  return { headerPrinted: false, inTextStream: false, wasThinking: false };
}

function resetChatRenderState(state: ChatRenderState): void {
  state.headerPrinted = false;
  state.inTextStream = false;
  state.wasThinking = false;
}

function handleAgentEvent(event: AgentEvent, state: ChatRenderState): void {
  // Ensure the assistant header is printed before any content.
  const ensureHeader = () => {
    if (!state.headerPrinted) {
      console.log(chatHeader(CHAPPIE_GLYPH, 'ch4p'));
      state.headerPrinted = true;
    }
  };

  switch (event.type) {
    case 'thinking':
      ensureHeader();
      if (!state.wasThinking) {
        process.stdout.write('  '); // indent first thinking chunk
      }
      process.stdout.write(`${DIM}${event.delta}${RESET}`);
      state.wasThinking = true;
      break;

    case 'text':
      ensureHeader();
      if (state.wasThinking && !state.inTextStream) {
        // Transition from thinking to text: add separation.
        process.stdout.write('\n\n');
        state.wasThinking = false;
      }
      if (!state.inTextStream) {
        // First text delta: start with 2-space indent.
        process.stdout.write('  ');
        state.inTextStream = true;
      }
      process.stdout.write(event.delta);
      break;

    case 'tool_start':
      ensureHeader();
      if (state.inTextStream) {
        // End previous text stream before tool block.
        process.stdout.write('\n');
        state.inTextStream = false;
      }
      if (state.wasThinking) {
        process.stdout.write('\n');
        state.wasThinking = false;
      }
      console.log('');
      console.log(`${GUTTER}${BOLD}${event.tool}${RESET}${DIM}(${truncateArgs(event.args)})${RESET}`);
      break;

    case 'tool_progress':
      process.stdout.write(`${GUTTER}${DIM}${event.update}${RESET}\n`);
      break;

    case 'tool_end':
      if (event.result.success) {
        const output = truncate(event.result.output, 120);
        if (output) {
          console.log(`${GUTTER}${DIM}${output}${RESET}`);
        }
        console.log(`${GUTTER}${CHECK} ${DIM}Done${RESET}`);
      } else {
        console.log(`${GUTTER}${CROSS} ${event.result.error ?? 'Unknown error'}`);
      }
      break;

    case 'tool_validation_error':
      console.log(`${GUTTER}${WARN} ${YELLOW}${event.tool}: ${event.errors.join(', ')}${RESET}`);
      break;

    case 'verification': {
      const v = event.result;
      const outcomeColor = v.outcome === 'success' ? GREEN : v.outcome === 'partial' ? YELLOW : RED;
      console.log(`\n${GUTTER}${BLUE}verify${RESET} ${outcomeColor}${v.outcome}${RESET} ${DIM}confidence=${v.confidence.toFixed(2)}${RESET}`);
      if (v.reasoning) {
        console.log(`${GUTTER}${DIM}${v.reasoning}${RESET}`);
      }
      if (v.issues && v.issues.length > 0) {
        for (const issue of v.issues) {
          console.log(`${GUTTER}${WARN} ${issue}`);
        }
      }
      break;
    }

    case 'complete':
      if (state.inTextStream) {
        process.stdout.write('\n');
        state.inTextStream = false;
      }
      if (event.usage) {
        console.log(tokenFooter(event.usage));
      }
      // Reset state for next turn.
      resetChatRenderState(state);
      break;

    case 'error':
      ensureHeader();
      console.error(`\n  ${RED}Error:${RESET} ${event.error.message}`);
      break;

    case 'aborted':
      ensureHeader();
      console.log(`\n  ${YELLOW}Aborted:${RESET} ${event.reason}`);
      break;
  }
}

// ---------------------------------------------------------------------------
// Engine creation
// ---------------------------------------------------------------------------

/**
 * Create the engine for the CLI session.
 *
 * Engine selection is driven by `config.engines.default`:
 *   - 'claude-cli'  → SubprocessEngine wrapping the `claude` CLI (uses Max plan auth)
 *   - 'codex-cli'   → SubprocessEngine wrapping the `codex` CLI
 *   - 'native' / *  → NativeEngine backed by the configured LLM provider
 *
 * For NativeEngine, if the provider's API key is missing, falls back to a stub
 * engine so the CLI still boots (useful for offline/demo mode).
 *
 * For SubprocessEngines, the CLI binary must be installed and on PATH.
 */
function createEngine(config: Ch4pConfig): IEngine {
  const engineId = config.engines?.default ?? 'native';
  const engineConfig = config.engines?.available?.[engineId] as Record<string, unknown> | undefined;

  // ----- Subprocess engines (claude-cli, codex-cli, custom) -----
  if (engineId === 'claude-cli') {
    try {
      return createClaudeCliEngine({
        command: (engineConfig?.command as string) ?? undefined,
        cwd: (engineConfig?.cwd as string) ?? undefined,
        timeout: (engineConfig?.timeout as number) ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ${YELLOW}⚠ Failed to create Claude CLI engine: ${message}${RESET}`);
      console.log(`  ${DIM}Falling back to stub engine.${RESET}\n`);
      return createStubEngine(config);
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
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ${YELLOW}⚠ Failed to create Codex CLI engine: ${message}${RESET}`);
      console.log(`  ${DIM}Falling back to stub engine.${RESET}\n`);
      return createStubEngine(config);
    }
  }

  // Generic subprocess engine — user-defined CLI wrapper.
  if (engineConfig?.type === 'subprocess') {
    try {
      return new SubprocessEngine({
        id: engineId,
        name: (engineConfig.name as string) ?? `Subprocess (${engineId})`,
        command: engineConfig.command as string,
        args: (engineConfig.args as string[]) ?? undefined,
        promptMode: (engineConfig.promptMode as 'arg' | 'stdin' | 'flag') ?? undefined,
        promptFlag: (engineConfig.promptFlag as string) ?? undefined,
        cwd: (engineConfig.cwd as string) ?? undefined,
        timeout: (engineConfig.timeout as number) ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ${YELLOW}⚠ Failed to create subprocess engine "${engineId}": ${message}${RESET}`);
      console.log(`  ${DIM}Falling back to stub engine.${RESET}\n`);
      return createStubEngine(config);
    }
  }

  // ----- NativeEngine (LLM provider-backed) -----
  const providerName = config.agent.provider;
  const providerConfig = config.providers?.[providerName] as Record<string, unknown> | undefined;

  // Check if we have a usable API key (Ollama doesn't need one).
  const apiKey = providerConfig?.apiKey as string | undefined;
  const needsKey = providerName !== 'ollama';

  if (needsKey && (!apiKey || apiKey.trim().length === 0)) {
    console.log(`  ${YELLOW}⚠ No API key for ${providerName}. Running in stub mode.${RESET}`);
    console.log(`  ${DIM}Set ${providerName.toUpperCase()}_API_KEY or run 'ch4p onboard' to configure.${RESET}\n`);
    return createStubEngine(config);
  }

  try {
    const provider = ProviderRegistry.createProvider({
      id: providerName,
      type: providerName,
      ...providerConfig,
    });

    return new NativeEngine({
      provider,
      defaultModel: config.agent.model,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  ${YELLOW}⚠ Failed to create ${providerName} provider: ${message}${RESET}`);
    console.log(`  ${DIM}Falling back to stub engine.${RESET}\n`);
    return createStubEngine(config);
  }
}

/**
 * Stub engine for offline/demo mode.
 * Echoes back the user's message with configuration info.
 */
function createStubEngine(config: Ch4pConfig): IEngine {
  return {
    id: config.engines?.default ?? 'native',
    name: 'Native Engine (stub)',

    async startRun(job, opts) {
      const ref = generateId(12);

      async function* events(): AsyncIterable<import('@ch4p/core').EngineEvent> {
        yield { type: 'started' };

        const lastMessage = job.messages[job.messages.length - 1];
        const userText = typeof lastMessage?.content === 'string'
          ? lastMessage.content
          : '(no message)';

        const response =
          `I received your message: "${truncate(userText, 100)}"\n\n` +
          `This is a placeholder response from the ch4p stub engine. ` +
          `To use a real LLM, configure your API key for ${config.agent.provider}.\n\n` +
          `Current configuration:\n` +
          `  Provider: ${config.agent.provider}\n` +
          `  Model: ${config.agent.model}\n` +
          `  Autonomy: ${config.autonomy.level}\n`;

        for (const char of response) {
          if (opts?.signal?.aborted) {
            yield { type: 'error', error: new Error('Aborted') };
            return;
          }
          yield { type: 'text_delta', delta: char };
        }

        yield {
          type: 'completed',
          answer: response,
          usage: { inputTokens: Math.ceil(userText.length / 4), outputTokens: Math.ceil(response.length / 4) },
        };
      }

      return {
        ref,
        events: events(),
        async cancel() { /* noop for stub */ },
        steer(_message: string) { /* noop for stub */ },
      };
    },

    async resume(_token, _prompt) {
      throw new Error('Resume not supported in stub engine');
    },
  };
}

// ---------------------------------------------------------------------------
// Session + AgentLoop creation
// ---------------------------------------------------------------------------

function createSessionConfig(config: Ch4pConfig, skillRegistry?: SkillRegistry, hasMemory?: boolean, hasSearch?: boolean): SessionConfig {
  let systemPrompt =
    'You are ch4p, a personal AI assistant. ' +
    'You are helpful, concise, and security-conscious. ' +
    'When asked to perform actions, respect the configured autonomy level.';

  // When memory is available, let the LLM know it can remember things.
  if (hasMemory) {
    systemPrompt +=
      ' You have persistent memory — you can recall information from previous conversations ' +
      'and learn from interactions over time. Use the memory_store and memory_recall tools ' +
      'to explicitly save or retrieve specific information when helpful.';
  }

  // When search is available, let the LLM know it can search the web.
  if (hasSearch) {
    systemPrompt +=
      ' You have web search capability — use the web_search tool to find ' +
      'current information, look up facts, or research topics when needed.';
  }

  // Inject skill descriptions for progressive disclosure.
  if (skillRegistry && skillRegistry.size > 0) {
    const descriptions = skillRegistry.getDescriptions()
      .map((s) => `  - ${s.name}: ${s.description}`)
      .join('\n');
    systemPrompt +=
      '\n\nAvailable skills (use the `load_skill` tool with the skill name to get full instructions):\n' + descriptions;
  }

  return {
    sessionId: generateId(16),
    engineId: config.engines?.default ?? 'native',
    model: config.agent.model,
    provider: config.agent.provider,
    autonomyLevel: config.autonomy.level,
    cwd: process.cwd(),
    systemPrompt,
  };
}

/**
 * Create the skill registry from configured paths.
 * Returns an empty registry if skills are disabled or no skills found.
 */
function createSkillRegistry(config: Ch4pConfig): SkillRegistry {
  if (!config.skills?.enabled) return new SkillRegistry();
  try {
    return SkillRegistry.createFromPaths(config.skills.paths);
  } catch {
    // Skill loading failures shouldn't crash the agent
    return new SkillRegistry();
  }
}

/**
 * Create the default tool registry for CLI sessions.
 *
 * Excludes heavyweight tools (bash, delegate) when running in readonly
 * autonomy mode. Memory tools are always included — the backend may or
 * may not be wired, but the tools validate gracefully.
 */
function createToolRegistry(config: Ch4pConfig, skillRegistry?: SkillRegistry): ToolRegistry {
  // Build exclusion list based on autonomy level and feature flags.
  const exclude: string[] = [];
  if (config.autonomy.level === 'readonly') {
    exclude.push('bash', 'file_write', 'file_edit', 'delegate');
  }
  if (!config.mesh?.enabled) {
    exclude.push('mesh');
  }

  const registry = ToolRegistry.createDefault(
    exclude.length > 0 ? { exclude } : undefined,
  );

  // Register the load_skill tool when skills are available.
  // This enables progressive disclosure: the agent sees skill names in its
  // system prompt and can load full instructions on-demand.
  if (skillRegistry && skillRegistry.size > 0) {
    registry.register(new LoadSkillTool(skillRegistry));
  }

  return registry;
}

/**
 * Create a memory backend from config.
 * Falls back to NoopMemoryBackend on any error so the agent always boots.
 */
function createMemory(config: Ch4pConfig): IMemoryBackend | undefined {
  try {
    const memCfg: MemoryConfig = {
      backend: config.memory.backend,
      vectorWeight: config.memory.vectorWeight,
      keywordWeight: config.memory.keywordWeight,
      embeddingProvider: config.memory.embeddingProvider,
      openaiApiKey: (config.providers?.openai?.apiKey as string) || undefined,
    };
    const backend = createMemoryBackend(memCfg);
    return backend;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  ${YELLOW}⚠ Memory backend failed to initialise: ${message}${RESET}`);
    console.log(`  ${DIM}Memory tools will be unavailable this session.${RESET}\n`);
    return undefined;
  }
}

/**
 * Create an observer from config.
 * Falls back to the factory default (NoopObserver) on error.
 */
function createConfiguredObserver(config: Ch4pConfig) {
  try {
    const obsCfg: ObservabilityConfig = {
      observers: config.observability.observers ?? ['console'],
      logLevel: config.observability.logLevel ?? 'info',
      logPath: `${getLogsDir()}/ch4p.jsonl`,
    };
    return createObserver(obsCfg);
  } catch {
    // Factory failure — fall back to console-only.
    return createObserver({ observers: ['console'], logLevel: 'info' });
  }
}

/**
 * Create a security policy from config.
 * Scopes filesystem access to the session cwd, enforces command allowlist,
 * and respects the configured autonomy level.
 */
function createSecurityPolicy(config: Ch4pConfig, cwd: string): ISecurityPolicy {
  return new DefaultSecurityPolicy({
    workspace: cwd,
    autonomyLevel: config.autonomy.level,
    allowedCommands: config.autonomy.allowedCommands,
    blockedPaths: config.security.blockedPaths,
  });
}

/**
 * Create an AWM verifier from config.
 * Returns a FormatVerifier by default; upgrades to LLMVerifier when semantic
 * checks are enabled and an LLM provider is available.
 */
function createVerifier(config: Ch4pConfig, engine: IEngine) {
  const vCfg = config.verification;
  if (!vCfg?.enabled) return undefined;

  const formatOpts = {
    maxToolErrorRatio: vCfg.maxToolErrorRatio ?? 0.5,
  };

  if (vCfg.semantic) {
    // LLMVerifier needs a provider. Try to reuse the agent's provider.
    try {
      const providerName = config.agent.provider;
      const providerConfig = config.providers?.[providerName] as Record<string, unknown> | undefined;
      const provider = ProviderRegistry.createProvider({
        id: `${providerName}-verifier`,
        type: providerName,
        ...providerConfig,
      });
      return new LLMVerifier({
        provider,
        model: config.agent.model,
        formatOpts,
      });
    } catch {
      // Fall back to format-only if provider creation fails.
      return new FormatVerifier(formatOpts);
    }
  }

  return new FormatVerifier(formatOpts);
}

/**
 * Create a full AgentLoop wired with engine, tools, observer, memory, and security.
 */
interface CreateAgentLoopExtras {
  sessionOpts?: SessionOpts;
  onBeforeFirstRun?: AgentLoopOpts['onBeforeFirstRun'];
  onAfterComplete?: AgentLoopOpts['onAfterComplete'];
  maxIterations?: number;
}

function createAgentLoop(
  config: Ch4pConfig,
  engine: IEngine,
  sessionConfig: SessionConfig,
  memoryBackend?: IMemoryBackend,
  skillRegistry?: SkillRegistry,
  extras?: CreateAgentLoopExtras,
): AgentLoop {
  const session = new Session(sessionConfig, extras?.sessionOpts);
  const tools = createToolRegistry(config, skillRegistry);
  const observer = createConfiguredObserver(config);
  const securityPolicy = createSecurityPolicy(config, sessionConfig.cwd ?? process.cwd());

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
  const verifier = createVerifier(config, engine);

  return new AgentLoop(session, engine, tools.list(), observer, {
    maxIterations: extras?.maxIterations ?? 50,
    maxRetries: 3,
    enableStateSnapshots: true,
    verifier,
    memoryBackend,
    securityPolicy,
    onBeforeFirstRun: extras?.onBeforeFirstRun,
    onAfterComplete: extras?.onAfterComplete,
    toolContextExtensions: Object.keys(toolContextExtensions).length > 0
      ? toolContextExtensions
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// Run a single message through the AgentLoop
// ---------------------------------------------------------------------------

async function runAgentMessage(
  config: Ch4pConfig,
  engine: IEngine,
  sessionConfig: SessionConfig,
  message: string,
  memoryBackend?: IMemoryBackend,
  skillRegistry?: SkillRegistry,
  extras?: CreateAgentLoopExtras,
  renderState?: ChatRenderState,
): Promise<void> {
  const loop = createAgentLoop(config, engine, sessionConfig, memoryBackend, skillRegistry, extras);
  const state = renderState ?? createChatRenderState();

  for await (const event of loop.run(message)) {
    handleAgentEvent(event, state);
  }
}

// ---------------------------------------------------------------------------
// REPL help
// ---------------------------------------------------------------------------

const REPL_HELP = `
  ${BOLD}Special Commands${RESET}
${separator()}
  ${TEAL}/exit${RESET}     Exit the session
  ${TEAL}/clear${RESET}    Clear conversation history
  ${TEAL}/audit${RESET}    Run security audit
  ${TEAL}/memory${RESET}   Show memory status
  ${TEAL}/tools${RESET}    List available tools
  ${TEAL}/skills${RESET}   List available skills
  ${TEAL}/help${RESET}     Show this help
`;

// ---------------------------------------------------------------------------
// Interactive REPL mode
// ---------------------------------------------------------------------------

async function runRepl(config: Ch4pConfig): Promise<void> {
  const engine = createEngine(config);
  const skillRegistry = createSkillRegistry(config);
  const memoryBackend = createMemory(config);
  const hasMemory = !!memoryBackend;
  const hasSearch = !!(config.search?.enabled && config.search.apiKey);
  const sessionConfig = createSessionConfig(config, skillRegistry, hasMemory, hasSearch);
  const tools = createToolRegistry(config);

  // Create a shared ContextManager that persists across REPL messages.
  // This gives the agent conversation continuity within the session.
  const sharedContext = new ContextManager();

  // Set the system prompt on the shared context.
  if (sessionConfig.systemPrompt) {
    sharedContext.setSystemPrompt(sessionConfig.systemPrompt);
  }

  // Build auto-memory lifecycle hooks when memory is available and autoSave is on.
  const autoSave = config.memory.autoSave !== false; // default: true
  const onBeforeFirstRun = (memoryBackend && autoSave)
    ? createAutoRecallHook(memoryBackend)
    : undefined;
  const onAfterComplete = (memoryBackend && autoSave)
    ? createAutoSummarizeHook(memoryBackend)
    : undefined;

  // Brief splash animation (TTY only).
  if (process.stdout.isTTY) {
    await playBriefSplash();
  }

  // Session banner with Chappie mascot + session info.
  const bannerInfo: Record<string, string> = {
    Engine: engine.name,
    Model: config.agent.model,
    Autonomy: config.autonomy.level,
    Tools: `${tools.size} loaded`,
    Memory: memoryBackend ? `${config.memory.backend}${autoSave ? ' (auto)' : ''}` : `${DIM}disabled${RESET}`,
  };
  if (skillRegistry.size > 0) {
    bannerInfo.Skills = `${skillRegistry.size} loaded`;
  }
  console.log('\n' + sessionBanner(bannerInfo));
  console.log(`  ${DIM}Type ${TEAL}/help${DIM} for commands, ${TEAL}/exit${DIM} to quit.${RESET}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${TEAL}${BOLD}${PROMPT_CHAR} ${RESET}`,
    historySize: 200,
  });

  let running = true;

  // Handle Ctrl+C gracefully.
  rl.on('SIGINT', () => {
    console.log(`\n${DIM}  Use /exit to quit.${RESET}`);
    rl.prompt();
  });

  rl.on('close', () => {
    if (running) {
      running = false;
      void memoryBackend?.close();
      console.log(`\n${DIM}  Goodbye!${RESET}\n`);
    }
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    // Handle special commands.
    if (input.startsWith('/')) {
      const cmd = input.toLowerCase().split(/\s+/)[0]!;

      switch (cmd) {
        case '/exit':
        case '/quit':
        case '/q':
          running = false;
          console.log(`\n${DIM}  Goodbye!${RESET}\n`);
          rl.close();
          await memoryBackend?.close();
          return;

        case '/clear':
          sharedContext.clear();
          // Re-set the system prompt after clearing.
          if (sessionConfig.systemPrompt) {
            sharedContext.setSystemPrompt(sessionConfig.systemPrompt);
          }
          console.log(`  ${GREEN}Conversation cleared.${RESET}\n`);
          rl.prompt();
          continue;

        case '/audit': {
          const { runAudit } = await import('./audit.js');
          console.log('');
          runAudit(config);
          console.log('');
          rl.prompt();
          continue;
        }

        case '/memory':
          console.log(`\n  ${BOLD}Memory Status${RESET}`);
          console.log(`  ${DIM}Backend: ${config.memory.backend}${RESET}`);
          console.log(`  ${DIM}Active: ${memoryBackend ? `${GREEN}yes${RESET}` : `${YELLOW}no (failed to initialise)${RESET}`}`);
          console.log(`  ${DIM}Auto-save: ${config.memory.autoSave}${RESET}`);
          console.log(`  ${DIM}Vector weight: ${config.memory.vectorWeight ?? 0.7}${RESET}`);
          console.log(`  ${DIM}Keyword weight: ${config.memory.keywordWeight ?? 0.3}${RESET}\n`);
          rl.prompt();
          continue;

        case '/tools':
          console.log(`\n  ${BOLD}Available Tools${RESET} ${DIM}(${tools.size})${RESET}`);
          for (const tool of tools.list()) {
            console.log(`  ${TEAL}${tool.name}${RESET} ${DIM}[${tool.weight}]${RESET} ${tool.description}`);
          }
          console.log('');
          rl.prompt();
          continue;

        case '/skills':
          if (skillRegistry.size === 0) {
            console.log(`\n  ${DIM}No skills loaded.${RESET}\n`);
          } else {
            console.log(`\n  ${BOLD}Available Skills${RESET} ${DIM}(${skillRegistry.size})${RESET}`);
            for (const skill of skillRegistry.list()) {
              console.log(`  ${TEAL}${skill.manifest.name}${RESET} ${DIM}(${skill.source})${RESET} ${skill.manifest.description}`);
            }
            console.log('');
          }
          rl.prompt();
          continue;

        case '/help':
          console.log(REPL_HELP);
          rl.prompt();
          continue;

        default:
          console.log(`  ${YELLOW}Unknown command: ${cmd}${RESET}`);
          console.log(`  ${DIM}Type /help for available commands.${RESET}\n`);
          rl.prompt();
          continue;
      }
    }

    // Echo the user's message with a styled header.
    console.log(chatHeader(PROMPT_CHAR, 'You'));
    console.log(`  ${input}`);

    // Run the message through the full AgentLoop pipeline.
    const renderState = createChatRenderState();
    try {
      await runAgentMessage(config, engine, sessionConfig, input, memoryBackend, skillRegistry, {
        sessionOpts: { sharedContext },
        onBeforeFirstRun,
        onAfterComplete,
      }, renderState);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  ${RED}Error:${RESET} ${message}`);
    }
    console.log('');
    rl.prompt();
  }
}

// ---------------------------------------------------------------------------
// Single message mode
// ---------------------------------------------------------------------------

async function runSingleMessage(config: Ch4pConfig, message: string): Promise<void> {
  const engine = createEngine(config);
  const skillRegistry = createSkillRegistry(config);
  const memoryBackend = createMemory(config);
  const hasMemory = !!memoryBackend;
  const hasSearch = !!(config.search?.enabled && config.search.apiKey);
  const sessionConfig = createSessionConfig(config, skillRegistry, hasMemory, hasSearch);

  // Wire auto-memory hooks for single-message mode.
  const autoSave = config.memory.autoSave !== false;
  const onBeforeFirstRun = (memoryBackend && autoSave)
    ? createAutoRecallHook(memoryBackend)
    : undefined;
  const onAfterComplete = (memoryBackend && autoSave)
    ? createAutoSummarizeHook(memoryBackend)
    : undefined;

  try {
    // Echo the user's message with a styled header (same as REPL).
    console.log(chatHeader(PROMPT_CHAR, 'You'));
    console.log(`  ${message}`);

    await runAgentMessage(config, engine, sessionConfig, message, memoryBackend, skillRegistry, {
      onBeforeFirstRun,
      onAfterComplete,
    });
    console.log('');
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error(`\n${RED}Error:${RESET} ${errMessage}`);
    process.exitCode = 1;
  } finally {
    await memoryBackend?.close();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Parse agent-specific flags and run the appropriate mode.
 *
 * Usage:
 *   ch4p agent                — Interactive REPL
 *   ch4p agent -m "message"   — Single message
 *   ch4p agent --message "m"  — Single message (long form)
 */
export async function agent(args: string[]): Promise<void> {
  let config: Ch4pConfig;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${RED}Failed to load config:${RESET} ${message}`);
    console.error(`  ${DIM}Run ${TEAL}ch4p onboard${DIM} to set up ch4p.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  // Parse -m / --message flag.
  let singleMessage: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-m' || arg === '--message') {
      singleMessage = args[i + 1] ?? '';
      break;
    }
    // Handle -m"message" (no space).
    if (arg.startsWith('-m') && arg.length > 2) {
      singleMessage = arg.slice(2);
      break;
    }
  }

  if (singleMessage !== null) {
    if (!singleMessage) {
      console.error(`  ${RED}Error:${RESET} -m flag requires a message argument.`);
      process.exitCode = 1;
      return;
    }
    await runSingleMessage(config, singleMessage);
  } else {
    await runRepl(config);
  }
}
