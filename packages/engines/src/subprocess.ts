/**
 * SubprocessEngine — wraps an external CLI tool as an IEngine.
 *
 * Spawns a subprocess (e.g., claude-cli, codex-cli) and communicates
 * via stdin/stdout. Supports text streaming, cancellation via SIGTERM,
 * and basic tool call extraction from structured output.
 *
 * This is a generic base that can wrap any CLI tool that accepts a prompt
 * on stdin and streams responses on stdout.
 *
 * Supported engines:
 *   - claude-cli: Anthropic's Claude CLI (claude)
 *   - codex-cli: OpenAI's Codex CLI (codex)
 *
 * Zero external dependencies — uses Node.js child_process only.
 */

import type {
  IEngine,
  Job,
  RunOpts,
  RunHandle,
  ResumeToken,
  EngineEvent,
  ToolDefinition,
  Message,
} from '@ch4p/core';
import { EngineError, generateId } from '@ch4p/core';
import { spawn, type ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Internal types for tool call parsing
// ---------------------------------------------------------------------------

interface ParsedToolCall {
  id: string;
  tool: string;
  args: unknown;
}

// ---------------------------------------------------------------------------
// Auth-failure detection
// ---------------------------------------------------------------------------

const AUTH_FAILURE_PATTERNS = [
  'not logged in',
  'please run /login',
  'authentication required',
  'unauthorized',
  'auth token expired',
  'invalid api key',
  'invalid auth',
];

/** Check if stderr indicates an authentication/authorization failure. */
export function isAuthFailure(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return AUTH_FAILURE_PATTERNS.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SubprocessEngineConfig {
  /** Engine ID (e.g., 'claude-cli', 'codex-cli'). */
  id: string;
  /** Engine display name (e.g., 'Claude CLI'). */
  name: string;
  /** Path or name of the CLI binary to spawn. */
  command: string;
  /** Arguments to pass to the CLI before the prompt. */
  args?: string[];
  /** Environment variables to set on the subprocess. */
  env?: Record<string, string>;
  /** Maximum time in ms before killing the subprocess. Default: 300000 (5 min). */
  timeout?: number;
  /**
   * How to pass the prompt to the CLI:
   * - 'arg': Pass as a trailing command-line argument (default)
   * - 'stdin': Write to stdin and close
   * - 'flag': Use --prompt "..." flag
   */
  promptMode?: 'arg' | 'stdin' | 'flag';
  /** Flag name for prompt when using 'flag' mode. Default: '--prompt'. */
  promptFlag?: string;
  /** Working directory for the subprocess. */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// SubprocessEngine
// ---------------------------------------------------------------------------

export class SubprocessEngine implements IEngine {
  readonly id: string;
  readonly name: string;

  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly env: Record<string, string>;
  private readonly timeout: number;
  private readonly promptMode: 'arg' | 'stdin' | 'flag';
  private readonly promptFlag: string;
  private readonly cwd?: string;

  constructor(config: SubprocessEngineConfig) {
    if (!config.command) {
      throw new EngineError(
        'SubprocessEngine requires a "command" in config',
        config.id ?? 'subprocess',
      );
    }

    this.id = config.id;
    this.name = config.name;
    this.command = config.command;
    this.baseArgs = config.args ?? [];
    this.env = config.env ?? {};
    this.timeout = config.timeout ?? 300_000;
    this.promptMode = config.promptMode ?? 'arg';
    this.promptFlag = config.promptFlag ?? '--prompt';
    this.cwd = config.cwd;
  }

  // -----------------------------------------------------------------------
  // IEngine.startRun
  // -----------------------------------------------------------------------

  async startRun(job: Job, opts?: RunOpts): Promise<RunHandle> {
    const ref = generateId();
    const abortController = new AbortController();

    if (opts?.signal) {
      if (opts.signal.aborted) {
        abortController.abort(opts.signal.reason);
      } else {
        opts.signal.addEventListener('abort', () => {
          abortController.abort(opts.signal!.reason);
        }, { once: true });
      }
    }

    // Build the prompt from the last user message.
    const prompt = this.extractPrompt(job);

    const events = this.runSubprocess(prompt, ref, job, abortController, opts?.onProgress);

    return {
      ref,
      events,
      cancel: async () => {
        abortController.abort(new EngineError('Run cancelled', this.id));
      },
      steer: (_message: string) => {
        // Subprocess engines don't support mid-run steering.
        // The message is silently ignored.
      },
    };
  }

  // -----------------------------------------------------------------------
  // IEngine.resume
  // -----------------------------------------------------------------------

  async resume(_token: ResumeToken, _prompt: string): Promise<RunHandle> {
    throw new EngineError(
      'SubprocessEngine does not support resume. Start a new run instead.',
      this.id,
    );
  }

  // -----------------------------------------------------------------------
  // Private: subprocess execution
  // -----------------------------------------------------------------------

  private async *runSubprocess(
    prompt: string,
    _ref: string,
    job: Job,
    abortController: AbortController,
    onProgress?: (event: EngineEvent) => void,
  ): AsyncGenerator<EngineEvent, void, undefined> {
    const emit = (event: EngineEvent): EngineEvent => {
      onProgress?.(event);
      return event;
    };

    yield emit({ type: 'started' });

    const hasTools = (job.tools?.length ?? 0) > 0;

    // Build command arguments.
    const args = [...this.baseArgs];

    // System prompt: augmented with tool definitions when tools are present.
    let systemPrompt = job.systemPrompt ?? '';
    if (hasTools) {
      systemPrompt += (systemPrompt ? '\n\n' : '') + this.buildToolPromptSection(job.tools!);
    }
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    switch (this.promptMode) {
      case 'arg':
        args.push(prompt);
        break;
      case 'flag':
        args.push(this.promptFlag, prompt);
        break;
      case 'stdin':
        // Prompt will be written to stdin below.
        break;
    }

    const child = await this.spawnChild(args, abortController.signal);

    try {
      // Capture the exit code promise immediately to avoid missing the
      // 'close' event while we are reading stdout.
      const exitPromise = new Promise<number | null>((resolve) => {
        child.on('close', resolve);
        child.on('error', () => resolve(null));
      });

      // Collect stderr concurrently to prevent pipe-buffer deadlock.
      let stderr = '';
      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer | string) => {
          stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });
      }

      // If stdin mode, write prompt and close. Otherwise close stdin
      // immediately so the subprocess doesn't block waiting for input.
      if (child.stdin) {
        if (this.promptMode === 'stdin') {
          child.stdin.write(prompt);
        }
        child.stdin.end();
      }

      let fullAnswer = '';

      // Stream stdout. When tools are configured we buffer the full output
      // and parse for tool_call blocks after completion. Without tools we
      // emit text_delta events in real-time as today.
      if (child.stdout) {
        for await (const chunk of child.stdout) {
          if (abortController.signal.aborted) break;

          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          fullAnswer += text;

          if (!hasTools) {
            yield emit({ type: 'text_delta', delta: text });
          }
        }
      }

      // Wait for process exit (promise was set up before reading stdout,
      // so we never miss the 'close' event).
      const exitCode = await exitPromise;

      if (exitCode !== 0 && exitCode !== null) {
        // Detect auth failures and produce an actionable, non-retryable error.
        if (stderr && isAuthFailure(stderr)) {
          const hint = this.id === 'claude-cli'
            ? "Run 'claude' in your terminal and use /login to sign in, then try again."
            : this.id === 'codex-cli'
              ? "Run 'codex' in your terminal to authenticate, then try again."
              : `Authenticate with ${this.command}, then try again.`;

          yield emit({
            type: 'error',
            error: new EngineError(
              `${this.name} is not authenticated. ${hint}`,
              this.id,
              undefined,
              false, // non-retryable
            ),
          });
          return;
        }

        yield emit({
          type: 'error',
          error: new EngineError(
            `Subprocess exited with code ${exitCode}${stderr ? ': ' + stderr.slice(0, 500) : ''}`,
            this.id,
          ),
        });
        return;
      }

      // When tools are configured, parse the buffered output for tool calls.
      if (hasTools) {
        const { text, toolCalls } = this.parseToolCalls(fullAnswer);

        // Emit clean text (tool_call blocks stripped).
        if (text) {
          yield emit({ type: 'text_delta', delta: text });
        }

        // Emit tool_start events so the AgentLoop executes each tool.
        for (const tc of toolCalls) {
          yield emit({ type: 'tool_start', id: tc.id, tool: tc.tool, args: tc.args });
        }

        yield emit({ type: 'completed', answer: text });
      } else {
        yield emit({ type: 'completed', answer: fullAnswer.trim() });
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        yield emit({
          type: 'error',
          error: new EngineError('Run was cancelled', this.id),
        });
        return;
      }

      yield emit({
        type: 'error',
        error: err instanceof Error
          ? err
          : new EngineError(String(err), this.id),
      });
    } finally {
      // Ensure process is killed.
      try {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      } catch {
        // Ignore kill errors.
      }
    }
  }

  private spawnChild(
    args: string[],
    signal: AbortSignal,
  ): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      try {
        // Build environment: inherit process.env, apply user overrides,
        // and remove vars that prevent nested CLI sessions (e.g., Claude Code
        // refuses to launch inside another Claude Code session).
        const spawnEnv: Record<string, string | undefined> = {
          ...process.env,
          ...this.env,
        };
        delete spawnEnv['CLAUDECODE'];
        delete spawnEnv['CLAUDE_CODE_SESSION'];

        const child = spawn(this.command, args, {
          env: spawnEnv,
          cwd: this.cwd ?? process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: this.timeout,
        });

        // Handle abort signal.
        const onAbort = () => {
          try {
            child.kill('SIGTERM');
          } catch {
            // Ignore.
          }
        };

        signal.addEventListener('abort', onAbort, { once: true });

        child.on('error', (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(new EngineError(
            `Failed to spawn "${this.command}": ${err.message}`,
            this.id,
          ));
        });

        // Resolve immediately — we'll stream stdout.
        // But first ensure the process actually starts.
        child.on('spawn', () => {
          resolve(child);
        });
      } catch (err) {
        reject(new EngineError(
          `Failed to create subprocess: ${err instanceof Error ? err.message : String(err)}`,
          this.id,
        ));
      }
    });
  }

  // -----------------------------------------------------------------------
  // Private: tool prompt injection
  // -----------------------------------------------------------------------

  /**
   * Generate a system-prompt section that describes available tools and
   * instructs the LLM to output structured `<tool_call>` blocks.
   */
  private buildToolPromptSection(tools: ToolDefinition[]): string {
    const lines: string[] = [];
    lines.push('<available_tools>');
    lines.push('You have access to the following tools. When you need to use a tool, output a tool_call block in EXACTLY this format:');
    lines.push('');
    lines.push('<tool_call>');
    lines.push('{"tool": "TOOL_NAME", "args": {ARGUMENTS_AS_JSON}}');
    lines.push('</tool_call>');
    lines.push('');
    lines.push('Rules:');
    lines.push('- You may include text before and after tool calls.');
    lines.push('- You may make multiple tool calls in a single response.');
    lines.push('- Do NOT wrap <tool_call> blocks in markdown code fences.');
    lines.push('- The JSON inside <tool_call> must be valid JSON with "tool" (string) and "args" (object) keys.');
    lines.push('- After a tool executes you will see its result and can continue.');
    lines.push('');

    for (let i = 0; i < tools.length; i++) {
      const t = tools[i]!;
      lines.push(`${i + 1}. ${t.name}`);
      lines.push(`   Description: ${t.description}`);
      lines.push(`   Parameters: ${JSON.stringify(t.parameters)}`);
      lines.push('');
    }

    lines.push('</available_tools>');
    return lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // Private: tool call parsing
  // -----------------------------------------------------------------------

  /**
   * Extract `<tool_call>` blocks from subprocess output.
   *
   * Returns the clean text (tool blocks removed) and an array of parsed
   * tool calls. Malformed JSON blocks are silently left in the text.
   */
  private parseToolCalls(output: string): { text: string; toolCalls: ParsedToolCall[] } {
    const toolCalls: ParsedToolCall[] = [];
    const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    let text = output;

    // Collect matches first, then remove from text (avoids index shifting).
    const matches: Array<{ full: string; json: string }> = [];
    let match;
    while ((match = regex.exec(output)) !== null) {
      matches.push({ full: match[0], json: match[1]! });
    }

    for (const m of matches) {
      try {
        const parsed = JSON.parse(m.json) as Record<string, unknown>;
        if (typeof parsed.tool === 'string' && parsed.args !== undefined) {
          toolCalls.push({
            id: generateId(),
            tool: parsed.tool,
            args: parsed.args,
          });
          // Remove the matched block from the text output.
          text = text.replace(m.full, '');
        }
      } catch {
        // Malformed JSON — leave the block in text as-is.
      }
    }

    return { text: text.trim(), toolCalls };
  }

  // -----------------------------------------------------------------------
  // Private: prompt extraction
  // -----------------------------------------------------------------------

  private extractPrompt(job: Job): string {
    const userMessages = job.messages.filter((m) => m.role === 'user');
    const hasToolMessages = job.messages.some((m) => m.role === 'tool');

    // Simple case: single user message with no tool history.
    if (userMessages.length <= 1 && !hasToolMessages) {
      const msg = userMessages[0];
      if (!msg) return '';
      return this.extractMessageText(msg);
    }

    // Multi-turn or tool-augmented history — build conversation context.
    const parts: string[] = [];
    parts.push('<conversation_history>');

    for (const msg of job.messages) {
      switch (msg.role) {
        case 'user':
        case 'assistant': {
          const text = this.extractMessageText(msg);
          if (text) {
            const label = msg.role === 'user' ? 'User' : 'Assistant';
            parts.push(`[${label}]: ${text}`);
          }
          // Include tool calls made by the assistant.
          if (msg.role === 'assistant' && msg.toolCalls) {
            for (const tc of msg.toolCalls) {
              parts.push(`[Tool Call: ${tc.name}] ${JSON.stringify(tc.args)}`);
            }
          }
          break;
        }
        case 'tool': {
          const content = this.extractMessageText(msg);
          const toolName = this.findToolName(msg.toolCallId, job.messages);
          parts.push(`[Tool Result${toolName ? ` (${toolName})` : ''}]: ${content}`);
          break;
        }
        // 'system' role is handled via --system-prompt flag.
      }
    }

    parts.push('</conversation_history>');
    parts.push('');
    parts.push('Continue the conversation. Respond to the most recent user message above.');

    return parts.join('\n');
  }

  /** Look up the tool name for a given toolCallId from the conversation. */
  private findToolName(toolCallId: string | undefined, messages: Message[]): string | undefined {
    if (!toolCallId) return undefined;
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        const tc = msg.toolCalls.find((c) => c.id === toolCallId);
        if (tc) return tc.name;
      }
    }
    return undefined;
  }

  /** Extract plain text from a Message's content field. */
  private extractMessageText(msg: { content: string | Array<{ type: string; text?: string }> }): string {
    if (typeof msg.content === 'string') {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
    }
    return '';
  }
}

// ---------------------------------------------------------------------------
// Pre-configured engine factories
// ---------------------------------------------------------------------------

/**
 * Create a Claude CLI engine (wraps the `claude` command).
 *
 * Requires the Anthropic Claude CLI to be installed and configured.
 * See: https://docs.anthropic.com/en/docs/build-with-claude/claude-code
 */
export function createClaudeCliEngine(
  overrides?: Partial<SubprocessEngineConfig>,
): SubprocessEngine {
  return new SubprocessEngine({
    id: 'claude-cli',
    name: 'Claude CLI',
    command: 'claude',
    args: ['--print'],
    promptMode: 'arg',
    timeout: 600_000, // 10 minutes for complex tasks
    ...overrides,
  });
}

/**
 * Create a Codex CLI engine (wraps the `codex` command).
 *
 * Requires the OpenAI Codex CLI to be installed and configured.
 * See: https://github.com/openai/codex
 */
export function createCodexCliEngine(
  overrides?: Partial<SubprocessEngineConfig>,
): SubprocessEngine {
  return new SubprocessEngine({
    id: 'codex-cli',
    name: 'Codex CLI',
    command: 'codex',
    args: ['--quiet'],
    promptMode: 'arg',
    timeout: 600_000,
    ...overrides,
  });
}
