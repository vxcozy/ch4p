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
import type { Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * State stored in a ResumeToken so a SubprocessEngine run can be resumed
 * by reconstructing a new Job with the prior message history + new prompt.
 */
interface SubprocessResumeState {
  sessionId: string;
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
  model?: string;
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

const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'too many requests',
  'usage limit',
  'quota exceeded',
  'try again later',
  'you have exceeded',
  'limit reached',
];

/** Check if stderr indicates a rate limit or usage quota error. */
export function isRateLimit(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => lower.includes(p));
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

    // Shared reference so steer() can write to the child's stdin after it starts.
    const stdinRef: { stream: Writable | null } = { stream: null };

    const events = this.runSubprocess(prompt, ref, job, abortController, opts?.onProgress, stdinRef);

    return {
      ref,
      events,
      cancel: async () => {
        abortController.abort(new EngineError('Run cancelled', this.id));
      },
      steer: (message: string) => {
        if (stdinRef.stream && !stdinRef.stream.destroyed) {
          stdinRef.stream.write(message + '\n');
        }
      },
    };
  }

  // -----------------------------------------------------------------------
  // IEngine.resume
  // -----------------------------------------------------------------------

  async resume(token: ResumeToken, prompt: string): Promise<RunHandle> {
    if (token.engineId !== this.id) {
      throw new EngineError(
        `Resume token is for engine "${token.engineId}", not "${this.id}"`,
        this.id,
      );
    }
    const state = token.state as SubprocessResumeState | undefined;
    if (!state) {
      throw new EngineError('Invalid or missing resume state in token', this.id);
    }
    const job: Job = {
      sessionId: state.sessionId,
      messages: [...(state.messages ?? []), { role: 'user', content: prompt }],
      tools: state.tools,
      systemPrompt: state.systemPrompt,
      model: state.model,
    };
    return this.startRun(job);
  }

  // -----------------------------------------------------------------------
  // Private: subprocess execution
  // -----------------------------------------------------------------------

  private async *runSubprocess(
    prompt: string,
    ref: string,
    job: Job,
    abortController: AbortController,
    onProgress?: (event: EngineEvent) => void,
    stdinRef?: { stream: Writable | null },
  ): AsyncGenerator<EngineEvent, void, undefined> {
    const emit = (event: EngineEvent): EngineEvent => {
      onProgress?.(event);
      return event;
    };

    yield emit({
      type: 'started',
      resumeToken: {
        engineId: this.id,
        ref,
        state: {
          sessionId: job.sessionId,
          messages: job.messages,
          tools: job.tools,
          systemPrompt: job.systemPrompt,
          model: job.model,
        } satisfies SubprocessResumeState,
      },
    });

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
      // Relay stderr as text_delta so permission prompts appear in the channel.
      // Capped at 1 MiB to prevent OOM from verbose subprocess error output.
      const MAX_STDERR = 1_048_576;
      let stderr = '';
      let stderrCapped = false;
      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer | string) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          if (!stderrCapped) {
            stderr += text;
            if (stderr.length > MAX_STDERR) {
              stderr = stderr.slice(0, MAX_STDERR) + '\n[stderr truncated]';
              stderrCapped = true;
            }
          }
          emit({ type: 'text_delta', delta: text });
        });
      }

      // Write prompt to stdin if using stdin mode.
      if (child.stdin) {
        if (this.promptMode === 'stdin') {
          child.stdin.write(prompt);
          // Keep stdin open for steer() permission-prompt responses.
          if (stdinRef) stdinRef.stream = child.stdin;
        } else {
          // For 'arg' and 'flag' modes the prompt is already in the CLI
          // arguments.  Close stdin immediately so CLIs that auto-detect
          // piped input (e.g. `claude --print`) don't block waiting for EOF.
          child.stdin.end();
        }
      }

      // Cap stdout accumulation at 10 MiB. A runaway subprocess that outputs
      // unbounded text would otherwise grow fullAnswer until OOM.
      const MAX_STDOUT = 10_485_760; // 10 MiB
      let stdoutCapped = false;
      let fullAnswer = '';
      let cleanText  = '';
      const parser = new StreamingToolParser();

      // Stream stdout in real-time regardless of whether tools are configured.
      // StreamingToolParser watches for <tool_call>…</tool_call> boundaries and
      // emits text_delta events for all content outside those blocks.
      if (child.stdout) {
        for await (const chunk of child.stdout) {
          if (abortController.signal.aborted) break;

          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          if (!stdoutCapped) {
            fullAnswer += text;
            if (fullAnswer.length > MAX_STDOUT) {
              fullAnswer = fullAnswer.slice(0, MAX_STDOUT) + '\n[stdout truncated]';
              stdoutCapped = true;
            }
          }

          for (const ev of parser.process(text)) {
            if (ev.type === 'text') {
              if (cleanText.length < MAX_STDOUT) cleanText += ev.delta;
              yield emit({ type: 'text_delta', delta: ev.delta });
            } else {
              yield emit({
                type: 'tool_start',
                id: generateId(),
                tool: ev.tool,
                args: ev.args,
              });
            }
          }
        }
        // Flush any partial tag held back during streaming.
        const tail = parser.flush();
        if (tail) {
          cleanText += tail;
          yield emit({ type: 'text_delta', delta: tail });
        }
      }

      // Wait for process exit (promise was set up before reading stdout,
      // so we never miss the 'close' event).
      const exitCode = await exitPromise;

      // Close stdin now that the subprocess has exited.
      if (stdinRef?.stream && !stdinRef.stream.destroyed) {
        stdinRef.stream.end();
        stdinRef.stream = null;
      }

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

        // Detect rate limit / usage quota errors.
        if (stderr && isRateLimit(stderr)) {
          const hint = this.id === 'claude-cli'
            ? "You've hit your Claude usage limit. Wait for it to reset or check usage at claude.ai/settings."
            : this.id === 'codex-cli'
              ? "You've hit your OpenAI usage limit. Check your quota at platform.openai.com."
              : `Rate limit reached for ${this.command}. Please wait before retrying.`;

          yield emit({
            type: 'error',
            error: new EngineError(
              `${this.name} rate limit reached. ${hint}`,
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

      // Events were emitted in real-time by StreamingToolParser during streaming.
      // Emit completion using the clean text (tool_call blocks stripped).
      yield emit({ type: 'completed', answer: cleanText.trim() || fullAnswer.trim() });
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
// StreamingToolParser
// ---------------------------------------------------------------------------

const TOOL_OPEN  = '<tool_call>';
const TOOL_CLOSE = '</tool_call>';

interface StreamingTextEvent  { type: 'text'; delta: string }
interface StreamingToolEvent  { type: 'tool'; tool: string; args: unknown }
type StreamingEvent = StreamingTextEvent | StreamingToolEvent;

/**
 * Incremental parser for the `<tool_call>…</tool_call>` protocol used by
 * SubprocessEngine.  Exported for unit testing.  Accepts arbitrary chunks
 * and emits events in real-time:
 *   - { type: 'text', delta } — safe text outside any tool_call block
 *   - { type: 'tool', tool, args } — a fully parsed tool call
 *
 * Handles partial tag boundaries across chunk splits.  If a chunk ends with
 * the first few characters of `<tool_call>`, those bytes are held back until
 * the next chunk confirms whether they form an opening tag.
 */
/** Maximum bytes accumulated in the tool-call buffer before giving up and emitting as text. */
const MAX_TOOL_BUF = 1_048_576; // 1 MiB

export class StreamingToolParser {
  private state: 'streaming' | 'buffering' = 'streaming';
  /** Partial TOOL_OPEN prefix held back while in streaming mode. */
  private hold = '';
  /** Accumulated content between <tool_call> and </tool_call>. */
  private buf  = '';

  process(chunk: string): StreamingEvent[] {
    const out: StreamingEvent[] = [];
    let remaining = this.hold + chunk;
    this.hold = '';

    while (remaining.length > 0) {
      if (this.state === 'streaming') {
        const idx = remaining.indexOf(TOOL_OPEN);
        if (idx === -1) {
          // No full open tag found — hold back a suffix that could be a
          // partial match (up to TOOL_OPEN.length - 1 bytes).
          const holdLen = longestPrefixMatchingSuffix(remaining, TOOL_OPEN);
          const safe = remaining.slice(0, remaining.length - holdLen);
          if (safe) out.push({ type: 'text', delta: safe });
          this.hold = remaining.slice(remaining.length - holdLen);
          remaining = '';
        } else {
          // Emit text before the tag.
          if (idx > 0) out.push({ type: 'text', delta: remaining.slice(0, idx) });
          remaining = remaining.slice(idx + TOOL_OPEN.length);
          this.state = 'buffering';
          this.buf = '';
        }
      } else {
        // Buffering inside a tool_call block.
        // Search in the combined (buf + remaining) so that the closing tag is
        // found even when it is split across chunk boundaries.
        const combined   = this.buf + remaining;
        const closeIdx   = combined.indexOf(TOOL_CLOSE);
        if (closeIdx === -1) {
          // Guard against runaway output that never closes the tag.
          if (combined.length > MAX_TOOL_BUF) {
            out.push({ type: 'text', delta: TOOL_OPEN + combined });
            this.buf   = '';
            this.state = 'streaming';
            remaining  = '';
          } else {
            this.buf  = combined;
            remaining = '';
          }
        } else {
          const jsonContent = combined.slice(0, closeIdx);
          remaining = combined.slice(closeIdx + TOOL_CLOSE.length);
          try {
            const parsed = JSON.parse(jsonContent.trim()) as Record<string, unknown>;
            if (typeof parsed.tool === 'string' && parsed.args !== undefined) {
              out.push({ type: 'tool', tool: parsed.tool, args: parsed.args });
            } else {
              // Valid JSON but missing expected fields — emit as text.
              out.push({ type: 'text', delta: TOOL_OPEN + jsonContent + TOOL_CLOSE });
            }
          } catch {
            // Malformed JSON — emit the raw block as text so it's visible.
            out.push({ type: 'text', delta: TOOL_OPEN + jsonContent + TOOL_CLOSE });
          }
          this.buf  = '';
          this.state = 'streaming';
        }
      }
    }
    return out;
  }

  /**
   * Call after the stream ends.  Returns any bytes held back or an incomplete
   * tool_call block that never received a closing tag.
   */
  flush(): string {
    if (this.state === 'buffering' && this.buf) {
      return TOOL_OPEN + this.buf;
    }
    return this.hold;
  }
}

/**
 * Returns the length of the longest prefix of `pattern` that matches a
 * suffix of `text`.  Used to determine how many bytes to hold back when
 * we suspect an opening tag is split across two chunks.
 */
export function longestPrefixMatchingSuffix(text: string, pattern: string): number {
  const maxLen = Math.min(text.length, pattern.length - 1);
  for (let len = maxLen; len >= 1; len--) {
    if (text.endsWith(pattern.slice(0, len))) return len;
  }
  return 0;
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
