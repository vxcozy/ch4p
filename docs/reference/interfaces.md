# Reference: Interfaces

ch4p defines 10 trait interfaces. Every major component is replaceable by implementing the corresponding interface.

---

## IProvider

LLM provider abstraction. One implementation per supported provider (Anthropic, OpenAI, Ollama).

```typescript
interface IProvider {
  readonly id: string;
  readonly name: string;

  listModels(): Promise<ModelInfo[]>;
  stream(model: string, context: Message[], opts?: StreamOpts): AsyncIterable<StreamEvent>;
  complete(model: string, context: Message[], opts?: CompleteOpts): Promise<CompletionResult>;
  countTokens(model: string, messages: Message[]): Promise<number>;
  supportsTools(model: string): boolean;
}
```

### Types

```typescript
interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  inputCostPer1k?: number;
  outputCostPer1k?: number;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCost?: number;
}

interface StreamOpts {
  tools?: ToolDefinition[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
}

type CompleteOpts = StreamOpts;

type StreamEvent =
  | { type: 'text_delta'; delta: string; partial: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argsDelta: string }
  | { type: 'tool_call_end'; id: string; args: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; message: Message; usage: TokenUsage; cost?: number };

interface CompletionResult {
  message: Message;
  usage: TokenUsage;
  cost?: number;
  finishReason: 'stop' | 'tool_use' | 'max_tokens' | 'error';
}
```

---

## IChannel

Messaging surface abstraction. Callback-based message handling.

```typescript
interface IChannel {
  readonly id: string;
  readonly name: string;

  start(config: ChannelConfig): Promise<void>;
  stop(): Promise<void>;
  send(to: Recipient, message: OutboundMessage): Promise<SendResult>;
  editMessage?(to: Recipient, messageId: string, message: OutboundMessage): Promise<SendResult>;
  onMessage(handler: (msg: InboundMessage) => void): void;
  onPresence?(handler: (event: PresenceEvent) => void): void;
  isHealthy(): Promise<boolean>;
}
```

### Edit-Based Streaming

Channels that support `editMessage()` enable progressive streaming — the agent's response is updated in-place as it streams from the LLM, rather than waiting for the full answer. The gateway's `StreamHandler` detects this capability automatically via `typeof channel.editMessage === 'function'`.

Currently supported by: **Telegram** and **Discord**. Both implement rate limiting (1 edit/second) to stay within platform API limits.

### Types

```typescript
interface ChannelConfig {
  [key: string]: unknown;
}

interface Recipient {
  channelId: string;
  userId?: string;
  groupId?: string;
  threadId?: string;
}

interface InboundMessage {
  id: string;
  channelId: string;
  from: Recipient;
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  timestamp: Date;
  raw?: unknown;
}

interface OutboundMessage {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  format?: 'text' | 'markdown' | 'html';
}

interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video';
  url?: string;
  data?: Buffer;
  mimeType?: string;
  filename?: string;
}

interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

interface PresenceEvent {
  userId: string;
  status: 'online' | 'offline' | 'typing';
  channelId: string;
}
```

---

## ITool

Agent capability abstraction. Tools are classified by weight for execution routing.

```typescript
interface ITool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema7;
  readonly weight: 'lightweight' | 'heavyweight';

  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
  abort?(reason: string): void;
  validate?(args: unknown): ValidationResult;
  getStateSnapshot?(args: unknown, context: ToolContext): Promise<StateSnapshot>;
}
```

### Tool Weight

| Weight | Execution | Use For |
|--------|-----------|---------|
| `lightweight` | Main thread | Fast, non-blocking operations (file reads, regex search). |
| `heavyweight` | Worker pool | Shell commands, network requests, sub-agent delegation. |

### AWM: State Snapshots

Tools can implement `getStateSnapshot()` to capture observable state before and after execution. The agent loop uses these snapshots for diff-based verification of tool outcomes.

```typescript
interface StateSnapshot {
  timestamp: string;                 // ISO-8601
  state: Record<string, unknown>;    // Key-value observable state
  description?: string;              // Human-readable diff summary
}
```

### AWM: Mandatory Validation

The agent loop always calls `validate()` before execution. If a tool does not implement `validate()`, the loop performs basic structural validation (args must be an object). Validation errors are fed back to the LLM as tool error messages so it can self-correct.

### Types

```typescript
interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
  stateSnapshot?: StateSnapshot;  // AWM: post-execution state
}

interface ToolContext {
  sessionId: string;
  cwd: string;
  securityPolicy: ISecurityPolicy;
  abortSignal: AbortSignal;
  onProgress: (update: string) => void;
}

interface ValidationResult {
  valid: boolean;
  errors?: string[];
}
```

---

## IVerifier

Task-level outcome verification. Runs after the agent loop completes to assess result quality.

```typescript
interface IVerifier {
  readonly id: string;
  readonly name: string;

  checkFormat(context: VerificationContext): Promise<FormatCheckResult>;
  checkSemantic?(context: VerificationContext): Promise<SemanticCheckResult>;
  verify(context: VerificationContext): Promise<VerificationResult>;
}
```

### Verification Flow

Verification is a two-phase process inspired by AWM's code-augmented LLM-as-a-Judge:

1. **Format check** (fast, code-based) — validates structural expectations (JSON schema, file exists, HTTP 200).
2. **Semantic check** (optional, LLM-based) — evaluates whether the result satisfies the user's intent.

### Types

```typescript
type VerificationOutcome = 'success' | 'partial' | 'failure';

interface VerificationResult {
  outcome: VerificationOutcome;
  confidence: number;       // 0 to 1
  reasoning: string;
  issues?: VerificationIssue[];
  suggestions?: string[];   // Self-correction hints
  formatCheck?: FormatCheckResult;
  semanticCheck?: SemanticCheckResult;
}

interface VerificationIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  step?: string;
}

interface VerificationContext {
  taskDescription: string;
  finalAnswer: string;
  messages: Message[];
  toolResults: ToolResult[];
  stateSnapshots: Array<{
    tool: string;
    args: unknown;
    before?: StateSnapshot;
    after?: StateSnapshot;
  }>;
}

interface FormatCheckResult {
  passed: boolean;
  errors?: string[];
}

interface SemanticCheckResult {
  passed: boolean;
  score: number;
  reasoning: string;
}
```

---

## IMemoryBackend

Persistent memory with hybrid search. Zero-dependency SQLite FTS5 for keywords plus vector embeddings for semantic search.

```typescript
interface IMemoryBackend {
  readonly id: string;

  store(key: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  recall(query: string, opts?: RecallOpts): Promise<MemoryResult[]>;
  forget(key: string): Promise<boolean>;
  list(prefix?: string): Promise<MemoryEntry[]>;
  reindex(): Promise<void>;
  close(): Promise<void>;
}
```

### Types

```typescript
interface RecallOpts {
  limit?: number;
  vectorWeight?: number;   // 0-1, weight for semantic search (default 0.7)
  keywordWeight?: number;  // 0-1, weight for keyword search (default 0.3)
  minScore?: number;
  filter?: Record<string, unknown>;
}

interface MemoryResult {
  key: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
  matchType: 'keyword' | 'vector' | 'hybrid';
}

interface MemoryEntry {
  key: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
```

---

## IEngine

Execution engine abstraction. The native engine uses IProvider directly; CLI engines wrap subprocess calls. All engines share this interface.

```typescript
interface IEngine {
  readonly id: string;
  readonly name: string;

  startRun(job: Job, opts?: RunOpts): Promise<RunHandle>;
  resume(token: ResumeToken, prompt: string): Promise<RunHandle>;
}
```

### Types

```typescript
interface Job {
  sessionId: string;
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
  model?: string;
  config?: Record<string, unknown>;
}

interface RunOpts {
  signal?: AbortSignal;
  onProgress?: (event: EngineEvent) => void;
}

interface RunHandle {
  readonly ref: string;
  events: AsyncIterable<EngineEvent>;
  cancel(): Promise<void>;
  steer(message: string): void;
}

interface ResumeToken {
  engineId: string;
  ref: string;
  state: unknown;
}

type EngineEvent =
  | { type: 'started'; resumeToken?: ResumeToken }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; id: string; tool: string; args: unknown }
  | { type: 'tool_progress'; id: string; update: string }
  | { type: 'tool_end'; id: string; result: ToolResult }
  | { type: 'completed'; answer: string; usage?: TokenUsage }
  | { type: 'error'; error: Error };
```

---

## ISecurityPolicy

Security boundary enforcement. Every defense layer is on by default.

```typescript
interface ISecurityPolicy {
  readonly autonomyLevel: AutonomyLevel;

  validatePath(path: string, operation: PathOperation): PathValidation;
  validateCommand(command: string, args: string[]): CommandValidation;
  requiresConfirmation(action: ActionDescriptor): boolean;
  audit(): AuditResult[];
  sanitizeOutput(text: string): SanitizationResult;
  validateInput(text: string, conversationContext?: ConversationContext): InputValidationResult;
}
```

### Types

```typescript
type AutonomyLevel = 'readonly' | 'supervised' | 'full';
type PathOperation = 'read' | 'write' | 'execute';

interface PathValidation {
  allowed: boolean;
  reason?: string;
  canonicalPath?: string;
}

interface CommandValidation {
  allowed: boolean;
  reason?: string;
}

interface ActionDescriptor {
  type: string;
  target: string;
  details?: Record<string, unknown>;
}

type AuditSeverity = 'pass' | 'warn' | 'fail';

interface AuditResult {
  id: number;
  name: string;
  severity: AuditSeverity;
  message: string;
}

interface SanitizationResult {
  clean: string;
  redacted: boolean;
  redactedPatterns?: string[];
}

interface InputValidationResult {
  safe: boolean;
  threats: ThreatDetection[];
}

interface ThreatDetection {
  type: 'extraction' | 'injection' | 'role_manipulation' | 'jailbreak' | 'exfiltration';
  pattern: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
}

interface ConversationContext {
  turnCount: number;
  sensitiveKeywords: Set<string>;
  extractionAttempts: number;
  overrideAttempts: number;
}
```

---

## IObserver

Structured observability for every subsystem. Receives events for sessions, tools, LLM calls, channel messages, errors, and security events.

```typescript
interface IObserver {
  onSessionStart(meta: SessionMeta): void;
  onSessionEnd(meta: SessionMeta, stats: SessionStats): void;
  onToolInvocation(event: ToolInvocationEvent): void;
  onLLMCall(event: LLMCallEvent): void;
  onChannelMessage(event: ChannelMessageEvent): void;
  onError(error: Error, context: Record<string, unknown>): void;
  onSecurityEvent(event: SecurityEvent): void;
  flush?(): Promise<void>;
}
```

### Types

```typescript
interface SessionMeta {
  sessionId: string;
  channelId?: string;
  userId?: string;
  engineId: string;
  startedAt: Date;
}

interface SessionStats {
  duration: number;
  toolInvocations: number;
  llmCalls: number;
  tokensUsed: TokenUsage;
  errors: number;
}

interface ToolInvocationEvent {
  sessionId: string;
  tool: string;
  args: unknown;
  result?: ToolResult;
  duration: number;
  error?: Error;
}

interface LLMCallEvent {
  sessionId: string;
  provider: string;
  model: string;
  usage: TokenUsage;
  duration: number;
  finishReason: string;
}

interface ChannelMessageEvent {
  channelId: string;
  direction: 'inbound' | 'outbound';
  userId?: string;
  messageLength: number;
  timestamp: Date;
}

interface SecurityEvent {
  type: 'path_blocked' | 'command_blocked' | 'injection_detected' | 'secret_redacted' | 'pairing_attempt';
  details: Record<string, unknown>;
  timestamp: Date;
}
```

---

## ITunnelProvider

Exposes the local gateway to the internet for webhook-based channels (Telegram, Slack, etc.). Supports Tailscale, Cloudflare, ngrok, and similar services.

```typescript
interface ITunnelProvider {
  readonly id: string;

  start(config: TunnelConfig): Promise<TunnelInfo>;
  stop(): Promise<void>;
  isActive(): boolean;
  getPublicUrl(): string | null;
}
```

### Types

```typescript
interface TunnelConfig {
  port: number;
  subdomain?: string;
  authToken?: string;
  [key: string]: unknown;
}

interface TunnelInfo {
  publicUrl: string;
  provider: string;
  startedAt: Date;
}
```

---

## IIdentityProvider

On-chain agent identity, reputation, and validation. This is a **plugin hook** — the trait interface lives in `@ch4p/core` (zero dependencies), but concrete implementations (e.g., `@ch4p/plugin-erc8004`) bring the chain client. If no identity provider is configured, all identity-aware code paths are skipped.

Designed for [ERC-8004 (Trustless Agents)](https://eips.ethereum.org/EIPS/eip-8004) but abstract enough to support other identity standards.

```typescript
interface IIdentityProvider {
  readonly id: string;
  readonly chainId: number;

  // Identity Registry
  register(uri?: string, metadata?: Array<{ key: string; value: Uint8Array }>): Promise<AgentIdentity>;
  getIdentity(agentId: string): Promise<AgentIdentity | null>;
  setAgentURI(agentId: string, uri: string): Promise<void>;
  setMetadata(agentId: string, key: string, value: Uint8Array): Promise<void>;
  getMetadata(agentId: string, key: string): Promise<Uint8Array | null>;

  // Reputation Registry
  getReputation(agentId: string, trustedClients?: string[], tag1?: string, tag2?: string): Promise<ReputationSummary>;
  submitFeedback(agentId: string, value: number, decimals: number, opts?: FeedbackOpts): Promise<void>;
  readFeedback(agentId: string, clientAddress: string, feedbackIndex: number): Promise<FeedbackEntry>;

  // Validation Registry
  requestValidation(agentId: string, validatorAddress: string, requestURI: string, requestHash: string): Promise<void>;
  getValidationStatus(requestHash: string): Promise<ValidationStatus | null>;
  getValidationSummary(agentId: string, trustedValidators?: string[], tag?: string): Promise<ValidationSummary>;

  // Service Discovery
  resolveAgentURI(agentId: string): Promise<AgentRegistrationFile | null>;

  // Trust Assessment
  assessTrust(agentId: string, context: TrustContext): Promise<TrustDecision>;
}
```

### Types

```typescript
interface AgentIdentity {
  agentId: string;
  registry: string;
  chainId: number;
  globalId: string;
  ownerAddress: string;
  agentWallet?: string;
  uri?: string;
}

interface AgentRegistrationFile {
  type: string;
  name: string;
  description: string;
  image: string;
  services: AgentService[];
  x402Support?: boolean;
  active?: boolean;
  registrations?: CrossChainRegistration[];
  supportedTrust?: string[];
}

interface AgentService {
  name: string;
  endpoint: string;
  version?: string;
  skills?: string[];
  domains?: string[];
}

interface ReputationSummary {
  count: number;
  summaryValue: number;
  summaryValueDecimals: number;
  normalizedScore: number;
}

interface ValidationSummary {
  count: number;
  averageResponse: number;
}

interface TrustContext {
  operation: 'delegate' | 'mcp_connect' | 'a2a_call' | 'tool_proxy';
  reputation?: ReputationSummary;
  validation?: ValidationSummary;
}

interface TrustDecision {
  allowed: boolean;
  reason: string;
  reputationScore?: number;
  validationScore?: number;
}
```
