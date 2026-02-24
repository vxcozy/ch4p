/**
 * Google AI provider for ch4p.
 * Uses the Gemini API with streaming support.
 *
 * Communicates directly with https://generativelanguage.googleapis.com/v1beta
 * via fetch(). Supports NDJSON-based streaming, function calling, abort signals,
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

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_RETRIES = 3;
const PROVIDER_ID = 'google';
const PROVIDER_NAME = 'Google AI';

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

const GOOGLE_MODELS: ModelInfo[] = [
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.0001,
    outputCostPer1k: 0.0004,
  },
  {
    id: 'gemini-2.0-flash-lite',
    name: 'Gemini 2.0 Flash Lite',
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.000075,
    outputCostPer1k: 0.0003,
  },
  {
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    contextWindow: 2_097_152,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.005,
  },
  {
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    inputCostPer1k: 0.000075,
    outputCostPer1k: 0.0003,
  },
];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface GoogleProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Gemini API types (internal)
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiSystemInstruction {
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

interface GeminiGenerationConfig {
  maxOutputTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: GeminiSystemInstruction;
  generationConfig?: GeminiGenerationConfig;
  tools?: GeminiTool[];
}

interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

interface GeminiCandidate {
  content: { role: string; parts: GeminiPart[] };
  finishReason?: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER' | null;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class GoogleProvider implements IProvider {
  readonly id = PROVIDER_ID;
  readonly name = PROVIDER_NAME;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private validated = false;

  constructor(config: GoogleProviderConfig) {
    if (!config.apiKey) {
      throw new ProviderError('Google AI API key is required', PROVIDER_ID);
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? API_BASE).replace(/\/+$/, '');
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
  }

  // -----------------------------------------------------------------------
  // IProvider.listModels
  // -----------------------------------------------------------------------

  async listModels(): Promise<ModelInfo[]> {
    return GOOGLE_MODELS;
  }

  // -----------------------------------------------------------------------
  // IProvider.supportsTools
  // -----------------------------------------------------------------------

  supportsTools(model: string): boolean {
    const info = GOOGLE_MODELS.find((m) => m.id === model);
    return info?.supportsTools ?? model.startsWith('gemini-');
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

    const body = this.buildRequestBody(context, opts);
    const response = await this.fetchWithRetry(model, 'streamGenerateContent', body, opts?.signal);

    if (!response.body) {
      throw new ProviderError('No response body for stream', PROVIDER_ID);
    }

    // State accumulators
    let fullText = '';
    const toolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    // Parse NDJSON from the response body.
    // Gemini streams an array of JSON objects: the response starts with "[",
    // each chunk is separated by commas, and ends with "]".
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

        // Extract complete JSON objects from the streamed array.
        // The stream format is: [ {...}, {...}, ... ]
        // We parse by finding balanced braces at the top level.
        const chunks = this.extractJsonChunks(buffer);
        buffer = chunks.remaining;

        for (const chunk of chunks.parsed) {
          const geminiResponse = chunk as GeminiResponse;
          const events = this.processStreamChunk(geminiResponse, fullText, toolCalls, usage);

          for (const streamEvent of events) {
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

    const body = this.buildRequestBody(context, opts);
    const response = await this.fetchWithRetry(model, 'generateContent', body, opts?.signal);
    const json = (await response.json()) as GeminiResponse;

    if (!json.candidates?.length) {
      throw new ProviderError('No candidates in response', PROVIDER_ID);
    }

    const candidate = json.candidates[0]!;
    const message = this.mapCandidateToMessage(candidate);
    const usage = this.mapUsage(json.usageMetadata);
    const finishReason = this.mapFinishReason(candidate.finishReason);

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
    context: Message[],
    opts: StreamOpts | undefined,
  ): GeminiRequestBody {
    const { systemInstruction, contents } = this.extractSystemAndContents(context, opts?.systemPrompt);

    const body: GeminiRequestBody = {
      contents,
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    // Generation config
    const generationConfig: GeminiGenerationConfig = {};
    let hasGenConfig = false;

    if (opts?.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = opts.maxTokens;
      hasGenConfig = true;
    }
    if (opts?.temperature !== undefined) {
      generationConfig.temperature = opts.temperature;
      hasGenConfig = true;
    }
    if (opts?.stopSequences?.length) {
      generationConfig.stopSequences = opts.stopSequences;
      hasGenConfig = true;
    }

    if (hasGenConfig) {
      body.generationConfig = generationConfig;
    }

    // Tools
    if (opts?.tools?.length) {
      body.tools = [{
        functionDeclarations: opts.tools.map((t) => this.mapToolDefinition(t)),
      }];
    }

    return body;
  }

  /**
   * Extract system prompt from messages or opts. Gemini uses a separate
   * "systemInstruction" field instead of a message role.
   */
  private extractSystemAndContents(
    context: Message[],
    systemPromptOpt?: string,
  ): { systemInstruction: GeminiSystemInstruction | undefined; contents: GeminiContent[] } {
    let systemText = systemPromptOpt;
    const contents: GeminiContent[] = [];

    for (const msg of context) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        systemText = systemText ? `${systemText}\n\n${text}` : text;
      } else {
        const mapped = this.mapMessage(msg);
        if (mapped) {
          contents.push(mapped);
        }
      }
    }

    const systemInstruction = systemText
      ? { parts: [{ text: systemText }] }
      : undefined;

    return { systemInstruction, contents };
  }

  private mapMessage(msg: Message): GeminiContent | null {
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';

    // Tool result messages: sent as user messages with functionResponse parts
    if (msg.role === 'tool') {
      if (!msg.toolCallId) return null;

      // We need the tool name for functionResponse. Extract from toolCallId
      // or use a generic name. The caller should provide meaningful content.
      const responseContent = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseContent);
      } catch {
        parsed = { result: responseContent };
      }

      return {
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.toolCallId,
            response: parsed,
          },
        }],
      };
    }

    const parts: GeminiPart[] = [];

    // Map content
    if (typeof msg.content === 'string') {
      if (msg.content) {
        parts.push({ text: msg.content });
      }
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const part = this.mapContentBlockToPart(block);
        if (part) {
          parts.push(part);
        }
      }
    }

    // Append function call parts for tool calls (assistant/model messages)
    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        parts.push({
          functionCall: {
            name: tc.name,
            args: (typeof tc.args === 'object' && tc.args !== null
              ? tc.args
              : {}) as Record<string, unknown>,
          },
        });
      }
    }

    if (parts.length === 0) {
      // Gemini requires at least one part; use empty text
      parts.push({ text: '' });
    }

    return { role, parts };
  }

  private mapContentBlockToPart(block: ContentBlock): GeminiPart | null {
    switch (block.type) {
      case 'text':
        return { text: block.text ?? '' };

      case 'image':
        if (block.imageUrl?.startsWith('data:')) {
          const match = block.imageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            return {
              inlineData: {
                mimeType: match[1]!,
                data: match[2]!,
              },
            };
          }
        }
        // For URL images, Gemini expects inline data — callers must pre-encode
        return { text: `[Image: ${block.imageUrl ?? 'unknown'}]` };

      case 'tool_use':
        return {
          functionCall: {
            name: block.toolName ?? '',
            args: (typeof block.toolInput === 'object' && block.toolInput !== null
              ? block.toolInput
              : {}) as Record<string, unknown>,
          },
        };

      case 'tool_result': {
        let parsed: unknown;
        try {
          parsed = JSON.parse(block.toolOutput ?? '{}');
        } catch {
          parsed = { result: block.toolOutput ?? '' };
        }
        return {
          functionResponse: {
            name: block.toolCallId ?? '',
            response: parsed,
          },
        };
      }

      default:
        return block.text ? { text: block.text } : null;
    }
  }

  private mapToolDefinition(tool: ToolDefinition): GeminiFunctionDeclaration {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  // -----------------------------------------------------------------------
  // Private: Response mapping
  // -----------------------------------------------------------------------

  private mapCandidateToMessage(candidate: GeminiCandidate): Message {
    const content: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    if (candidate.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text !== undefined) {
          content.push({ type: 'text', text: part.text });
        } else if (part.functionCall) {
          const id = generateId();
          content.push({
            type: 'tool_use',
            toolCallId: id,
            toolName: part.functionCall.name,
            toolInput: part.functionCall.args,
          });
          toolCalls.push({
            id,
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
          });
        }
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

  private mapUsage(usage: GeminiUsageMetadata | undefined): TokenUsage {
    if (!usage) {
      return { inputTokens: 0, outputTokens: 0 };
    }
    return {
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
    };
  }

  private mapFinishReason(
    reason: string | null | undefined,
  ): CompletionResult['finishReason'] {
    switch (reason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'max_tokens';
      case 'SAFETY':
      case 'RECITATION':
      case 'OTHER':
        return 'error';
      default:
        return 'stop';
    }
  }

  // -----------------------------------------------------------------------
  // Private: Stream chunk processing
  // -----------------------------------------------------------------------

  private processStreamChunk(
    chunk: GeminiResponse,
    currentText: string,
    toolCalls: Map<string, { name: string; args: Record<string, unknown> }>,
    currentUsage: TokenUsage,
  ): StreamEvent[] {
    const events: StreamEvent[] = [];

    if (chunk.candidates?.length) {
      const candidate = chunk.candidates[0]!;

      if (candidate.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.text !== undefined) {
            const newText = currentText + part.text;
            events.push({
              type: 'text_delta',
              delta: part.text,
              partial: newText,
            });
          } else if (part.functionCall) {
            const id = generateId();
            const name = part.functionCall.name;
            const args = part.functionCall.args ?? {};

            toolCalls.set(id, { name, args });

            events.push({ type: 'tool_call_start', id, name });

            const argsJson = JSON.stringify(args);
            events.push({ type: 'tool_call_delta', id, argsDelta: argsJson });
            events.push({ type: 'tool_call_end', id, args });
          }
        }
      }
    }

    if (chunk.usageMetadata) {
      const mapped = this.mapUsage(chunk.usageMetadata);
      Object.assign(currentUsage, mapped);
      events.push({ type: 'usage', usage: { ...mapped } });
    }

    return events;
  }

  /**
   * Extract complete JSON objects from the Gemini streaming format.
   * Gemini streams a JSON array: [ {...}, {...}, ... ]
   * We track brace depth to extract each top-level object.
   */
  private extractJsonChunks(buffer: string): {
    parsed: Record<string, unknown>[];
    remaining: string;
  } {
    const parsed: Record<string, unknown>[] = [];
    let depth = 0;
    let objectStart = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i]!;

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') {
        if (depth === 0) {
          objectStart = i;
        }
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && objectStart >= 0) {
          const jsonStr = buffer.slice(objectStart, i + 1);
          try {
            const obj = JSON.parse(jsonStr) as Record<string, unknown>;
            parsed.push(obj);
          } catch {
            // Skip malformed chunks
          }
          objectStart = -1;
        }
      }
    }

    // Keep the incomplete portion in the buffer
    const remaining = objectStart >= 0 ? buffer.slice(objectStart) : '';
    return { parsed, remaining };
  }

  // -----------------------------------------------------------------------
  // Private: Assembled message from stream
  // -----------------------------------------------------------------------

  private buildAssembledMessage(
    text: string,
    toolCallMap: Map<string, { name: string; args: Record<string, unknown> }>,
  ): Message {
    const content: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    if (text) {
      content.push({ type: 'text', text });
    }

    for (const [id, tc] of toolCallMap) {
      content.push({
        type: 'tool_use',
        toolCallId: id,
        toolName: tc.name,
        toolInput: tc.args,
      });
      toolCalls.push({ id, name: tc.name, args: tc.args });
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
    model: string,
    method: 'generateContent' | 'streamGenerateContent',
    body: GeminiRequestBody,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: Error | undefined;

    // For streaming, append alt=sse to get server-sent events (NDJSON)
    const queryParams = method === 'streamGenerateContent'
      ? `?key=${this.apiKey}&alt=sse`
      : `?key=${this.apiKey}`;

    const url = `${this.baseUrl}/models/${model}:${method}${queryParams}`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new ProviderError('Request aborted', PROVIDER_ID);
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
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
        if (status === 401 || status === 403) {
          this.validated = false;
          throw new ProviderError(
            'Authentication failed: invalid API key',
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

        // Server errors — retry
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
      throw new ProviderError('Google AI API key is empty', PROVIDER_ID);
    }

    // Gemini API keys are typically AIza-prefixed strings
    if (!this.apiKey.startsWith('AIza')) {
      throw new ProviderError(
        'Invalid Google AI API key format: expected key starting with "AIza"',
        PROVIDER_ID,
      );
    }

    this.validated = true;
  }

  // -----------------------------------------------------------------------
  // Private: Cost estimation
  // -----------------------------------------------------------------------

  private estimateCost(model: string, usage: TokenUsage): number | undefined {
    const info = GOOGLE_MODELS.find((m) => m.id === model);
    if (!info?.inputCostPer1k || !info.outputCostPer1k) return undefined;

    const inputCost = (usage.inputTokens / 1000) * info.inputCostPer1k;
    const outputCost = (usage.outputTokens / 1000) * info.outputCostPer1k;
    return inputCost + outputCost;
  }
}
