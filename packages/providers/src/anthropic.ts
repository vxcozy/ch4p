/**
 * Anthropic provider — the primary LLM provider for ch4p.
 * Uses the Anthropic Messages API with streaming support.
 *
 * Communicates directly with https://api.anthropic.com/v1/messages via fetch(),
 * with no SDK dependency. Supports SSE-based streaming, tool use, abort signals,
 * and automatic retry with exponential backoff for transient errors.
 */

import type {
  IProvider,
  ModelInfo,
  TokenUsage,
  StreamOpts,
  CompleteOpts,
  StreamEvent,
  CompletionResult,
} from '@ch4p/core';
import type { Message, ContentBlock, ToolDefinition, ToolCall } from '@ch4p/core';
import { ProviderError, sleep, backoffDelay, generateId } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const MAX_RETRIES = 3;
const PROVIDER_ID = 'anthropic';
const PROVIDER_NAME = 'Anthropic';

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
  },
  {
    id: 'claude-opus-4-20250514',
    name: 'Claude Opus 4',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.015,
    outputCostPer1k: 0.075,
  },
  {
    id: 'claude-haiku-3-5-20241022',
    name: 'Claude 3.5 Haiku',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.004,
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
  },
  {
    id: 'claude-3-opus-20240229',
    name: 'Claude 3 Opus',
    contextWindow: 200_000,
    maxOutputTokens: 4_096,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.015,
    outputCostPer1k: 0.075,
  },
];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AnthropicProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Anthropic API types (internal)
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  source?: { type: 'base64'; media_type: string; data: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  temperature?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
}

interface AnthropicResponseUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  usage: AnthropicResponseUsage;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class AnthropicProvider implements IProvider {
  readonly id = PROVIDER_ID;
  readonly name = PROVIDER_NAME;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private validated = false;

  constructor(config: AnthropicProviderConfig) {
    if (!config.apiKey) {
      throw new ProviderError('Anthropic API key is required', PROVIDER_ID);
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? API_BASE).replace(/\/+$/, '');
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
  }

  // -----------------------------------------------------------------------
  // IProvider.listModels
  // -----------------------------------------------------------------------

  async listModels(): Promise<ModelInfo[]> {
    return ANTHROPIC_MODELS;
  }

  // -----------------------------------------------------------------------
  // IProvider.supportsTools
  // -----------------------------------------------------------------------

  supportsTools(model: string): boolean {
    // All claude-3+ models support tools
    return /^claude-(3|sonnet|opus|haiku)/.test(model);
  }

  // -----------------------------------------------------------------------
  // IProvider.countTokens
  // -----------------------------------------------------------------------

  async countTokens(_model: string, messages: Message[]): Promise<number> {
    // Rough estimate: ~4 chars per token. Replace with real tokenizer later.
    let totalChars = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          totalChars += (block.text ?? '').length;
          totalChars += JSON.stringify(block.toolInput ?? '').length;
          totalChars += (block.toolOutput ?? '').length;
        }
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          totalChars += tc.name.length + JSON.stringify(tc.args).length;
        }
      }
    }
    return Math.ceil(totalChars / 4);
  }

  // -----------------------------------------------------------------------
  // IProvider.stream
  // -----------------------------------------------------------------------

  async *stream(
    model: string,
    context: Message[],
    opts?: StreamOpts,
  ): AsyncIterable<StreamEvent> {
    await this.ensureValidated();

    const body = this.buildRequestBody(model, context, opts, true);
    const response = await this.fetchWithRetry(body, opts?.signal);

    if (!response.body) {
      throw new ProviderError('No response body for stream', PROVIDER_ID);
    }

    // State accumulators
    let fullText = '';
    const toolCalls = new Map<string, { name: string; argsJson: string }>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    // Parse SSE from the response body
    const MAX_SSE_BUFFER = 10 * 1024 * 1024; // 10 MiB — guard against runaway lines
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER) {
          throw new ProviderError('SSE stream buffer exceeded 10 MiB — aborting', this.id);
        }
        const lines = buffer.split('\n');
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(data);
            } catch {
              continue; // Skip malformed lines
            }

            const events = this.processSSEEvent(event, fullText, toolCalls, usage);
            for (const streamEvent of events) {
              // Update local accumulators based on events
              if (streamEvent.type === 'text_delta') {
                fullText = streamEvent.partial;
              }
              if (streamEvent.type === 'usage') {
                usage = streamEvent.usage;
              }
              yield streamEvent;
            }

            // Stop reason tracked via message_stop event type
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Build the final assembled message
    const assembledMessage = this.buildAssembledMessage(fullText, toolCalls);
    yield {
      type: 'done',
      message: assembledMessage,
      usage,
      cost: this.estimateCost(model, usage),
    };
  }

  // -----------------------------------------------------------------------
  // IProvider.complete
  // -----------------------------------------------------------------------

  async complete(
    model: string,
    context: Message[],
    opts?: CompleteOpts,
  ): Promise<CompletionResult> {
    await this.ensureValidated();

    const body = this.buildRequestBody(model, context, opts, false);
    const response = await this.fetchWithRetry(body, opts?.signal);
    const json = (await response.json()) as AnthropicResponse;

    const message = this.mapResponseToMessage(json);
    const usage = this.mapUsage(json.usage);
    const finishReason = this.mapStopReason(json.stop_reason);

    return {
      message,
      usage,
      cost: this.estimateCost(model, usage),
      finishReason,
    };
  }

  // -----------------------------------------------------------------------
  // Private: Request building
  // -----------------------------------------------------------------------

  private buildRequestBody(
    model: string,
    context: Message[],
    opts: StreamOpts | undefined,
    stream: boolean,
  ): AnthropicRequestBody {
    const { systemPrompt, messages } = this.extractSystem(context, opts?.systemPrompt);
    const anthropicMessages = messages.map((m) => this.mapMessage(m));

    const maxTokens = opts?.maxTokens ?? this.getDefaultMaxTokens(model);

    const body: AnthropicRequestBody = {
      model,
      messages: anthropicMessages,
      max_tokens: maxTokens,
      stream,
    };

    if (systemPrompt) body.system = systemPrompt;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.stopSequences?.length) body.stop_sequences = opts.stopSequences;

    if (opts?.tools?.length) {
      body.tools = opts.tools.map((t) => this.mapToolDefinition(t));
    }

    return body;
  }

  /**
   * Extract system prompt from messages or opts. The Anthropic API takes
   * system as a top-level field, not as a message role.
   */
  private extractSystem(
    context: Message[],
    systemPromptOpt?: string,
  ): { systemPrompt: string | undefined; messages: Message[] } {
    let systemPrompt = systemPromptOpt;
    const messages: Message[] = [];

    for (const msg of context) {
      if (msg.role === 'system') {
        // Concatenate system messages
        const text = typeof msg.content === 'string' ? msg.content : '';
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
      } else {
        messages.push(msg);
      }
    }

    return { systemPrompt, messages };
  }

  private mapMessage(msg: Message): AnthropicMessage {
    const role: 'user' | 'assistant' = msg.role === 'tool' ? 'user' : (msg.role as 'user' | 'assistant');

    if (msg.role === 'tool') {
      // Tool results map to user messages with tool_result content blocks
      const blocks: AnthropicContentBlock[] = [];
      if (msg.toolCallId) {
        blocks.push({
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
      }
      return { role: 'user', content: blocks };
    }

    if (typeof msg.content === 'string' && !msg.toolCalls?.length) {
      return { role, content: msg.content };
    }

    // Complex content
    const blocks: AnthropicContentBlock[] = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        blocks.push(this.mapContentBlock(block));
      }
    } else if (typeof msg.content === 'string' && msg.content) {
      blocks.push({ type: 'text', text: msg.content });
    }

    // Append tool_use blocks for tool calls
    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.args,
        });
      }
    }

    return { role, content: blocks.length > 0 ? blocks : '' };
  }

  private mapContentBlock(block: ContentBlock): AnthropicContentBlock {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text ?? '' };

      case 'image':
        if (block.imageUrl?.startsWith('data:')) {
          const match = block.imageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: match[1]!,
                data: match[2]!,
              },
            };
          }
        }
        // For URL images, the API expects base64 — callers must pre-encode
        return { type: 'text', text: `[Image: ${block.imageUrl ?? 'unknown'}]` };

      case 'tool_use':
        return {
          type: 'tool_use',
          id: block.toolCallId ?? generateId(),
          name: block.toolName ?? '',
          input: block.toolInput ?? {},
        };

      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.toolCallId ?? '',
          content: block.toolOutput ?? '',
        };

      default:
        return { type: 'text', text: block.text ?? '' };
    }
  }

  private mapToolDefinition(tool: ToolDefinition): AnthropicTool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    };
  }

  // -----------------------------------------------------------------------
  // Private: Response mapping
  // -----------------------------------------------------------------------

  private mapResponseToMessage(response: AnthropicResponse): Message {
    const content: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text ?? '' });
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          toolCallId: block.id,
          toolName: block.name,
          toolInput: block.input,
        });
        toolCalls.push({
          id: block.id ?? generateId(),
          name: block.name ?? '',
          args: block.input ?? {},
        });
      }
    }

    return {
      role: 'assistant',
      content: content.length === 1 && content[0]!.type === 'text'
        ? (content[0]!.text ?? '')
        : content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  private mapUsage(usage: AnthropicResponseUsage): TokenUsage {
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
    };
  }

  private mapStopReason(
    reason: string | null | undefined,
  ): CompletionResult['finishReason'] {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'max_tokens';
      default:
        return 'stop';
    }
  }

  // -----------------------------------------------------------------------
  // Private: SSE event processing
  // -----------------------------------------------------------------------

  private processSSEEvent(
    event: Record<string, unknown>,
    currentText: string,
    toolCalls: Map<string, { name: string; argsJson: string }>,
    currentUsage: TokenUsage,
  ): StreamEvent[] {
    const events: StreamEvent[] = [];
    const eventType = event.type as string;

    switch (eventType) {
      case 'content_block_start': {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          const id = block.id as string;
          const name = block.name as string;
          toolCalls.set(id, { name, argsJson: '' });
          events.push({ type: 'tool_call_start', id, name });
        }
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (!delta) break;

        if (delta.type === 'text_delta') {
          const text = delta.text as string;
          events.push({
            type: 'text_delta',
            delta: text,
            partial: currentText + text,
          });
        } else if (delta.type === 'input_json_delta') {
          const partial = delta.partial_json as string;
          // Find the tool call by looking at which one is currently being built
          // The index corresponds to content block index, but we track by id
          // We need to find the last-started tool call
          const lastEntry = [...toolCalls.entries()].pop();
          if (lastEntry) {
            const [id, tc] = lastEntry;
            tc.argsJson += partial;
            events.push({ type: 'tool_call_delta', id, argsDelta: partial });
          }
        }
        break;
      }

      case 'content_block_stop': {
        // Finalize the last tool call if any
        const lastEntry = [...toolCalls.entries()].pop();
        if (lastEntry) {
          const [id, tc] = lastEntry;
          // Only emit tool_call_end if we have accumulated args JSON
          if (tc.argsJson) {
            let parsedArgs: unknown = {};
            try {
              parsedArgs = JSON.parse(tc.argsJson);
            } catch {
              parsedArgs = tc.argsJson;
            }
            events.push({ type: 'tool_call_end', id, args: parsedArgs });
          }
        }
        break;
      }

      case 'message_start': {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.usage) {
          const u = message.usage as AnthropicResponseUsage;
          const mapped = this.mapUsage(u);
          Object.assign(currentUsage, mapped);
          events.push({ type: 'usage', usage: { ...mapped } });
        }
        break;
      }

      case 'message_delta': {
        const msgUsage = event.usage as AnthropicResponseUsage | undefined;
        if (msgUsage) {
          const mapped = this.mapUsage(msgUsage);
          // message_delta carries output tokens
          currentUsage.outputTokens = mapped.outputTokens || currentUsage.outputTokens;
          events.push({
            type: 'usage',
            usage: { ...currentUsage },
          });
        }
        break;
      }

      // Ignore: 'ping', 'message_stop', etc.
    }

    return events;
  }

  // -----------------------------------------------------------------------
  // Private: Assembled message from stream
  // -----------------------------------------------------------------------

  private buildAssembledMessage(
    text: string,
    toolCallMap: Map<string, { name: string; argsJson: string }>,
  ): Message {
    const content: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    if (text) {
      content.push({ type: 'text', text });
    }

    for (const [id, tc] of toolCallMap) {
      let parsedArgs: unknown = {};
      try {
        parsedArgs = JSON.parse(tc.argsJson);
      } catch {
        parsedArgs = tc.argsJson || {};
      }
      content.push({
        type: 'tool_use',
        toolCallId: id,
        toolName: tc.name,
        toolInput: parsedArgs,
      });
      toolCalls.push({ id, name: tc.name, args: parsedArgs });
    }

    return {
      role: 'assistant',
      content: content.length === 1 && content[0]!.type === 'text'
        ? (content[0]!.text ?? '')
        : content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Private: HTTP transport
  // -----------------------------------------------------------------------

  private async fetchWithRetry(
    body: AnthropicRequestBody,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new ProviderError('Request aborted', PROVIDER_ID);
      }

      try {
        const response = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': API_VERSION,
          },
          body: JSON.stringify(body),
          signal,
        });

        if (response.ok) {
          return response;
        }

        const status = response.status;
        const errorBody = await response.text().catch(() => '');

        // Authentication error — do not retry
        if (status === 401) {
          this.validated = false;
          throw new ProviderError(
            `Authentication failed: invalid API key`,
            PROVIDER_ID,
            { status, body: errorBody },
          );
        }

        // Bad request — do not retry
        if (status === 400) {
          throw new ProviderError(
            `Bad request: ${errorBody}`,
            PROVIDER_ID,
            { status, body: errorBody },
          );
        }

        // Rate limited (429) or overloaded (529) — retry with backoff
        if (status === 429 || status === 529) {
          lastError = new ProviderError(
            status === 429 ? 'Rate limited' : 'API overloaded',
            PROVIDER_ID,
            { status, body: errorBody },
          );

          if (attempt < this.maxRetries) {
            const retryAfter = this.parseRetryAfter(response);
            const delay = retryAfter ?? backoffDelay(attempt);
            await sleep(delay);
            continue;
          }
          throw lastError;
        }

        // Other server errors — retry
        if (status >= 500) {
          lastError = new ProviderError(
            `Server error: ${status}`,
            PROVIDER_ID,
            { status, body: errorBody },
          );

          if (attempt < this.maxRetries) {
            await sleep(backoffDelay(attempt));
            continue;
          }
          throw lastError;
        }

        // Other client errors — do not retry
        throw new ProviderError(
          `API error: ${status} ${errorBody}`,
          PROVIDER_ID,
          { status, body: errorBody },
        );
      } catch (err) {
        if (err instanceof ProviderError) throw err;

        // Network errors — retry
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < this.maxRetries) {
          await sleep(backoffDelay(attempt));
          continue;
        }

        throw new ProviderError(
          `Network error: ${lastError.message}`,
          PROVIDER_ID,
          { cause: lastError.message },
        );
      }
    }

    throw lastError ?? new ProviderError('Max retries exceeded', PROVIDER_ID);
  }

  private parseRetryAfter(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (!header) return undefined;
    const seconds = Number(header);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }

  // -----------------------------------------------------------------------
  // Private: Validation
  // -----------------------------------------------------------------------

  private async ensureValidated(): Promise<void> {
    if (this.validated) return;

    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new ProviderError('Anthropic API key is empty', PROVIDER_ID);
    }

    // Basic format check — Anthropic keys start with 'sk-ant-'
    if (!this.apiKey.startsWith('sk-ant-') && !this.apiKey.startsWith('sk-')) {
      throw new ProviderError(
        'Invalid Anthropic API key format: expected key starting with "sk-ant-"',
        PROVIDER_ID,
      );
    }

    this.validated = true;
  }

  // -----------------------------------------------------------------------
  // Private: Cost estimation
  // -----------------------------------------------------------------------

  private estimateCost(model: string, usage: TokenUsage): number | undefined {
    const info = ANTHROPIC_MODELS.find((m) => m.id === model);
    if (!info?.inputCostPer1k || !info.outputCostPer1k) return undefined;

    const inputCost = (usage.inputTokens / 1000) * info.inputCostPer1k;
    const outputCost = (usage.outputTokens / 1000) * info.outputCostPer1k;
    return inputCost + outputCost;
  }

  private getDefaultMaxTokens(model: string): number {
    const info = ANTHROPIC_MODELS.find((m) => m.id === model);
    return info?.maxOutputTokens ?? 4_096;
  }
}
