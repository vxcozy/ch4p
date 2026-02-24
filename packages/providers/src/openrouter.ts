/**
 * OpenRouter provider for ch4p.
 * Uses the OpenRouter API (OpenAI-compatible) with streaming support.
 *
 * Communicates directly with https://openrouter.ai/api/v1/chat/completions
 * via fetch(). OpenRouter is an API aggregator that routes requests to
 * upstream model providers. Supports SSE-based streaming, tool calls,
 * abort signals, and automatic retry with exponential backoff for
 * transient errors.
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
import type { Message, ToolDefinition, ToolCall, ContentBlock } from '@ch4p/core';
import { ProviderError, sleep, backoffDelay } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = 'https://openrouter.ai/api';
const MAX_RETRIES = 3;
const PROVIDER_ID = 'openrouter';
const PROVIDER_NAME = 'OpenRouter';

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

const OPENROUTER_MODELS: ModelInfo[] = [
  {
    id: 'openrouter/auto',
    name: 'OpenRouter Auto',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.0,
    outputCostPer1k: 0.0,
  },
  {
    id: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.0025,
    outputCostPer1k: 0.01,
  },
  {
    id: 'google/gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.0001,
    outputCostPer1k: 0.0004,
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    name: 'Llama 3.3 70B Instruct',
    contextWindow: 131_072,
    maxOutputTokens: 4_096,
    supportsTools: true,
    supportsVision: false,
    inputCostPer1k: 0.0004,
    outputCostPer1k: 0.0004,
  },
  {
    id: 'deepseek/deepseek-chat-v3',
    name: 'DeepSeek Chat v3',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    inputCostPer1k: 0.0003,
    outputCostPer1k: 0.0009,
  },
  {
    id: 'mistralai/mistral-large-latest',
    name: 'Mistral Large',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    inputCostPer1k: 0.002,
    outputCostPer1k: 0.006,
  },
];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OpenRouterProviderConfig {
  apiKey: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  defaultModel?: string;
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// OpenRouter API types (internal, OpenAI-compatible)
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenRouterRequestBody {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
  stream?: boolean;
  tools?: OpenAITool[];
  stream_options?: { include_usage: boolean };
}

interface OpenAIChoice {
  index: number;
  message: OpenAIMessage;
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
  model: string;
}

interface OpenAIStreamDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  choices: Array<{
    index: number;
    delta: OpenAIStreamDelta;
    finish_reason: string | null;
  }>;
  usage?: OpenAIUsage | null;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class OpenRouterProvider implements IProvider {
  readonly id = PROVIDER_ID;
  readonly name = PROVIDER_NAME;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly siteUrl?: string;
  private readonly siteName?: string;
  private readonly maxRetries: number;
  private validated = false;

  constructor(config: OpenRouterProviderConfig) {
    if (!config.apiKey) {
      throw new ProviderError('OpenRouter API key is required', PROVIDER_ID);
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? API_BASE).replace(/\/+$/, '');
    this.siteUrl = config.siteUrl;
    this.siteName = config.siteName;
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
  }

  // -----------------------------------------------------------------------
  // IProvider.listModels
  // -----------------------------------------------------------------------

  async listModels(): Promise<ModelInfo[]> {
    return OPENROUTER_MODELS;
  }

  // -----------------------------------------------------------------------
  // IProvider.supportsTools
  // -----------------------------------------------------------------------

  supportsTools(model: string): boolean {
    const info = OPENROUTER_MODELS.find((m) => m.id === model);
    return info?.supportsTools ?? true;
  }

  // -----------------------------------------------------------------------
  // IProvider.countTokens
  // -----------------------------------------------------------------------

  async countTokens(_model: string, messages: Message[]): Promise<number> {
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
    const toolCallAccumulators = new Map<
      number,
      { id: string; name: string; argsJson: string }
    >();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

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
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          let chunk: OpenAIStreamChunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          for (const choice of chunk.choices) {
            const delta = choice.delta;

            // Text content
            if (delta.content) {
              fullText += delta.content;
              yield {
                type: 'text_delta',
                delta: delta.content,
                partial: fullText,
              };
            }

            // Tool calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                let acc = toolCallAccumulators.get(tc.index);

                if (tc.id && !acc) {
                  // New tool call
                  acc = {
                    id: tc.id,
                    name: tc.function?.name ?? '',
                    argsJson: tc.function?.arguments ?? '',
                  };
                  toolCallAccumulators.set(tc.index, acc);
                  yield { type: 'tool_call_start', id: acc.id, name: acc.name };

                  if (tc.function?.arguments) {
                    yield {
                      type: 'tool_call_delta',
                      id: acc.id,
                      argsDelta: tc.function.arguments,
                    };
                  }
                } else if (acc) {
                  // Continuation
                  if (tc.function?.arguments) {
                    acc.argsJson += tc.function.arguments;
                    yield {
                      type: 'tool_call_delta',
                      id: acc.id,
                      argsDelta: tc.function.arguments,
                    };
                  }
                }
              }
            }

          }

          // Usage info (with stream_options.include_usage)
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            };
            yield { type: 'usage', usage: { ...usage } };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit tool_call_end events
    for (const [, acc] of toolCallAccumulators) {
      let parsedArgs: unknown = {};
      try {
        parsedArgs = JSON.parse(acc.argsJson);
      } catch {
        parsedArgs = acc.argsJson || {};
      }
      yield { type: 'tool_call_end', id: acc.id, args: parsedArgs };
    }

    // Build the final assembled message
    const assembledMessage = this.buildAssembledMessage(fullText, toolCallAccumulators);

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
    const json = (await response.json()) as OpenAIResponse;

    if (!json.choices?.length) {
      throw new ProviderError('No choices in response', PROVIDER_ID);
    }

    const choice = json.choices[0]!;
    const message = this.mapResponseMessage(choice.message);
    const usage = this.mapUsage(json.usage);
    const finishReason = this.mapFinishReason(choice.finish_reason);

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
  ): OpenRouterRequestBody {
    const openaiMessages = context.map((m) => this.mapMessage(m, opts?.systemPrompt));

    // Prepend system prompt if provided and not already in context
    if (opts?.systemPrompt && !context.some((m) => m.role === 'system')) {
      openaiMessages.unshift({
        role: 'system',
        content: opts.systemPrompt,
      });
    }

    const body: OpenRouterRequestBody = {
      model,
      messages: openaiMessages,
      stream,
    };

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts?.stopSequences?.length) body.stop = opts.stopSequences;

    if (opts?.tools?.length && this.supportsTools(model)) {
      body.tools = opts.tools.map((t) => this.mapToolDefinition(t));
    }

    if (stream) {
      body.stream_options = { include_usage: true };
    }

    return body;
  }

  private mapMessage(msg: Message, _systemPrompt?: string): OpenAIMessage {
    // Tool result messages
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        tool_call_id: msg.toolCallId ?? '',
      };
    }

    // System messages pass through
    if (msg.role === 'system') {
      return {
        role: 'system',
        content: typeof msg.content === 'string' ? msg.content : '',
      };
    }

    // Assistant messages
    if (msg.role === 'assistant') {
      const result: OpenAIMessage = {
        role: 'assistant',
        content: null,
      };

      // Text content
      if (typeof msg.content === 'string') {
        result.content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((b) => b.type === 'text');
        if (textParts.length > 0) {
          result.content = textParts.map((b) => b.text ?? '').join('');
        }
      }

      // Tool calls
      if (msg.toolCalls?.length) {
        result.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
          },
        }));
      }

      return result;
    }

    // User messages
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content };
    }

    // User message with content blocks (e.g., images)
    if (Array.isArray(msg.content)) {
      const parts: OpenAIContentPart[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text ?? '' });
        } else if (block.type === 'image' && block.imageUrl) {
          parts.push({
            type: 'image_url',
            image_url: { url: block.imageUrl },
          });
        }
      }
      return { role: 'user', content: parts };
    }

    return { role: 'user', content: '' };
  }

  private mapToolDefinition(tool: ToolDefinition): OpenAITool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Private: Response mapping
  // -----------------------------------------------------------------------

  private mapResponseMessage(msg: OpenAIMessage): Message {
    const toolCalls: ToolCall[] = [];

    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let parsedArgs: unknown = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments);
        } catch {
          parsedArgs = tc.function.arguments;
        }
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          args: parsedArgs,
        });
      }
    }

    // Assistant responses always have string content (or null).
    // The OpenAIContentPart[] form is only used in user messages.
    const rawContent = msg.content;
    const content: string | ContentBlock[] =
      typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent.map((part) =>
              part.type === 'image_url'
                ? { type: 'image' as const, imageUrl: part.image_url?.url }
                : { type: 'text' as const, text: part.text },
            )
          : '';

    return {
      role: 'assistant',
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  private mapUsage(usage: OpenAIUsage): TokenUsage {
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
    };
  }

  private mapFinishReason(
    reason: string | null | undefined,
  ): CompletionResult['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      case 'content_filter':
        return 'error';
      default:
        return 'stop';
    }
  }

  // -----------------------------------------------------------------------
  // Private: Assembled message from stream
  // -----------------------------------------------------------------------

  private buildAssembledMessage(
    text: string,
    toolCallAccumulators: Map<number, { id: string; name: string; argsJson: string }>,
  ): Message {
    const toolCalls: ToolCall[] = [];

    for (const [, acc] of toolCallAccumulators) {
      let parsedArgs: unknown = {};
      try {
        parsedArgs = JSON.parse(acc.argsJson);
      } catch {
        parsedArgs = acc.argsJson || {};
      }
      toolCalls.push({ id: acc.id, name: acc.name, args: parsedArgs });
    }

    return {
      role: 'assistant',
      content: text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Private: HTTP transport
  // -----------------------------------------------------------------------

  private async fetchWithRetry(
    body: OpenRouterRequestBody,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new ProviderError('Request aborted', PROVIDER_ID);
      }

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        };

        // OpenRouter-specific headers for app attribution
        if (this.siteUrl) {
          headers['HTTP-Referer'] = this.siteUrl;
        }
        if (this.siteName) {
          headers['X-Title'] = this.siteName;
        }

        const response = await fetch(
          `${this.baseUrl}/v1/chat/completions`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
          },
        );

        if (response.ok) {
          return response;
        }

        const status = response.status;
        const errorBody = await response.text().catch(() => '');

        // Authentication error
        if (status === 401) {
          this.validated = false;
          throw new ProviderError(
            'Authentication failed: invalid API key',
            PROVIDER_ID,
            { status, body: errorBody },
          );
        }

        // Bad request
        if (status === 400) {
          throw new ProviderError(
            `Bad request: ${errorBody}`,
            PROVIDER_ID,
            { status, body: errorBody },
          );
        }

        // Forbidden (e.g., model not available on current plan)
        if (status === 403) {
          throw new ProviderError(
            `Access denied: ${errorBody}`,
            PROVIDER_ID,
            { status, body: errorBody },
          );
        }

        // Rate limited
        if (status === 429) {
          lastError = new ProviderError(
            'Rate limited',
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

        // Other errors
        throw new ProviderError(
          `API error: ${status} ${errorBody}`,
          PROVIDER_ID,
          { status, body: errorBody },
        );
      } catch (err) {
        if (err instanceof ProviderError) throw err;

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
      throw new ProviderError('OpenRouter API key is empty', PROVIDER_ID);
    }

    if (!this.apiKey.startsWith('sk-or-')) {
      throw new ProviderError(
        'Invalid OpenRouter API key format: expected key starting with "sk-or-"',
        PROVIDER_ID,
      );
    }

    this.validated = true;
  }

  // -----------------------------------------------------------------------
  // Private: Cost estimation
  // -----------------------------------------------------------------------

  private estimateCost(model: string, usage: TokenUsage): number | undefined {
    const info = OPENROUTER_MODELS.find((m) => m.id === model);
    if (!info?.inputCostPer1k || !info.outputCostPer1k) return undefined;

    const inputCost = (usage.inputTokens / 1000) * info.inputCostPer1k;
    const outputCost = (usage.outputTokens / 1000) * info.outputCostPer1k;
    return inputCost + outputCost;
  }
}
