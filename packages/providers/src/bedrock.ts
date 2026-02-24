/**
 * AWS Bedrock provider for ch4p.
 * Uses the Bedrock Converse API with streaming support.
 *
 * Communicates directly with https://bedrock-runtime.{region}.amazonaws.com
 * via fetch(). Implements AWS Signature V4 signing manually using node:crypto
 * with zero external dependencies. Supports event-stream-based streaming,
 * tool use, abort signals, and automatic retry with exponential backoff.
 */

import { createHmac, createHash } from 'node:crypto';
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

const MAX_RETRIES = 3;
const PROVIDER_ID = 'bedrock';
const PROVIDER_NAME = 'AWS Bedrock';
const AWS_SERVICE = 'bedrock';

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

const BEDROCK_MODELS: ModelInfo[] = [
  {
    id: 'anthropic.claude-sonnet-4-20250514-v1:0',
    name: 'Claude Sonnet 4 (Bedrock)',
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
  },
  {
    id: 'anthropic.claude-3-5-haiku-20241022-v1:0',
    name: 'Claude 3.5 Haiku (Bedrock)',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.004,
  },
  {
    id: 'amazon.nova-pro-v1:0',
    name: 'Amazon Nova Pro',
    contextWindow: 300_000,
    maxOutputTokens: 5_000,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.0032,
  },
  {
    id: 'amazon.nova-lite-v1:0',
    name: 'Amazon Nova Lite',
    contextWindow: 300_000,
    maxOutputTokens: 5_000,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.00006,
    outputCostPer1k: 0.00024,
  },
  {
    id: 'meta.llama3-3-70b-instruct-v1:0',
    name: 'Llama 3.3 70B Instruct',
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    supportsTools: true,
    supportsVision: false,
    inputCostPer1k: 0.00072,
    outputCostPer1k: 0.00072,
  },
];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BedrockProviderConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  baseUrl?: string;
  defaultModel?: string;
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Bedrock Converse API types (internal)
// ---------------------------------------------------------------------------

interface BedrockContentBlock {
  text?: string;
  image?: {
    format: string;
    source: { bytes: string };
  };
  toolUse?: {
    toolUseId: string;
    name: string;
    input: unknown;
  };
  toolResult?: {
    toolUseId: string;
    content: Array<{ text?: string }>;
    status?: 'success' | 'error';
  };
}

interface BedrockMessage {
  role: 'user' | 'assistant';
  content: BedrockContentBlock[];
}

interface BedrockToolSpec {
  name: string;
  description: string;
  inputSchema: { json: Record<string, unknown> };
}

interface BedrockRequestBody {
  messages: BedrockMessage[];
  system?: Array<{ text: string }>;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    stopSequences?: string[];
  };
  toolConfig?: {
    tools: Array<{ toolSpec: BedrockToolSpec }>;
  };
}

interface BedrockResponseUsage {
  inputTokens: number;
  outputTokens: number;
}

interface BedrockResponse {
  output: {
    message: {
      role: string;
      content: BedrockContentBlock[];
    };
  };
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: BedrockResponseUsage;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class BedrockProvider implements IProvider {
  readonly id = PROVIDER_ID;
  readonly name = PROVIDER_NAME;

  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly sessionToken?: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private validated = false;

  constructor(config: BedrockProviderConfig) {
    if (!config.region) {
      throw new ProviderError('AWS region is required', PROVIDER_ID);
    }
    if (!config.accessKeyId) {
      throw new ProviderError('AWS access key ID is required', PROVIDER_ID);
    }
    if (!config.secretAccessKey) {
      throw new ProviderError('AWS secret access key is required', PROVIDER_ID);
    }
    this.region = config.region;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.sessionToken = config.sessionToken;
    this.baseUrl = (
      config.baseUrl ?? `https://bedrock-runtime.${config.region}.amazonaws.com`
    ).replace(/\/+$/, '');
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
  }

  // -----------------------------------------------------------------------
  // IProvider.listModels
  // -----------------------------------------------------------------------

  async listModels(): Promise<ModelInfo[]> {
    return BEDROCK_MODELS;
  }

  // -----------------------------------------------------------------------
  // IProvider.supportsTools
  // -----------------------------------------------------------------------

  supportsTools(model: string): boolean {
    const info = BEDROCK_MODELS.find((m) => m.id === model);
    return info?.supportsTools ?? false;
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

    const body = this.buildRequestBody(model, context, opts);
    const path = `/model/${encodeURIComponent(model)}/converse-stream`;
    const response = await this.fetchWithRetry(path, body, opts?.signal);

    if (!response.body) {
      throw new ProviderError('No response body for stream', PROVIDER_ID);
    }

    // State accumulators
    let fullText = '';
    const toolCalls = new Map<string, { name: string; argsJson: string }>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    // Parse Bedrock event stream from the response body.
    // Bedrock uses the AWS event-stream binary protocol, but when accessed
    // via the REST API the response is a sequence of JSON event objects
    // framed with newlines (similar to NDJSON).
    const MAX_SSE_BUFFER = 10 * 1024 * 1024; // 10 MiB — guard against runaway content
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER) {
          throw new ProviderError('Stream buffer exceeded 10 MiB — aborting', this.id);
        }

        // Bedrock event-stream sends binary-framed events. Each event is
        // preceded by headers including `:event-type` and `:content-type`.
        // The payload is JSON. We extract JSON objects from the buffer by
        // looking for top-level `{...}` blocks.
        const events = this.extractJsonObjects(buffer);
        buffer = events.remaining;

        for (const event of events.objects) {
          const streamEvents = this.processStreamEvent(
            event,
            fullText,
            toolCalls,
            usage,
          );
          for (const streamEvent of streamEvents) {
            if (streamEvent.type === 'text_delta') {
              fullText = streamEvent.partial;
            }
            if (streamEvent.type === 'usage') {
              usage = streamEvent.usage;
            }
            yield streamEvent;
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

    const body = this.buildRequestBody(model, context, opts);
    const path = `/model/${encodeURIComponent(model)}/converse`;
    const response = await this.fetchWithRetry(path, body, opts?.signal);
    const json = (await response.json()) as BedrockResponse;

    const message = this.mapResponseToMessage(json);
    const responseUsage = this.mapUsage(json.usage);
    const finishReason = this.mapStopReason(json.stopReason);

    return {
      message,
      usage: responseUsage,
      cost: this.estimateCost(model, responseUsage),
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
  ): BedrockRequestBody {
    const { systemPrompt, messages } = this.extractSystem(context, opts?.systemPrompt);
    const bedrockMessages = this.mergeAdjacentRoles(
      messages.map((m) => this.mapMessage(m)),
    );

    const body: BedrockRequestBody = {
      messages: bedrockMessages,
    };

    if (systemPrompt) {
      body.system = [{ text: systemPrompt }];
    }

    const inferenceConfig: BedrockRequestBody['inferenceConfig'] = {};
    const maxTokens = opts?.maxTokens ?? this.getDefaultMaxTokens(model);
    inferenceConfig.maxTokens = maxTokens;
    if (opts?.temperature !== undefined) inferenceConfig.temperature = opts.temperature;
    if (opts?.stopSequences?.length) inferenceConfig.stopSequences = opts.stopSequences;
    body.inferenceConfig = inferenceConfig;

    if (opts?.tools?.length) {
      body.toolConfig = {
        tools: opts.tools.map((t) => this.mapToolDefinition(t)),
      };
    }

    return body;
  }

  /**
   * Extract system prompt from messages or opts. The Bedrock Converse API
   * takes system as a top-level field, not as a message role.
   */
  private extractSystem(
    context: Message[],
    systemPromptOpt?: string,
  ): { systemPrompt: string | undefined; messages: Message[] } {
    let systemPrompt = systemPromptOpt;
    const messages: Message[] = [];

    for (const msg of context) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
      } else {
        messages.push(msg);
      }
    }

    return { systemPrompt, messages };
  }

  private mapMessage(msg: Message): BedrockMessage {
    const role: 'user' | 'assistant' =
      msg.role === 'tool' ? 'user' : (msg.role as 'user' | 'assistant');

    if (msg.role === 'tool') {
      // Tool results map to user messages with toolResult content blocks
      const blocks: BedrockContentBlock[] = [];
      if (msg.toolCallId) {
        blocks.push({
          toolResult: {
            toolUseId: msg.toolCallId,
            content: [
              {
                text:
                  typeof msg.content === 'string'
                    ? msg.content
                    : JSON.stringify(msg.content),
              },
            ],
          },
        });
      }
      return { role: 'user', content: blocks };
    }

    if (typeof msg.content === 'string' && !msg.toolCalls?.length) {
      return { role, content: [{ text: msg.content }] };
    }

    // Complex content
    const blocks: BedrockContentBlock[] = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        blocks.push(this.mapContentBlock(block));
      }
    } else if (typeof msg.content === 'string' && msg.content) {
      blocks.push({ text: msg.content });
    }

    // Append toolUse blocks for tool calls
    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        blocks.push({
          toolUse: {
            toolUseId: tc.id,
            name: tc.name,
            input: tc.args,
          },
        });
      }
    }

    return { role, content: blocks.length > 0 ? blocks : [{ text: '' }] };
  }

  private mapContentBlock(block: ContentBlock): BedrockContentBlock {
    switch (block.type) {
      case 'text':
        return { text: block.text ?? '' };

      case 'image':
        if (block.imageUrl?.startsWith('data:')) {
          const match = block.imageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const mediaType = match[1]!;
            // Bedrock expects format like 'png', 'jpeg', etc.
            const format = mediaType.split('/')[1] ?? 'png';
            return {
              image: {
                format,
                source: { bytes: match[2]! },
              },
            };
          }
        }
        // For URL images, the API expects base64 -- callers must pre-encode
        return { text: `[Image: ${block.imageUrl ?? 'unknown'}]` };

      case 'tool_use':
        return {
          toolUse: {
            toolUseId: block.toolCallId ?? generateId(),
            name: block.toolName ?? '',
            input: block.toolInput ?? {},
          },
        };

      case 'tool_result':
        return {
          toolResult: {
            toolUseId: block.toolCallId ?? '',
            content: [{ text: block.toolOutput ?? '' }],
          },
        };

      default:
        return { text: block.text ?? '' };
    }
  }

  private mapToolDefinition(
    tool: ToolDefinition,
  ): { toolSpec: BedrockToolSpec } {
    return {
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: { json: tool.parameters },
      },
    };
  }

  /**
   * Bedrock requires that consecutive messages do not share the same role.
   * This merges adjacent messages with the same role by concatenating their
   * content blocks.
   */
  private mergeAdjacentRoles(messages: BedrockMessage[]): BedrockMessage[] {
    const merged: BedrockMessage[] = [];
    for (const msg of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) {
        last.content = [...last.content, ...msg.content];
      } else {
        merged.push({ role: msg.role, content: [...msg.content] });
      }
    }
    return merged;
  }

  // -----------------------------------------------------------------------
  // Private: Response mapping
  // -----------------------------------------------------------------------

  private mapResponseToMessage(response: BedrockResponse): Message {
    const content: ContentBlock[] = [];
    const toolCallsList: ToolCall[] = [];

    for (const block of response.output.message.content) {
      if (block.text !== undefined) {
        content.push({ type: 'text', text: block.text });
      } else if (block.toolUse) {
        content.push({
          type: 'tool_use',
          toolCallId: block.toolUse.toolUseId,
          toolName: block.toolUse.name,
          toolInput: block.toolUse.input,
        });
        toolCallsList.push({
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          args: block.toolUse.input ?? {},
        });
      }
    }

    return {
      role: 'assistant',
      content:
        content.length === 1 && content[0]!.type === 'text'
          ? (content[0]!.text ?? '')
          : content,
      toolCalls: toolCallsList.length > 0 ? toolCallsList : undefined,
    };
  }

  private mapUsage(usage: BedrockResponseUsage): TokenUsage {
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
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
  // Private: Stream event processing
  // -----------------------------------------------------------------------

  /**
   * Extract complete JSON objects from a binary buffer. Bedrock event-stream
   * frames contain JSON payloads that may arrive across chunk boundaries.
   * We search for balanced `{...}` blocks outside of strings.
   */
  private extractJsonObjects(buffer: string): {
    objects: Array<Record<string, unknown>>;
    remaining: string;
  } {
    const objects: Array<Record<string, unknown>> = [];
    let remaining = buffer;

    // Try to find and parse JSON objects from the buffer
    let searchFrom = 0;
    while (searchFrom < remaining.length) {
      const braceStart = remaining.indexOf('{', searchFrom);
      if (braceStart === -1) break;

      // Try parsing increasingly larger substrings from brace start
      let depth = 0;
      let inString = false;
      let escape = false;
      let end = -1;

      for (let i = braceStart; i < remaining.length; i++) {
        const ch = remaining[i]!;

        if (escape) {
          escape = false;
          continue;
        }

        if (ch === '\\' && inString) {
          escape = true;
          continue;
        }

        if (ch === '"') {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }

      if (end === -1) {
        // Incomplete JSON object; keep in buffer
        break;
      }

      const jsonStr = remaining.slice(braceStart, end + 1);
      try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        objects.push(parsed);
      } catch {
        // Not valid JSON; skip past this brace
      }

      searchFrom = end + 1;
    }

    // Keep unprocessed portion
    if (objects.length > 0 && searchFrom > 0) {
      remaining = remaining.slice(searchFrom);
    }

    return { objects, remaining };
  }

  private processStreamEvent(
    event: Record<string, unknown>,
    currentText: string,
    toolCalls: Map<string, { name: string; argsJson: string }>,
    currentUsage: TokenUsage,
  ): StreamEvent[] {
    const events: StreamEvent[] = [];

    // Bedrock Converse stream events are wrapped in typed keys:
    // { contentBlockStart: {...} }, { contentBlockDelta: {...} }, etc.

    if (event.contentBlockStart !== undefined) {
      const start = event.contentBlockStart as Record<string, unknown>;
      const startBlock = start.start as Record<string, unknown> | undefined;
      if (startBlock?.toolUse !== undefined) {
        const toolUse = startBlock.toolUse as Record<string, unknown>;
        const id = toolUse.toolUseId as string;
        const name = toolUse.name as string;
        toolCalls.set(id, { name, argsJson: '' });
        events.push({ type: 'tool_call_start', id, name });
      }
    }

    if (event.contentBlockDelta !== undefined) {
      const deltaWrapper = event.contentBlockDelta as Record<string, unknown>;
      const delta = deltaWrapper.delta as Record<string, unknown> | undefined;
      if (!delta) return events;

      if (delta.text !== undefined) {
        const text = delta.text as string;
        events.push({
          type: 'text_delta',
          delta: text,
          partial: currentText + text,
        });
      } else if (delta.toolUse !== undefined) {
        const toolUseDelta = delta.toolUse as Record<string, unknown>;
        const input = toolUseDelta.input as string | undefined;
        if (input) {
          // Find the last-started tool call
          const lastEntry = [...toolCalls.entries()].pop();
          if (lastEntry) {
            const [id, tc] = lastEntry;
            tc.argsJson += input;
            events.push({ type: 'tool_call_delta', id, argsDelta: input });
          }
        }
      }
    }

    if (event.contentBlockStop !== undefined) {
      // Finalize the last tool call if it has accumulated args JSON
      const lastEntry = [...toolCalls.entries()].pop();
      if (lastEntry) {
        const [id, tc] = lastEntry;
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
    }

    if (event.metadata !== undefined) {
      const metadata = event.metadata as Record<string, unknown>;
      const usageData = metadata.usage as BedrockResponseUsage | undefined;
      if (usageData) {
        const mapped = this.mapUsage(usageData);
        Object.assign(currentUsage, mapped);
        events.push({ type: 'usage', usage: { ...mapped } });
      }
    }

    if (event.messageStart !== undefined) {
      // messageStart carries the role; no action needed
    }

    if (event.messageStop !== undefined) {
      // messageStop carries the stopReason; handled by the done event
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
    const toolCallsList: ToolCall[] = [];

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
      toolCallsList.push({ id, name: tc.name, args: parsedArgs });
    }

    return {
      role: 'assistant',
      content:
        content.length === 1 && content[0]!.type === 'text'
          ? (content[0]!.text ?? '')
          : content,
      toolCalls: toolCallsList.length > 0 ? toolCallsList : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Private: HTTP transport with AWS Signature V4
  // -----------------------------------------------------------------------

  private async fetchWithRetry(
    path: string,
    body: BedrockRequestBody,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new ProviderError('Request aborted', PROVIDER_ID);
      }

      try {
        const url = `${this.baseUrl}${path}`;
        const payload = JSON.stringify(body);
        const headers = this.signRequest('POST', url, payload);

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: payload,
          signal,
        });

        if (response.ok) {
          return response;
        }

        const status = response.status;
        const errorBody = await response.text().catch(() => '');

        // Authentication / authorization errors -- do not retry
        if (status === 401 || status === 403) {
          this.validated = false;
          throw new ProviderError(
            `Authentication failed: ${status === 401 ? 'invalid credentials' : 'access denied'}`,
            PROVIDER_ID,
            { status, body: errorBody },
          );
        }

        // Bad request -- do not retry
        if (status === 400) {
          throw new ProviderError(
            `Bad request: ${errorBody}`,
            PROVIDER_ID,
            { status, body: errorBody },
          );
        }

        // Validation error -- do not retry
        if (status === 422) {
          throw new ProviderError(
            `Validation error: ${errorBody}`,
            PROVIDER_ID,
            { status, body: errorBody },
          );
        }

        // Throttling (429) -- retry with backoff
        if (status === 429) {
          lastError = new ProviderError(
            'Rate limited (throttled)',
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

        // Server errors -- retry
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

        // Other client errors -- do not retry
        throw new ProviderError(
          `API error: ${status} ${errorBody}`,
          PROVIDER_ID,
          { status, body: errorBody },
        );
      } catch (err) {
        if (err instanceof ProviderError) throw err;

        // Network errors -- retry
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
  // Private: AWS Signature V4
  // -----------------------------------------------------------------------

  /**
   * Sign an HTTP request using AWS Signature Version 4.
   * Returns the complete set of headers needed for the request.
   *
   * @see https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
   */
  private signRequest(
    method: string,
    url: string,
    payload: string,
  ): Record<string, string> {
    const parsedUrl = new URL(url);
    const host = parsedUrl.host;
    const path = parsedUrl.pathname;
    const queryString = parsedUrl.search.slice(1); // Remove leading '?'

    const now = new Date();
    const amzDate = this.toAmzDate(now);
    const dateStamp = this.toDateStamp(now);

    const payloadHash = this.sha256Hex(payload);

    // Step 1: Create canonical request
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'host': host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };

    if (this.sessionToken) {
      headers['x-amz-security-token'] = this.sessionToken;
    }

    // Sorted header names
    const signedHeaderNames = Object.keys(headers).sort();
    const signedHeadersStr = signedHeaderNames.join(';');

    const canonicalHeaders = signedHeaderNames
      .map((k) => `${k}:${headers[k]!.trim()}\n`)
      .join('');

    const canonicalRequest = [
      method,
      this.uriEncodePath(path),
      queryString,
      canonicalHeaders,
      signedHeadersStr,
      payloadHash,
    ].join('\n');

    // Step 2: Create string to sign
    const credentialScope = `${dateStamp}/${this.region}/${AWS_SERVICE}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      this.sha256Hex(canonicalRequest),
    ].join('\n');

    // Step 3: Calculate signing key
    const signingKey = this.deriveSigningKey(dateStamp);

    // Step 4: Calculate signature
    const signature = this.hmacSha256Hex(signingKey, stringToSign);

    // Step 5: Build authorization header
    const authorization = [
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeadersStr}`,
      `Signature=${signature}`,
    ].join(', ');

    return {
      ...headers,
      'Authorization': authorization,
    };
  }

  /**
   * Derive the signing key using the HMAC-SHA256 chain:
   *   kDate    = HMAC("AWS4" + secret, dateStamp)
   *   kRegion  = HMAC(kDate, region)
   *   kService = HMAC(kRegion, service)
   *   kSigning = HMAC(kService, "aws4_request")
   */
  private deriveSigningKey(dateStamp: string): Buffer {
    const kDate = this.hmacSha256(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = this.hmacSha256(kDate, this.region);
    const kService = this.hmacSha256(kRegion, AWS_SERVICE);
    const kSigning = this.hmacSha256(kService, 'aws4_request');
    return kSigning;
  }

  /** HMAC-SHA256, returns raw Buffer */
  private hmacSha256(key: string | Buffer, data: string): Buffer {
    return createHmac('sha256', key).update(data, 'utf8').digest();
  }

  /** HMAC-SHA256, returns hex string */
  private hmacSha256Hex(key: Buffer, data: string): string {
    return createHmac('sha256', key).update(data, 'utf8').digest('hex');
  }

  /** SHA-256 hash, returns lowercase hex string */
  private sha256Hex(data: string): string {
    return createHash('sha256').update(data, 'utf8').digest('hex');
  }

  /** Format date as YYYYMMDD'T'HHMMSS'Z' */
  private toAmzDate(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  /** Format date as YYYYMMDD */
  private toDateStamp(date: Date): string {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
  }

  /**
   * URI-encode a path component per AWS rules.
   * Slashes are NOT encoded in the path.
   */
  private uriEncodePath(path: string): string {
    return path
      .split('/')
      .map((segment) =>
        encodeURIComponent(segment).replace(/%2F/gi, '/'),
      )
      .join('/');
  }

  // -----------------------------------------------------------------------
  // Private: Validation
  // -----------------------------------------------------------------------

  private async ensureValidated(): Promise<void> {
    if (this.validated) return;

    if (!this.accessKeyId || this.accessKeyId.trim().length === 0) {
      throw new ProviderError('AWS access key ID is empty', PROVIDER_ID);
    }
    if (!this.secretAccessKey || this.secretAccessKey.trim().length === 0) {
      throw new ProviderError('AWS secret access key is empty', PROVIDER_ID);
    }
    if (!this.region || this.region.trim().length === 0) {
      throw new ProviderError('AWS region is empty', PROVIDER_ID);
    }

    this.validated = true;
  }

  // -----------------------------------------------------------------------
  // Private: Cost estimation
  // -----------------------------------------------------------------------

  private estimateCost(model: string, usage: TokenUsage): number | undefined {
    const info = BEDROCK_MODELS.find((m) => m.id === model);
    if (!info?.inputCostPer1k || !info.outputCostPer1k) return undefined;

    const inputCost = (usage.inputTokens / 1000) * info.inputCostPer1k;
    const outputCost = (usage.outputTokens / 1000) * info.outputCostPer1k;
    return inputCost + outputCost;
  }

  private getDefaultMaxTokens(model: string): number {
    const info = BEDROCK_MODELS.find((m) => m.id === model);
    return info?.maxOutputTokens ?? 4_096;
  }
}
