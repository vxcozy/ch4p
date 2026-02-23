/**
 * Delegate tool — spawns a sub-agent on a different engine.
 *
 * Heavyweight tool that delegates a task to a sub-agent, optionally on a
 * different execution engine or model. This enables multi-engine workflows
 * where specialized models handle specific subtasks.
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

interface DelegateArgs {
  task: string;
  engine?: string;
  model?: string;
  /** Optional parent context to share with the sub-agent (e.g. conversation summary). */
  context?: string;
}

/**
 * Extended ToolContext that includes engine resolution.
 * The delegate tool needs access to engines to spawn sub-agents.
 */
export interface DelegateToolContext extends ToolContext {
  resolveEngine?: (engineId?: string) => IEngine | undefined;
  defaultModel?: string;
}

export class DelegateTool implements ITool {
  readonly name = 'delegate';
  readonly description =
    'Delegate a task to a sub-agent, optionally on a different execution ' +
    'engine or model. Useful for parallelizing work or leveraging ' +
    'specialized models for specific subtasks.';

  readonly weight = 'heavyweight' as const;

  readonly parameters: JSONSchema7 = {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task description for the sub-agent to execute.',
        minLength: 1,
      },
      engine: {
        type: 'string',
        description:
          'Engine ID to run the sub-agent on. Defaults to the current engine.',
      },
      model: {
        type: 'string',
        description:
          'Model ID to use for the sub-agent. Defaults to the current model.',
      },
      context: {
        type: 'string',
        description:
          'Optional parent context snippet to pass to the sub-agent (e.g. ' +
          'a conversation summary or relevant background). The sub-agent ' +
          'sees this as prior context before the task.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  };

  private cancelFn: (() => Promise<void>) | null = null;

  validate(args: unknown): ValidationResult {
    if (typeof args !== 'object' || args === null) {
      return { valid: false, errors: ['Arguments must be an object.'] };
    }

    const { task, engine, model } = args as Record<string, unknown>;
    const errors: string[] = [];

    if (typeof task !== 'string' || task.trim().length === 0) {
      errors.push('task must be a non-empty string.');
    }

    if (engine !== undefined && typeof engine !== 'string') {
      errors.push('engine must be a string.');
    }

    if (model !== undefined && typeof model !== 'string') {
      errors.push('model must be a string.');
    }

    const { context } = args as Record<string, unknown>;
    if (context !== undefined && typeof context !== 'string') {
      errors.push('context must be a string.');
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

    const delegateContext = context as DelegateToolContext;
    if (!delegateContext.resolveEngine) {
      throw new ToolError(
        'Engine resolution is not available. The delegate tool requires access to the engine registry.',
        this.name,
      );
    }

    const { task, engine: engineId, model, context: parentContext } = args as DelegateArgs;

    // Resolve the target engine
    const targetEngine = delegateContext.resolveEngine(engineId);
    if (!targetEngine) {
      return {
        success: false,
        output: '',
        error: engineId
          ? `Engine "${engineId}" not found.`
          : 'No default engine available.',
      };
    }

    if (context.abortSignal.aborted) {
      return {
        success: false,
        output: '',
        error: 'Delegation aborted before execution.',
      };
    }

    context.onProgress(
      `Delegating to ${targetEngine.name}${model ? ` (model: ${model})` : ''}...`,
    );

    try {
      // Build the message list for the sub-agent. If parent context is provided,
      // fold it into the user message — the Anthropic API requires the first
      // message to have role: 'user'; prepending an assistant turn is invalid.
      const taskContent = parentContext
        ? `[Context]\n${parentContext}\n\n[Task]\n${task}`
        : task;
      const subMessages: Array<{ role: 'user'; content: string }> = [
        { role: 'user', content: taskContent },
      ];

      const handle = await targetEngine.startRun(
        {
          sessionId: `${context.sessionId}-delegate-${Date.now()}`,
          messages: subMessages,
          model: model ?? delegateContext.defaultModel,
          systemPrompt:
            'You are a sub-agent executing a delegated task. Complete the task thoroughly and return your findings.',
        },
        {
          signal: context.abortSignal,
          onProgress: (event: EngineEvent) => {
            if (event.type === 'text_delta') {
              context.onProgress(event.delta);
            }
          },
        },
      );

      this.cancelFn = () => handle.cancel();

      // Collect the response from the event stream
      let answer = '';
      let usage: Record<string, unknown> | undefined;

      for await (const event of handle.events) {
        if (context.abortSignal.aborted) {
          await handle.cancel();
          return {
            success: false,
            output: answer,
            error: 'Delegation was aborted.',
          };
        }

        switch (event.type) {
          case 'text_delta':
            answer += event.delta;
            break;
          case 'completed':
            answer = event.answer;
            usage = event.usage as unknown as Record<string, unknown>;
            break;
          case 'error':
            return {
              success: false,
              output: answer,
              error: `Sub-agent error: ${event.error.message}`,
            };
        }
      }

      this.cancelFn = null;

      return {
        success: true,
        output: answer,
        metadata: {
          engine: targetEngine.id,
          model: model ?? delegateContext.defaultModel,
          usage,
        },
      };
    } catch (err) {
      this.cancelFn = null;

      if ((err as Error).name === 'AbortError') {
        return {
          success: false,
          output: '',
          error: 'Delegation was aborted.',
        };
      }

      return {
        success: false,
        output: '',
        error: `Delegation failed: ${(err as Error).message}`,
      };
    }
  }

  abort(_reason: string): void {
    this.cancelFn?.();
    this.cancelFn = null;
  }
}
