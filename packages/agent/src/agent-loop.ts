/**
 * AgentLoop — the heart of ch4p's agent runtime.
 *
 * Orchestrates the core loop:
 *
 *   1. Check steering queue (yield point)
 *   2. Send context to engine via startRun()
 *   3. Consume engine events (text_delta, tool_start, tool_end, completed, error)
 *   4. Validate tool call arguments (mandatory step-level validation)
 *   5. Capture state snapshots before/after tool execution
 *   6. Execute requested tool calls
 *   7. Run task-level verification on completion (if verifier configured)
 *   8. Loop until done or aborted
 *
 * Every yield point checks the SteeringQueue for abort / inject / priority /
 * context_update messages. Abort requests terminate the loop immediately.
 * Inject messages prepend user content before the next engine call. Priority
 * messages reorder pending tool executions.
 *
 * AWM (Agent World Model) enhancements:
 *   - Mandatory tool call validation: validate() is always called, with errors
 *     fed back to the LLM as tool error messages so it can self-correct.
 *   - State snapshots: tools implementing getStateSnapshot() have their state
 *     captured before and after execution for diff-based verification.
 *   - Task-level verification: an optional IVerifier runs at completion to
 *     assess outcome quality (format + semantic checks).
 *
 * Events are emitted as an AsyncIterable<AgentEvent> that the caller can
 * consume in a for-await loop.
 */

import type {
  IEngine,
  ITool,
  IObserver,
  IVerifier,
  IMemoryBackend,
  ISecurityPolicy,
  ToolResult,
  ToolContext,
  ToolCall,
  Message,
  ToolDefinition,
  TokenUsage,
  EngineEvent,
  Job,
  RunHandle,
  StateSnapshot,
  VerificationResult,
} from '@ch4p/core';
import { EngineError, ToolError } from '@ch4p/core';
import { abortableSleep, backoffDelay } from '@ch4p/core';
import { setMaxListeners } from 'node:events';

import { homedir } from 'node:os';

import { Session } from './session.js';
import type { ContextManager } from './context.js';
import type { SteeringMessage } from './steering.js';
import { ToolWorkerPool } from './worker-pool.js';

// ---------------------------------------------------------------------------
// Workspace path sanitization
// ---------------------------------------------------------------------------

/**
 * Strip the user's home directory prefix from a workspace path before it is
 * embedded in LLM prompts or tool contexts. This prevents the real home
 * directory path (which may contain a username) from leaking into model
 * context and, by extension, into channel responses.
 *
 * Examples:
 *   /Users/alice/projects/foo  →  ./projects/foo
 *   /home/alice/projects/foo   →  ./projects/foo
 *   /tmp/sandbox               →  /tmp/sandbox  (no change — outside $HOME)
 */
function sanitizeWorkspacePath(cwd: string): string {
  const home = homedir();
  if (cwd === home) return '.';
  if (cwd.startsWith(home + '/')) {
    return './' + cwd.slice(home.length + 1);
  }
  return cwd;
}

// ---------------------------------------------------------------------------
// AgentEvent — the public event stream type
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string; partial: string }
  | { type: 'tool_start'; tool: string; args: unknown }
  | { type: 'tool_progress'; tool: string; update: string }
  | { type: 'tool_end'; tool: string; result: ToolResult }
  | { type: 'tool_validation_error'; tool: string; errors: string[] }
  | { type: 'verification'; result: VerificationResult }
  | { type: 'complete'; answer: string; usage?: TokenUsage }
  | { type: 'error'; error: Error }
  | { type: 'aborted'; reason: string };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AgentLoopOpts {
  /** Maximum loop iterations before forced termination. Default: 50. */
  maxIterations?: number;
  /** Maximum consecutive engine errors before giving up. Default: 3. */
  maxRetries?: number;
  /** Worker pool for heavyweight tool execution (shared across loops). */
  workerPool?: ToolWorkerPool;
  /** Optional task-level verifier. When set, runs after the agent produces
   *  a final answer to assess whether the task was completed correctly. */
  verifier?: IVerifier;
  /** Whether to capture state snapshots for tools that support them.
   *  Default: true. */
  enableStateSnapshots?: boolean;
  /** Optional memory backend. When provided, it is injected into the
   *  ToolContext so memory_store and memory_recall tools can access it. */
  memoryBackend?: IMemoryBackend;
  /** Optional security policy. When provided, tools use it for path/command
   *  validation. When absent, a permissive no-op policy is used. */
  securityPolicy?: ISecurityPolicy;
  /** Extra properties to spread onto the ToolContext. Used to inject
   *  domain-specific state (e.g. canvasState for the canvas tool). */
  toolContextExtensions?: Record<string, unknown>;
  /** Called before the first engine call. Use to inject recalled memories
   *  into the context (e.g. auto-recall from memory backend). */
  onBeforeFirstRun?: (ctx: ContextManager) => Promise<void>;
  /** Called after the run completes successfully. Receives the full context
   *  and final answer for summarization (e.g. auto-store to memory backend). */
  onAfterComplete?: (ctx: ContextManager, answer: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// State snapshot tracking (AWM)
// ---------------------------------------------------------------------------

interface ToolStateRecord {
  tool: string;
  args: unknown;
  before?: StateSnapshot;
  after?: StateSnapshot;
}

// ---------------------------------------------------------------------------
// Permissive fallback security policy (used when none is configured)
// ---------------------------------------------------------------------------

/** Allows all operations — used only when the caller does not provide a
 *  `securityPolicy` option. This ensures backward compatibility while the
 *  security layer is opt-in during development. In production the CLI should
 *  always pass a real `DefaultSecurityPolicy`. */
const PERMISSIVE_POLICY: ISecurityPolicy = {
  autonomyLevel: 'full',
  validatePath: (_path, _op) => ({ allowed: true }),
  validateCommand: (_cmd, _args) => ({ allowed: true }),
  requiresConfirmation: () => false,
  audit: () => [],
  sanitizeOutput: (text) => ({ clean: text, redacted: false }),
  validateInput: () => ({ safe: true, threats: [] }),
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toolDefinitionsFrom(tools: ITool[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as Record<string, unknown>,
  }));
}

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private readonly session: Session;
  private readonly engine: IEngine;
  private readonly tools: Map<string, ITool>;
  private readonly toolDefs: ToolDefinition[];
  private readonly observer: IObserver;
  private readonly opts: Required<Omit<AgentLoopOpts, 'verifier' | 'enableStateSnapshots' | 'memoryBackend' | 'securityPolicy' | 'toolContextExtensions' | 'onBeforeFirstRun' | 'onAfterComplete'>> & {
    verifier?: IVerifier;
    enableStateSnapshots: boolean;
    memoryBackend?: IMemoryBackend;
    securityPolicy?: ISecurityPolicy;
    toolContextExtensions?: Record<string, unknown>;
    onBeforeFirstRun?: (ctx: ContextManager) => Promise<void>;
    onAfterComplete?: (ctx: ContextManager, answer: string) => Promise<void>;
  };

  private abortController: AbortController | null = null;
  private currentHandle: RunHandle | null = null;
  private workerPool: ToolWorkerPool;
  private ownsWorkerPool: boolean;

  /** Accumulated state snapshots for verification (AWM). */
  private stateRecords: ToolStateRecord[] = [];
  /** Accumulated tool results for verification (AWM). */
  private allToolResults: ToolResult[] = [];
  /** Cumulative token usage across all iterations. */
  private cumulativeTokens = { inputTokens: 0, outputTokens: 0 };

  constructor(
    session: Session,
    engine: IEngine,
    tools: ITool[],
    observer: IObserver,
    opts: AgentLoopOpts = {},
  ) {
    this.session = session;
    this.engine = engine;
    this.observer = observer;

    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.toolDefs = toolDefinitionsFrom(tools);

    if (opts.workerPool) {
      this.workerPool = opts.workerPool;
      this.ownsWorkerPool = false;
    } else {
      this.workerPool = new ToolWorkerPool();
      this.ownsWorkerPool = true;
    }

    this.opts = {
      maxIterations: opts.maxIterations ?? 50,
      maxRetries: opts.maxRetries ?? 3,
      workerPool: this.workerPool,
      verifier: opts.verifier,
      enableStateSnapshots: opts.enableStateSnapshots ?? true,
      memoryBackend: opts.memoryBackend,
      securityPolicy: opts.securityPolicy,
      toolContextExtensions: opts.toolContextExtensions,
      onBeforeFirstRun: opts.onBeforeFirstRun,
      onAfterComplete: opts.onAfterComplete,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Return the session ID for this agent loop. */
  getSessionId(): string {
    return this.session.getId();
  }

  /**
   * Run the agent loop, returning an async iterable of AgentEvents.
   * The loop continues until the engine signals completion, the iteration
   * limit is reached, or the run is aborted.
   */
  async *run(initialMessage: string): AsyncIterable<AgentEvent> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // The same signal is passed to every startRun() call in the loop.
    // Each call adds a listener; with maxIterations up to 50 this exceeds
    // the default EventTarget limit of 10. Raise it to avoid the warning.
    try { setMaxListeners(this.opts.maxIterations + 5, signal); } catch { /* ignore */ }

    // Reset AWM tracking state.
    this.stateRecords = [];
    this.allToolResults = [];

    // Activate the session and notify the observer.
    this.session.activate();
    this.observer.onSessionStart({
      sessionId: this.session.getId(),
      channelId: this.session.getConfig().channelId,
      userId: this.session.getConfig().userId,
      engineId: this.session.getConfig().engineId,
      startedAt: new Date(),
    });

    // Seed the context with the user's initial message.
    await this.session.getContext().addMessage({
      role: 'user',
      content: initialMessage,
    });

    // Lifecycle hook: inject recalled memories before the first engine call.
    if (this.opts.onBeforeFirstRun) {
      try {
        await this.opts.onBeforeFirstRun(this.session.getContext());
      } catch {
        // Memory recall failures should never crash the agent loop.
      }
    }

    let iterations = 0;
    let consecutiveErrors = 0;
    let done = false;
    let finalAnswer = '';

    try {
      while (!done && iterations < this.opts.maxIterations) {
        iterations++;
        this.session.recordIteration();

        // ----- Yield point 1: loop boundary -----
        const steeringResult = this.processSteering();
        if (steeringResult.abort) {
          yield { type: 'aborted', reason: steeringResult.abortReason! };
          return;
        }
        // Inject messages were already added to context in processSteering.

        if (signal.aborted) {
          yield { type: 'aborted', reason: 'Signal aborted' };
          return;
        }

        // ----- Send context to engine -----
        const job: Job = {
          sessionId: this.session.getId(),
          messages: this.session.getContext().getMessages(),
          tools: this.toolDefs.length > 0 ? this.toolDefs : undefined,
          systemPrompt: this.session.getConfig().systemPrompt,
          model: this.session.getConfig().model,
        };

        let handle;
        try {
          handle = await this.engine.startRun(job, { signal });
          this.currentHandle = handle;
          this.session.recordLLMCall();
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          consecutiveErrors++;
          this.session.recordError(error);
          this.observer.onError(error, { phase: 'engine_start', iteration: iterations });

          const nonRetryable = error instanceof EngineError && !error.retryable;
          if (nonRetryable || consecutiveErrors >= this.opts.maxRetries) {
            yield { type: 'error', error };
            done = true;
            break;
          }

          // Retry with backoff (abort-aware so cancellation isn't delayed).
          await abortableSleep(backoffDelay(consecutiveErrors), signal);
          continue;
        }

        // Reset consecutive errors on successful engine start.
        consecutiveErrors = 0;

        // ----- Consume engine events -----
        let accumulatedText = '';
        const pendingToolCalls: ToolCall[] = [];
        let completionAnswer: string | undefined;
        let completionUsage: TokenUsage | undefined;
        let engineErrored = false;
        let lastEngineError: Error | undefined;

        try {
          for await (const event of handle.events) {
            if (signal.aborted) {
              await handle.cancel();
              yield { type: 'aborted', reason: 'Signal aborted' };
              return;
            }

            // ----- Yield point 2: between stream chunks -----
            if (this.session.getSteering().hasAbort()) {
              await handle.cancel();
              const reason = this.drainAbortReason();
              yield { type: 'aborted', reason };
              return;
            }

            yield* this.handleEngineEvent(
              event,
              accumulatedText,
              pendingToolCalls,
            );

            // Update accumulated text for text_delta events.
            if (event.type === 'text_delta') {
              accumulatedText += event.delta;
            }

            if (event.type === 'completed') {
              completionAnswer = event.answer;
              completionUsage = event.usage;
              if (completionUsage) {
                this.cumulativeTokens.inputTokens += completionUsage.inputTokens;
                this.cumulativeTokens.outputTokens += completionUsage.outputTokens;
              }
            }

            if (event.type === 'error') {
              engineErrored = true;
              lastEngineError = event.error;
              break;
            }
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          consecutiveErrors++;
          this.session.recordError(error);
          this.observer.onError(error, { phase: 'engine_stream', iteration: iterations });

          const nonRetryable = error instanceof EngineError && !error.retryable;
          if (nonRetryable || consecutiveErrors >= this.opts.maxRetries) {
            yield { type: 'error', error };
            done = true;
            break;
          }

          await abortableSleep(backoffDelay(consecutiveErrors), signal);
          continue;
        }

        if (engineErrored) {
          consecutiveErrors++;

          // Check the engine error for non-retryable status (e.g., auth failures).
          const nonRetryable = lastEngineError instanceof EngineError && !lastEngineError.retryable;
          if (nonRetryable || consecutiveErrors >= this.opts.maxRetries) {
            yield { type: 'error', error: lastEngineError ?? new EngineError('Engine returned error', this.engine.id) };
            done = true;
            break;
          }
          await abortableSleep(backoffDelay(consecutiveErrors), signal);
          continue;
        }

        // ----- If engine completed (no tool calls) → done -----
        if (completionAnswer !== undefined && pendingToolCalls.length === 0) {
          // Add assistant answer to context.
          await this.session.getContext().addMessage({
            role: 'assistant',
            content: completionAnswer,
          });
          finalAnswer = completionAnswer;
          yield { type: 'complete', answer: completionAnswer, usage: completionUsage };
          done = true;
          break;
        }

        // ----- Execute pending tool calls -----
        if (pendingToolCalls.length > 0) {
          // Add assistant message with tool calls to context.
          await this.session.getContext().addMessage({
            role: 'assistant',
            content: accumulatedText || '',
            toolCalls: pendingToolCalls,
          });

          for (const toolCall of pendingToolCalls) {
            // ----- Yield point 3: between tool executions -----
            const preToolSteering = this.processSteering();
            if (preToolSteering.abort) {
              yield { type: 'aborted', reason: preToolSteering.abortReason! };
              return;
            }

            if (signal.aborted) {
              yield { type: 'aborted', reason: 'Signal aborted' };
              return;
            }

            // ----- AWM: Mandatory step-level validation -----
            const validationResult = this.validateToolCall(toolCall);
            if (validationResult !== null) {
              // Validation failed — feed the error back to the LLM as a tool
              // error message so it can self-correct.
              yield {
                type: 'tool_validation_error',
                tool: toolCall.name,
                errors: validationResult.errors ?? ['Validation failed'],
              };

              await this.session.getContext().addMessage({
                role: 'tool',
                content: `[VALIDATION ERROR] Invalid arguments for tool "${toolCall.name}": ${validationResult.errors?.join(', ') ?? 'validation failed'}. Please fix the arguments and try again.`,
                toolCallId: toolCall.id,
              });

              this.session.recordToolInvocation();
              continue; // Skip execution, let the LLM correct itself.
            }

            yield { type: 'tool_start', tool: toolCall.name, args: toolCall.args };

            const result = await this.executeTool(toolCall, signal);

            // Track for verification.
            this.allToolResults.push(result);

            // Yield tool_end and add result to context.
            yield { type: 'tool_end', tool: toolCall.name, result };

            // Sanitize tool output before adding to LLM context — prevents
            // leaked secrets (API keys, tokens, etc.) from reaching the model.
            const rawContent = result.output || result.error || '';
            const policy = this.opts.securityPolicy ?? PERMISSIVE_POLICY;
            const sanitized = policy.sanitizeOutput(rawContent);
            if (sanitized.redacted) {
              this.observer.onSecurityEvent({
                type: 'secret_redacted',
                details: {
                  source: 'tool_output',
                  tool: toolCall.name,
                  patterns: sanitized.redactedPatterns,
                },
                timestamp: new Date(),
              });
            }

            await this.session.getContext().addMessage({
              role: 'tool',
              content: sanitized.clean,
              toolCallId: toolCall.id,
            });

            this.session.recordToolInvocation();
          }

          // Loop continues — send updated context back to engine.
          continue;
        }

        // If we got here with accumulated text but no explicit completion
        // event and no tool calls, treat the accumulated text as the answer.
        if (accumulatedText) {
          await this.session.getContext().addMessage({
            role: 'assistant',
            content: accumulatedText,
          });
          finalAnswer = accumulatedText;
          yield { type: 'complete', answer: accumulatedText, usage: completionUsage };
          done = true;
        }
      }

      // Max iterations reached without completion.
      if (!done) {
        const error = new Error(`Agent loop exceeded maximum iterations (${this.opts.maxIterations})`);
        yield { type: 'error', error };
        this.session.fail(error);
        return;
      }

      // ----- AWM: Task-level verification -----
      if (this.opts.verifier && finalAnswer) {
        try {
          const verificationResult = await this.opts.verifier.verify({
            taskDescription: initialMessage,
            finalAnswer,
            messages: this.session.getContext().getMessages(),
            toolResults: this.allToolResults,
            stateSnapshots: this.stateRecords,
          });

          yield { type: 'verification', result: verificationResult };

          // If verification found issues, inject feedback for self-correction.
          if (verificationResult.outcome === 'partial' || verificationResult.outcome === 'failure') {
            const suggestions = verificationResult.suggestions?.join('\n- ') ?? 'No specific suggestions.';
            const feedback = `[VERIFICATION ${verificationResult.outcome.toUpperCase()}] ${verificationResult.reasoning}\nSuggestions:\n- ${suggestions}`;

            this.observer.onError(
              new Error(`Task verification: ${verificationResult.outcome}`),
              {
                phase: 'verification',
                confidence: verificationResult.confidence,
                issues: verificationResult.issues?.length ?? 0,
              },
            );

            // Optionally, the caller can decide whether to re-enter the loop
            // based on the verification event. The feedback is added to context
            // so a subsequent run() call will have it available.
            await this.session.getContext().addMessage({
              role: 'system',
              content: feedback,
            });
          }
        } catch (err) {
          // Verification is best-effort — don't fail the session over it.
          this.observer.onError(
            err instanceof Error ? err : new Error(String(err)),
            { phase: 'verification' },
          );
        }
      }

      this.session.complete();

      // Lifecycle hook: auto-summarize the completed conversation.
      if (this.opts.onAfterComplete && finalAnswer) {
        try {
          await this.opts.onAfterComplete(this.session.getContext(), finalAnswer);
        } catch {
          // Memory store failures should never crash the agent loop.
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      yield { type: 'error', error };
      this.session.fail(error);
    } finally {
      this.currentHandle = null;
      // Clean up resources.
      this.observer.onSessionEnd(
        {
          sessionId: this.session.getId(),
          channelId: this.session.getConfig().channelId,
          userId: this.session.getConfig().userId,
          engineId: this.session.getConfig().engineId,
          startedAt: this.session.getMetadata().startedAt,
        },
        {
          duration: Date.now() - this.session.getMetadata().startedAt.getTime(),
          toolInvocations: this.session.getMetadata().toolInvocations,
          llmCalls: this.session.getMetadata().llmCalls,
          tokensUsed: {
            inputTokens: this.cumulativeTokens.inputTokens,
            outputTokens: this.cumulativeTokens.outputTokens,
          },
          errors: this.session.getMetadata().errors.length,
        },
      );

      if (this.ownsWorkerPool) {
        await this.workerPool.shutdown();
      }

      await this.observer.flush?.();
    }
  }

  /** Abort the running loop with a reason. */
  abort(reason: string): void {
    this.session.getSteering().push({
      type: 'abort',
      content: reason,
      priority: 100, // highest
      timestamp: new Date(),
    });
    this.abortController?.abort(reason);
  }

  /** Push a live steering message into the session's queue. */
  steer(message: SteeringMessage): void {
    this.session.getSteering().push(message);
  }

  /**
   * Forward a raw string to the engine's stdin.
   * Used to respond to permission prompts from SubprocessEngine (e.g. claude-cli).
   */
  steerEngine(message: string): void {
    this.currentHandle?.steer(message);
  }

  /** Get accumulated state records for external inspection. */
  getStateRecords(): readonly ToolStateRecord[] {
    return this.stateRecords;
  }

  /** Get accumulated tool results for external inspection. */
  getToolResults(): readonly ToolResult[] {
    return this.allToolResults;
  }

  // -----------------------------------------------------------------------
  // Engine event handling
  // -----------------------------------------------------------------------

  private *handleEngineEvent(
    event: EngineEvent,
    accumulatedText: string,
    pendingToolCalls: ToolCall[],
  ): Generator<AgentEvent> {
    switch (event.type) {
      case 'text_delta':
        yield {
          type: 'text',
          delta: event.delta,
          partial: accumulatedText + event.delta,
        };
        break;

      case 'tool_start':
        pendingToolCalls.push({
          id: event.id,
          name: event.tool,
          args: event.args,
        });
        break;

      case 'tool_progress':
        yield { type: 'tool_progress', tool: '', update: event.update };
        break;

      case 'tool_end':
        // Engine-side tool execution result (for engines that run tools internally).
        yield { type: 'tool_end', tool: '', result: event.result };
        break;

      case 'error':
        yield { type: 'error', error: event.error };
        break;

      case 'completed':
        // Handled by the caller — just pass through.
        break;

      case 'started':
        // No-op for the event stream.
        break;
    }
  }

  // -----------------------------------------------------------------------
  // AWM: Mandatory step-level tool call validation
  // -----------------------------------------------------------------------

  /**
   * Validate a tool call's arguments before execution.
   * Returns null if validation passes, or a ValidationResult with errors.
   *
   * This is a mandatory step — if a tool does not implement validate(),
   * we perform basic structural checks (args must be an object or undefined).
   */
  private validateToolCall(toolCall: ToolCall): { errors: string[] } | null {
    const tool = this.tools.get(toolCall.name);

    if (!tool) {
      return { errors: [`Tool "${toolCall.name}" not found.`] };
    }

    // Use the tool's own validate() if available.
    if (tool.validate) {
      const result = tool.validate(toolCall.args);
      if (!result.valid) {
        return { errors: result.errors ?? ['Validation failed.'] };
      }
      return null;
    }

    // Fallback: basic structural validation when tool has no validate().
    // The args should be an object (or undefined/null for no-arg tools).
    if (toolCall.args !== undefined && toolCall.args !== null) {
      if (typeof toolCall.args !== 'object' || Array.isArray(toolCall.args)) {
        return { errors: ['Arguments must be an object.'] };
      }
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Tool execution (with AWM state snapshots)
  // -----------------------------------------------------------------------

  private async executeTool(
    toolCall: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.name);

    if (!tool) {
      const error = new ToolError(`Unknown tool: ${toolCall.name}`, toolCall.name);
      this.observer.onError(error, { tool: toolCall.name });
      return {
        success: false,
        output: '',
        error: `Tool "${toolCall.name}" not found`,
      };
    }

    const startTime = Date.now();

    const rawCwd = this.session.getConfig().cwd ?? process.cwd();
    const toolContext: ToolContext & { memoryBackend?: IMemoryBackend } = {
      sessionId: this.session.getId(),
      cwd: sanitizeWorkspacePath(rawCwd),
      securityPolicy: this.opts.securityPolicy ?? PERMISSIVE_POLICY,
      abortSignal: signal,
      onProgress: (_update: string) => {
        // Progress updates are emitted inline for lightweight tools.
        // For heavyweight tools the worker pool handles streaming.
      },
      // Inject memory backend so memory_store / memory_recall tools can access it.
      ...(this.opts.memoryBackend ? { memoryBackend: this.opts.memoryBackend } : {}),
      // Spread any domain-specific extensions (e.g. canvasState for canvas tool).
      ...(this.opts.toolContextExtensions ?? {}),
    };

    // ----- AWM: Capture pre-execution state snapshot -----
    let beforeSnapshot: StateSnapshot | undefined;
    if (this.opts.enableStateSnapshots && tool.getStateSnapshot) {
      try {
        beforeSnapshot = await tool.getStateSnapshot(toolCall.args, toolContext);
      } catch {
        // State snapshot failure is non-fatal.
      }
    }

    let result: ToolResult;

    try {
      if (tool.weight === 'heavyweight' && this.opts.workerPool?.hasWorkerScript?.()) {
        // Dispatch to worker pool (only when a real worker script is configured).
        result = await this.workerPool.execute(
          {
            tool: toolCall.name,
            args: toolCall.args,
            context: {
              sessionId: this.session.getId(),
              cwd: sanitizeWorkspacePath(rawCwd),
            },
          },
          signal,
          (_update) => {
            // Worker progress — we cannot yield from here but the observer
            // captures it.
          },
        );
      } else {
        // Lightweight tools — or heavyweight tools without a worker script —
        // run on the main thread.
        result = await tool.execute(toolCall.args, toolContext);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      result = {
        success: false,
        output: '',
        error: error.message,
      };
    }

    // ----- AWM: Capture post-execution state snapshot -----
    let afterSnapshot: StateSnapshot | undefined;
    if (this.opts.enableStateSnapshots && tool.getStateSnapshot) {
      try {
        afterSnapshot = await tool.getStateSnapshot(toolCall.args, toolContext);
        // Attach snapshot to the tool result for downstream consumers.
        result.stateSnapshot = afterSnapshot;
      } catch {
        // State snapshot failure is non-fatal.
      }
    }

    // Record state diffs for verification.
    if (beforeSnapshot || afterSnapshot) {
      this.stateRecords.push({
        tool: toolCall.name,
        args: toolCall.args,
        before: beforeSnapshot,
        after: afterSnapshot,
      });
    }

    const duration = Date.now() - startTime;

    this.observer.onToolInvocation({
      sessionId: this.session.getId(),
      tool: toolCall.name,
      args: toolCall.args,
      result,
      duration,
      error: result.success ? undefined : new Error(result.error ?? 'Tool failed'),
    });

    return result;
  }

  // -----------------------------------------------------------------------
  // Steering
  // -----------------------------------------------------------------------

  /**
   * Drain the steering queue and process all messages. Returns an object
   * indicating whether an abort was requested.
   */
  private processSteering(): { abort: boolean; abortReason?: string } {
    const steering = this.session.getSteering();
    if (!steering.hasMessages()) {
      return { abort: false };
    }

    const messages = steering.drain();
    let abort = false;
    let abortReason: string | undefined;

    for (const msg of messages) {
      switch (msg.type) {
        case 'abort':
          abort = true;
          abortReason = msg.content ?? 'Abort requested';
          break;

        case 'inject': {
          // Inject a user message into the context before the next engine call.
          if (msg.content) {
            // addMessage is async but we fire-and-forget here because we are
            // inside the sync processSteering path. The message will be in the
            // array by the time we read getMessages() since ContextManager's
            // addMessage pushes synchronously (compaction is awaited elsewhere).
            const injectMsg: Message = {
              role: 'user',
              content: msg.content,
            };
            this.session.getContext().addMessage(injectMsg).catch((err) => {
              this.session.recordError(
                err instanceof Error ? err : new Error(String(err)),
              );
            });
          }
          break;
        }

        case 'priority':
          // Priority messages are informational nudges to the engine.
          // We inject them as user messages with a priority marker.
          if (msg.content) {
            const priorityMsg: Message = {
              role: 'user',
              content: `[PRIORITY] ${msg.content}`,
            };
            this.session.getContext().addMessage(priorityMsg).catch((err) => {
              this.session.recordError(
                err instanceof Error ? err : new Error(String(err)),
              );
            });
          }
          break;

        case 'context_update':
          // Context updates modify the system prompt or add context.
          if (msg.content) {
            this.session.getContext().setSystemPrompt(msg.content);
          }
          break;
      }
    }

    return { abort, abortReason };
  }

  /**
   * Extract the abort reason from a pending abort message.
   */
  private drainAbortReason(): string {
    const messages = this.session.getSteering().drain();
    const abortMsg = messages.find((m) => m.type === 'abort');
    return abortMsg?.content ?? 'Abort requested';
  }
}
