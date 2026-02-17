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
  };
  canvas?: {
    enabled: boolean;
    /** Defaults to gateway.port when not specified. */
    port?: number;
    /** Per-session component limit (default 500). */
    maxComponents?: number;
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
}
