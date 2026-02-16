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
} from '@ch4p/core';
import { EngineError, generateId } from '@ch4p/core';
import { spawn, type ChildProcess } from 'node:child_process';

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

    // Build command arguments.
    const args = [...this.baseArgs];

    if (job.systemPrompt) {
      args.push('--system-prompt', job.systemPrompt);
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

      // Stream stdout as text deltas.
      if (child.stdout) {
        for await (const chunk of child.stdout) {
          if (abortController.signal.aborted) break;

          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          fullAnswer += text;
          yield emit({ type: 'text_delta', delta: text });
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

      yield emit({
        type: 'completed',
        answer: fullAnswer.trim(),
      });
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
  // Private: prompt extraction
  // -----------------------------------------------------------------------

  private extractPrompt(job: Job): string {
    // Find the last user message.
    for (let i = job.messages.length - 1; i >= 0; i--) {
      const msg = job.messages[i]!;
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          return msg.content;
        }
        // Extract text from content blocks.
        if (Array.isArray(msg.content)) {
          return msg.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n');
        }
      }
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
