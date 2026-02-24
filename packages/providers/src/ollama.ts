/**
 * Ollama provider for ch4p — local model execution.
 * Uses the Ollama REST API with NDJSON streaming.
 *
 * Communicates with a local Ollama server (default http://localhost:11434).
 * No API key required. Model availability is dynamic via /api/tags.
 * Tool support depends on the individual model.
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
import { ProviderError, generateId } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://localhost:11434';
const PROVIDER_ID = 'ollama';
const PROVIDER_NAME = 'Ollama';

// Models known to support tool calling via Ollama
const TOOL_CAPABLE_MODELS = new Set([
  'llama3.1',
  'llama3.2',
  'llama3.3',
  'qwen2.5',
  'qwen2.5-coder',
  'mistral',
  'mixtral',
  'command-r',
  'command-r-plus',
  'nemotron',
  'granite3-dense',
  'granite3-moe',
]);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OllamaProviderConfig {
  baseUrl?: string;
  defaultModel?: string;
}

// ---------------------------------------------------------------------------
// Ollama API types (internal)
// ---------------------------------------------------------------------------

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: {
    temperature?: number;
    stop?: string[];
    num_predict?: number;
  };
  tools?: OllamaTool[];
}

interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  done_reason?: string;
}

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    modified_at: string;
    size: number;
    digest: string;
    details: {
      parent_model?: string;
      format: string;
      family: string;
      families?: string[];
      parameter_size: string;
      quantization_level: string;
    };
  }>;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class OllamaProvider implements IProvider {
  readonly id = PROVIDER_ID;
  readonly name = PROVIDER_NAME;

  private readonly baseUrl: string;

  constructor(config?: OllamaProviderConfig) {
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  // -----------------------------------------------------------------------
  // IProvider.listModels
  // -----------------------------------------------------------------------

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new ProviderError(
          `Failed to list models: ${response.status}`,
          PROVIDER_ID,
        );
      }

      const data = (await response.json()) as OllamaTagsResponse;

      return data.models.map((m) => {
        const baseName = m.name.split(':')[0] ?? m.name;
        return {
          id: m.name,
          name: m.name,
          contextWindow: this.estimateContextWindow(m.details.parameter_size),
          maxOutputTokens: 4_096,
          supportsTools: this.modelSupportsTools(baseName),
          supportsVision: this.modelSupportsVision(m.details.families),
        };
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;

      throw new ProviderError(
        `Cannot connect to Ollama at ${this.baseUrl}. Is the Ollama server running?`,
        PROVIDER_ID,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  // -----------------------------------------------------------------------
  // IProvider.supportsTools
  // -----------------------------------------------------------------------

  supportsTools(model: string): boolean {
    const baseName = model.split(':')[0] ?? model;
    return this.modelSupportsTools(baseName);
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
    const body = this.buildRequestBody(model, context, opts, true);
    const response = await this.doFetch(body, opts?.signal);

    if (!response.body) {
      throw new ProviderError('No response body for stream', PROVIDER_ID);
    }

    let fullText = '';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls: ToolCall[] = [];

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
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk: OllamaChatResponse;
          try {
            chunk = JSON.parse(trimmed);
          } catch {
            continue;
          }

          // Text content
          if (chunk.message?.content) {
            fullText += chunk.message.content;
            yield {
              type: 'text_delta',
              delta: chunk.message.content,
              partial: fullText,
            };
          }

          // Tool calls (emitted with the final chunk or as they arrive)
          if (chunk.message?.tool_calls?.length) {
            for (const tc of chunk.message.tool_calls) {
              const id = generateId();
              const name = tc.function.name;
              const args = tc.function.arguments;

              toolCalls.push({ id, name, args });

              yield { type: 'tool_call_start', id, name };
              yield {
                type: 'tool_call_delta',
                id,
                argsDelta: JSON.stringify(args),
              };
              yield { type: 'tool_call_end', id, args };
            }
          }

          // Final chunk with done = true carries usage stats
          if (chunk.done) {
            usage = {
              inputTokens: chunk.prompt_eval_count ?? 0,
              outputTokens: chunk.eval_count ?? 0,
            };
            yield { type: 'usage', usage: { ...usage } };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Build assembled message
    const content: ContentBlock[] = [];
    if (fullText) {
      content.push({ type: 'text', text: fullText });
    }
    for (const tc of toolCalls) {
      content.push({
        type: 'tool_use',
        toolCallId: tc.id,
        toolName: tc.name,
        toolInput: tc.args,
      });
    }

    const assembledMessage: Message = {
      role: 'assistant',
      content: content.length === 1 && content[0]!.type === 'text'
        ? (content[0]!.text ?? '')
        : content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    yield {
      type: 'done',
      message: assembledMessage,
      usage,
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
    const body = this.buildRequestBody(model, context, opts, false);
    const response = await this.doFetch(body, opts?.signal);
    const json = (await response.json()) as OllamaChatResponse;

    const toolCalls: ToolCall[] = [];
    if (json.message?.tool_calls?.length) {
      for (const tc of json.message.tool_calls) {
        toolCalls.push({
          id: generateId(),
          name: tc.function.name,
          args: tc.function.arguments,
        });
      }
    }

    const textContent = json.message?.content ?? '';
    const content: ContentBlock[] = [];
    if (textContent) {
      content.push({ type: 'text', text: textContent });
    }
    for (const tc of toolCalls) {
      content.push({
        type: 'tool_use',
        toolCallId: tc.id,
        toolName: tc.name,
        toolInput: tc.args,
      });
    }

    const message: Message = {
      role: 'assistant',
      content: content.length === 1 && content[0]!.type === 'text'
        ? (content[0]!.text ?? '')
        : content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    const usage: TokenUsage = {
      inputTokens: json.prompt_eval_count ?? 0,
      outputTokens: json.eval_count ?? 0,
    };

    const finishReason: CompletionResult['finishReason'] =
      toolCalls.length > 0
        ? 'tool_use'
        : json.done_reason === 'length'
          ? 'max_tokens'
          : 'stop';

    return { message, usage, finishReason };
  }

  // -----------------------------------------------------------------------
  // Private: Request building
  // -----------------------------------------------------------------------

  private buildRequestBody(
    model: string,
    context: Message[],
    opts: StreamOpts | undefined,
    stream: boolean,
  ): OllamaChatRequest {
    const messages = context.map((m) => this.mapMessage(m));

    // Prepend system prompt if provided
    if (opts?.systemPrompt) {
      messages.unshift({
        role: 'system',
        content: opts.systemPrompt,
      });
    }

    const body: OllamaChatRequest = {
      model,
      messages,
      stream,
    };

    // Options
    const options: OllamaChatRequest['options'] = {};
    if (opts?.temperature !== undefined) options.temperature = opts.temperature;
    if (opts?.stopSequences?.length) options.stop = opts.stopSequences;
    if (opts?.maxTokens) options.num_predict = opts.maxTokens;

    if (Object.keys(options).length > 0) {
      body.options = options;
    }

    // Tools
    if (opts?.tools?.length && this.supportsTools(model)) {
      body.tools = opts.tools.map((t) => this.mapToolDefinition(t));
    }

    return body;
  }

  private mapMessage(msg: Message): OllamaMessage {
    // System messages
    if (msg.role === 'system') {
      return {
        role: 'system',
        content: typeof msg.content === 'string' ? msg.content : '',
      };
    }

    // Tool result messages
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      };
    }

    // User messages
    if (msg.role === 'user') {
      const result: OllamaMessage = {
        role: 'user',
        content: '',
      };

      if (typeof msg.content === 'string') {
        result.content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const images: string[] = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text ?? '');
          } else if (block.type === 'image' && block.imageUrl) {
            // Ollama expects raw base64 (no data URI prefix)
            const match = block.imageUrl.match(/^data:[^;]+;base64,(.+)$/);
            if (match) {
              images.push(match[1]!);
            } else {
              images.push(block.imageUrl);
            }
          }
        }

        result.content = textParts.join('\n');
        if (images.length > 0) {
          result.images = images;
        }
      }

      return result;
    }

    // Assistant messages
    const result: OllamaMessage = {
      role: 'assistant',
      content: typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content)
            ? msg.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join('')
            : ''),
    };

    if (msg.toolCalls?.length) {
      result.tool_calls = msg.toolCalls.map((tc) => ({
        function: {
          name: tc.name,
          arguments:
            typeof tc.args === 'object' && tc.args !== null
              ? (tc.args as Record<string, unknown>)
              : {},
        },
      }));
    }

    return result;
  }

  private mapToolDefinition(tool: ToolDefinition): OllamaTool {
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
  // Private: HTTP transport
  // -----------------------------------------------------------------------

  private async doFetch(
    body: OllamaChatRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new ProviderError(
          `Ollama API error: ${response.status} ${errorBody}`,
          PROVIDER_ID,
          { status: response.status, body: errorBody },
        );
      }

      return response;
    } catch (err) {
      if (err instanceof ProviderError) throw err;

      throw new ProviderError(
        `Cannot connect to Ollama at ${this.baseUrl}. Is the Ollama server running?`,
        PROVIDER_ID,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  // -----------------------------------------------------------------------
  // Private: Heuristics
  // -----------------------------------------------------------------------

  private modelSupportsTools(baseName: string): boolean {
    for (const known of TOOL_CAPABLE_MODELS) {
      if (baseName.startsWith(known)) return true;
    }
    return false;
  }

  private modelSupportsVision(families?: string[]): boolean {
    if (!families) return false;
    return families.some((f) => f === 'clip' || f === 'llava');
  }

  private estimateContextWindow(parameterSize: string): number {
    // Parse parameter size like "7B", "13B", "70B"
    const match = parameterSize.match(/^([\d.]+)([BM])/i);
    if (!match) return 4_096;

    const size = parseFloat(match[1]!);
    const unit = match[2]!.toUpperCase();
    const params = unit === 'B' ? size : size / 1000;

    if (params >= 70) return 128_000;
    if (params >= 13) return 32_768;
    if (params >= 7) return 8_192;
    return 4_096;
  }
}
