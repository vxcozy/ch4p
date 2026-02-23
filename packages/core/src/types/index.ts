/**
 * Shared types used across all ch4p packages.
 */

// === Messages ===

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  imageUrl?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

// === Tool Definitions ===

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// === Sessions ===

export interface SessionConfig {
  sessionId: string;
  channelId?: string;
  userId?: string;
  engineId: string;
  model: string;
  provider: string;
  systemPrompt?: string;
  tools?: string[];
  autonomyLevel?: 'readonly' | 'supervised' | 'full';
  cwd?: string;
}

// === Events ===

export interface Ch4pEvent {
  type: string;
  timestamp: Date;
  sessionId?: string;
  data?: unknown;
}

// === Configuration ===

export interface Ch4pConfig {
  agent: {
    model: string;
    provider: string;
    thinkingLevel?: 'low' | 'medium' | 'high';
  };
  providers: Record<string, Record<string, unknown>>;
  channels: Record<string, Record<string, unknown>>;
  memory: {
    backend: string;
    autoSave: boolean;
    embeddingProvider?: string;
    vectorWeight?: number;
    keywordWeight?: number;
  };
  gateway: {
    port: number;
    requirePairing: boolean;
    allowPublicBind: boolean;
  };
  security: {
    workspaceOnly: boolean;
    blockedPaths: string[];
  };
  autonomy: {
    level: 'readonly' | 'supervised' | 'full';
    allowedCommands: string[];
  };
  engines: {
    default: string;
    available: Record<string, Record<string, unknown>>;
  };
  tunnel: {
    provider: string;
    [key: string]: unknown;
  };
  secrets: {
    encrypt: boolean;
  };
  observability: {
    observers: string[];
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
  skills: {
    enabled: boolean;
    paths: string[];
    autoLoad: boolean;
    contextBudget: number;
  };
  voice?: {
    enabled: boolean;
    stt: {
      provider: 'whisper' | 'deepgram';
      apiKey?: string;
    };
    tts: {
      provider: 'elevenlabs' | 'none';
      apiKey?: string;
      voiceId?: string;
    };
    wake?: {
      /** Enable always-on voice wake listening. Default: false. */
      enabled: boolean;
      /** Optional wake word (e.g. "hey chappie"). Omit for push-to-talk style. */
      wakeWord?: string;
      /** VAD energy threshold for speech detection (default: 500). */
      energyThreshold?: number;
      /** Duration of silence (ms) before ending speech (default: 800). */
      silenceDurationMs?: number;
    };
  };
  canvas?: {
    enabled: boolean;
    /** Defaults to gateway.port when not specified. */
    port?: number;
    /** Per-session component limit (default 500). */
    maxComponents?: number;
    /** Require pairing for canvas connections. Default: false (canvas is local-only). */
    requirePairing?: boolean;
  };
  /** ERC-8004 on-chain identity configuration. */
  identity?: {
    enabled: boolean;
    provider: 'erc8004';
    /** Chain ID (EIP-155). Default: 8453 (Base). */
    chainId?: number;
    /** JSON-RPC endpoint for the target chain. */
    rpcUrl?: string;
    /** Contract addresses (defaults come from the plugin). */
    contracts?: {
      identityRegistry?: string;
      reputationRegistry?: string;
      validationRegistry?: string;
    };
    /** Agent ID if already registered on-chain. */
    agentId?: string;
    /** Private key for write operations. Supports ${CH4P_SECRET:name}. */
    privateKey?: string;
    /** When to submit reputation feedback. */
    feedbackMode?: 'always' | 'threshold' | 'manual' | 'off';
    /** Reputation threshold for automatic feedback (0-1). */
    feedbackThreshold?: number;
    /** Trust thresholds for gating external agent connections. */
    trust?: {
      minReputation?: number;
      minValidation?: number;
      trustedClients?: string[];
      trustedValidators?: string[];
    };
  };
  /** AWM (Agent World Model) verification configuration. */
  verification?: {
    /** Enable task-level verification. Default: true. */
    enabled: boolean;
    /** Enable LLM-based semantic checks in addition to format checks.
     *  Requires an extra LLM call per completed task. Default: false. */
    semantic: boolean;
    /** Maximum allowed tool error ratio (0-1). Default: 0.5. */
    maxToolErrorRatio?: number;
  };
  /** Mesh orchestration (swarm-style multi-agent delegation). */
  mesh?: {
    /** Enable mesh tool for parallel multi-agent tasks. Default: false. */
    enabled: boolean;
    /** Maximum concurrent sub-agents (default: 3). */
    maxConcurrency?: number;
    /** Default timeout per task in ms (default: 120000). */
    defaultTimeout?: number;
  };
  /** Web search configuration (Brave Search API). */
  search?: {
    enabled: boolean;
    provider: 'brave';
    /** API key for the search provider. Supports ${ENV_VAR} substitution. */
    apiKey?: string;
    /** Maximum results per query (1-20). Default: 5. */
    maxResults?: number;
    /** Default country code for search localization (e.g., 'US'). */
    country?: string;
    /** Default search language (e.g., 'en'). */
    searchLang?: string;
  };
  /**
   * Config-driven multi-agent routing.
   *
   * Define named sub-agents with their own system prompts and models, then
   * write routing rules that dispatch inbound gateway messages to the right
   * agent based on channel ID and/or message text patterns.
   *
   * Example:
   * ```json
   * {
   *   "routing": {
   *     "agents": {
   *       "coding": {
   *         "systemPrompt": "You are an expert coding assistant.",
   *         "model": "claude-opus-4-5",
   *         "maxIterations": 50
   *       },
   *       "quick": { "model": "claude-haiku-3-5", "maxIterations": 5 }
   *     },
   *     "rules": [
   *       { "channel": "telegram", "match": "code|debug|fix", "agent": "coding" },
   *       { "match": "\\bhi\\b|hello", "agent": "quick" }
   *     ]
   *   }
   * }
   * ```
   */
  routing?: {
    /**
     * Named agent configurations. Each entry can override the system prompt,
     * model, provider, max iterations, and tool exclusions for that agent.
     */
    agents?: Record<string, {
      /** Custom system prompt for this agent. */
      systemPrompt?: string;
      /** LLM model to use (overrides agent.model). */
      model?: string;
      /** Maximum agent loop iterations (default: 20). */
      maxIterations?: number;
      /** Additional tools to exclude beyond the global exclusion list. */
      toolExclude?: string[];
    }>;
    /**
     * Routing rules evaluated in order. The first matching rule wins.
     * If no rule matches, the default agent configuration is used.
     */
    rules?: Array<{
      /**
       * Channel ID to match (e.g. "telegram", "discord").
       * Omit or use "*" to match any channel.
       */
      channel?: string;
      /**
       * Regex pattern tested against the inbound message text (case-insensitive).
       * Omit to match any message on the given channel.
       */
      match?: string;
      /** Name of the agent in `routing.agents` to dispatch to. */
      agent: string;
    }>;
  };
  /** x402 HTTP micropayment plugin configuration (@ch4p/plugin-x402). */
  x402?: {
    /** Whether x402 payment enforcement is active. Default: false. */
    enabled?: boolean;
    /** Server-side: protect gateway endpoints with payment requirements. */
    server?: {
      /** Wallet address that receives payments. */
      payTo: string;
      /**
       * Payment amount in the asset's smallest unit.
       * Example: "1000000" = 1 USDC (6 decimals).
       */
      amount: string;
      /** ERC-20 token contract address. Defaults to USDC on Base. */
      asset?: string;
      /** Network identifier. Defaults to "base". */
      network?: string;
      /** Human-readable description shown in the 402 response. */
      description?: string;
      /**
       * URL paths to gate. Supports trailing "/*" wildcard.
       * Default: all paths except /health, /.well-known/agent.json, /pair.
       */
      protectedPaths?: string[];
      /** Seconds before a payment authorization expires. Default: 300. */
      maxTimeoutSeconds?: number;
    };
  };
}
