/**
 * Mesh tool — swarm-style multi-agent delegation.
 *
 * Spawns multiple sub-agents in parallel across different engines/models,
 * collects results, and returns a structured aggregate. Builds on the same
 * engine resolution pattern as the DelegateTool but adds:
 *
 *   - Multiple tasks in a single invocation
 *   - Configurable concurrency limiting (semaphore-based)
 *   - Per-task timeout
 *   - Partial failure tolerance (uses Promise.allSettled)
 *   - Structured result aggregation
 *
 * Heavyweight tool — runs in the worker pool.
 */

import type {
  ITool,
  ToolContext,
  ToolResult,
  ValidationResult,
  JSONSchema7,
  IEngine,
  EngineEvent,
} from '@ch4p/core';
import { ToolError } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MeshTask {
  task: string;
  engine?: string;
  model?: string;
}

interface MeshArgs {
  tasks: MeshTask[];
  concurrency?: number;
}

interface TaskOutcome {
  task: string;
  engine: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

/**
 * Extended ToolContext that includes engine resolution.
 * Same pattern as DelegateToolContext.
 */
export interface MeshToolContext extends ToolContext {
  resolveEngine?: (engineId?: string) => IEngine | undefined;
  defaultModel?: string;
  meshConfig?: {
    maxConcurrency?: number;
    defaultTimeout?: number;
  };
}

// ---------------------------------------------------------------------------
// Concurrency semaphore
// ---------------------------------------------------------------------------

class Semaphore {
  private count: number;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.count = limit;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.count++;
    }
  }
}

// ---------------------------------------------------------------------------
// MeshTool
// ---------------------------------------------------------------------------

export class MeshTool implements ITool {
  readonly name = 'mesh';
  readonly description =
    'Execute multiple tasks in parallel across sub-agents. Each task can ' +
    'target a different engine or model. Results are collected and returned ' +
    'as a structured aggregate. Use this for parallelizable work like ' +
    'research, analysis, or multi-perspective problem solving.';

  readonly weight = 'heavyweight' as const;

  readonly parameters: JSONSchema7 = {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'Task description for the sub-agent.',
              minLength: 1,
            },
            engine: {
              type: 'string',
              description: 'Engine ID to run this task on (optional, defaults to current).',
            },
            model: {
              type: 'string',
              description: 'Model ID for this task (optional).',
            },
          },
          required: ['task'],
          additionalProperties: false,
        },
        description: 'Array of tasks to execute in parallel across sub-agents (at least 1).',
      },
      concurrency: {
        type: 'number',
        description: 'Max parallel sub-agents (default: from config or 3).',
        minimum: 1,
        maximum: 10,
      },
    },
    required: ['tasks'],
    additionalProperties: false,
  };

  private cancelFns: Array<() => Promise<void>> = [];

  validate(args: unknown): ValidationResult {
    if (typeof args !== 'object' || args === null) {
      return { valid: false, errors: ['Arguments must be an object.'] };
    }

    const { tasks, concurrency } = args as Record<string, unknown>;
    const errors: string[] = [];

    if (!Array.isArray(tasks) || tasks.length === 0) {
      errors.push('tasks must be a non-empty array.');
    } else {
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i] as Record<string, unknown> | undefined;
        if (!t || typeof t.task !== 'string' || (t.task as string).trim().length === 0) {
          errors.push(`tasks[${i}].task must be a non-empty string.`);
        }
        if (t?.engine !== undefined && typeof t.engine !== 'string') {
          errors.push(`tasks[${i}].engine must be a string.`);
        }
        if (t?.model !== undefined && typeof t.model !== 'string') {
          errors.push(`tasks[${i}].model must be a string.`);
        }
      }
    }

    if (concurrency !== undefined) {
      if (typeof concurrency !== 'number' || concurrency < 1 || concurrency > 10) {
        errors.push('concurrency must be a number between 1 and 10.');
      }
    }

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const validation = this.validate(args);
    if (!validation.valid) {
      return {
        success: false,
        output: '',
        error: `Invalid arguments: ${validation.errors!.join(' ')}`,
      };
    }

    const meshContext = context as MeshToolContext;
    if (!meshContext.resolveEngine) {
      throw new ToolError(
        'Engine resolution is not available. The mesh tool requires access to the engine registry.',
        this.name,
      );
    }

    const { tasks, concurrency: requestedConcurrency } = args as MeshArgs;
    const maxConcurrency = requestedConcurrency
      ?? meshContext.meshConfig?.maxConcurrency
      ?? 3;
    const defaultTimeout = meshContext.meshConfig?.defaultTimeout ?? 120_000;

    if (context.abortSignal.aborted) {
      return {
        success: false,
        output: '',
        error: 'Mesh execution aborted before start.',
      };
    }

    context.onProgress(
      `Spawning ${tasks.length} sub-agent(s) with concurrency ${maxConcurrency}...`,
    );

    const semaphore = new Semaphore(maxConcurrency);
    this.cancelFns = [];

    // Execute all tasks with concurrency limiting.
    const outcomes = await Promise.allSettled(
      tasks.map((task, index) =>
        this.executeTask(task, index, meshContext, semaphore, defaultTimeout),
      ),
    );

    // Collect results.
    const results: TaskOutcome[] = outcomes.map((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        return outcome.value;
      }
      return {
        task: tasks[index]!.task,
        engine: tasks[index]!.engine ?? 'default',
        success: false,
        output: '',
        error: outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason),
        durationMs: 0,
      };
    });

    this.cancelFns = [];

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;

    // Format output as structured text.
    const outputLines = results.map((r, i) => {
      const status = r.success ? '✓' : '✗';
      const header = `[${status}] Task ${i + 1}: ${r.task.slice(0, 80)}`;
      const engineInfo = `    Engine: ${r.engine} (${r.durationMs}ms)`;
      const body = r.success
        ? r.output.split('\n').map((l) => `    ${l}`).join('\n')
        : `    Error: ${r.error}`;
      return `${header}\n${engineInfo}\n${body}`;
    });

    const summary = `${succeeded}/${results.length} tasks succeeded` +
      (failed > 0 ? ` (${failed} failed)` : '');

    return {
      success: failed === 0,
      output: `${summary}\n\n${outputLines.join('\n\n')}`,
      metadata: {
        total: results.length,
        succeeded,
        failed,
        results: results.map((r) => ({
          task: r.task,
          engine: r.engine,
          success: r.success,
          durationMs: r.durationMs,
          error: r.error,
        })),
      },
    };
  }

  abort(_reason: string): void {
    for (const cancel of this.cancelFns) {
      cancel().catch(() => {});
    }
    this.cancelFns = [];
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async executeTask(
    task: MeshTask,
    _index: number,
    context: MeshToolContext,
    semaphore: Semaphore,
    timeout: number,
  ): Promise<TaskOutcome> {
    await semaphore.acquire();

    const startTime = Date.now();

    try {
      if (context.abortSignal.aborted) {
        return {
          task: task.task,
          engine: task.engine ?? 'default',
          success: false,
          output: '',
          error: 'Aborted.',
          durationMs: 0,
        };
      }

      const targetEngine = context.resolveEngine!(task.engine);
      if (!targetEngine) {
        return {
          task: task.task,
          engine: task.engine ?? 'default',
          success: false,
          output: '',
          error: task.engine
            ? `Engine "${task.engine}" not found.`
            : 'No default engine available.',
          durationMs: Date.now() - startTime,
        };
      }

      // Create a per-task abort controller for timeout.
      const taskAbort = new AbortController();
      const timeoutId = setTimeout(() => taskAbort.abort(), timeout);

      // Also abort if parent is aborted.
      const parentAbortHandler = () => taskAbort.abort();
      context.abortSignal.addEventListener('abort', parentAbortHandler, { once: true });

      try {
        const handle = await targetEngine.startRun(
          {
            sessionId: `${context.sessionId}-mesh-${Date.now()}-${_index}`,
            messages: [{ role: 'user', content: task.task }],
            model: task.model ?? context.defaultModel,
            systemPrompt:
              'You are a sub-agent executing a delegated task as part of a parallel mesh. ' +
              'Complete the task thoroughly and return your findings concisely.',
          },
          {
            signal: taskAbort.signal,
            onProgress: (event: EngineEvent) => {
              if (event.type === 'text_delta') {
                context.onProgress(`[Task ${_index + 1}] ${event.delta}`);
              }
            },
          },
        );

        this.cancelFns.push(() => handle.cancel());

        let answer = '';
        for await (const event of handle.events) {
          if (taskAbort.signal.aborted) {
            await handle.cancel();
            return {
              task: task.task,
              engine: targetEngine.id,
              success: false,
              output: answer,
              error: 'Task timed out or was aborted.',
              durationMs: Date.now() - startTime,
            };
          }

          switch (event.type) {
            case 'text_delta':
              answer += event.delta;
              break;
            case 'completed':
              answer = event.answer;
              break;
            case 'error':
              return {
                task: task.task,
                engine: targetEngine.id,
                success: false,
                output: answer,
                error: `Sub-agent error: ${event.error.message}`,
                durationMs: Date.now() - startTime,
              };
          }
        }

        return {
          task: task.task,
          engine: targetEngine.id,
          success: true,
          output: answer,
          durationMs: Date.now() - startTime,
        };
      } finally {
        clearTimeout(timeoutId);
        context.abortSignal.removeEventListener('abort', parentAbortHandler);
      }
    } catch (err) {
      return {
        task: task.task,
        engine: task.engine ?? 'default',
        success: false,
        output: '',
        error: (err as Error).name === 'AbortError'
          ? 'Task timed out or was aborted.'
          : `Task failed: ${(err as Error).message}`,
        durationMs: Date.now() - startTime,
      };
    } finally {
      semaphore.release();
    }
  }
}
