/**
 * MeshTool unit tests.
 *
 * Tests parallel multi-agent delegation: validation, parallel execution,
 * partial failures, concurrency limiting, abort propagation, and
 * engine resolution errors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshTool } from './mesh.js';
import type { MeshToolContext } from './mesh.js';
import type { ToolContext, IEngine, EngineEvent } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Mock engine factory
// ---------------------------------------------------------------------------

function createMockEngine(
  id: string,
  response: string,
  delayMs = 0,
  shouldError = false,
): IEngine {
  return {
    id,
    name: `Mock ${id}`,
    startRun: vi.fn().mockImplementation(async () => {
      const events: EngineEvent[] = shouldError
        ? [{ type: 'error', error: new Error(`Engine ${id} failed`) } as EngineEvent]
        : [
            { type: 'text_delta', delta: response } as EngineEvent,
            { type: 'completed', answer: response } as unknown as EngineEvent,
          ];

      return {
        events: (async function* () {
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
          for (const event of events) {
            yield event;
          }
        })(),
        cancel: vi.fn().mockResolvedValue(undefined),
      };
    }),
    resume: vi.fn(),
  } as unknown as IEngine;
}

function createMockContext(overrides?: Partial<MeshToolContext>): MeshToolContext {
  const abortController = new AbortController();

  return {
    sessionId: 'test-session',
    cwd: '/tmp',
    abortSignal: abortController.signal,
    onProgress: vi.fn(),
    resolveEngine: vi.fn().mockReturnValue(createMockEngine('default', 'default response')),
    defaultModel: 'test-model',
    ...overrides,
  } as unknown as MeshToolContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MeshTool', () => {
  let mesh: MeshTool;

  beforeEach(() => {
    mesh = new MeshTool();
  });

  // ---- Metadata ----

  it('has correct name, weight, and description', () => {
    expect(mesh.name).toBe('mesh');
    expect(mesh.weight).toBe('heavyweight');
    expect(mesh.description).toContain('parallel');
  });

  // ---- Validation ----

  describe('validate', () => {
    it('accepts valid args with tasks array', () => {
      const result = mesh.validate({
        tasks: [{ task: 'Do something' }],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects non-object args', () => {
      const result = mesh.validate('invalid');
      expect(result.valid).toBe(false);
    });

    it('rejects empty tasks array', () => {
      const result = mesh.validate({ tasks: [] });
      expect(result.valid).toBe(false);
    });

    it('rejects tasks without task string', () => {
      const result = mesh.validate({ tasks: [{ task: '' }] });
      expect(result.valid).toBe(false);
    });

    it('rejects invalid concurrency', () => {
      const result = mesh.validate({
        tasks: [{ task: 'Do something' }],
        concurrency: 99,
      });
      expect(result.valid).toBe(false);
    });

    it('accepts valid concurrency', () => {
      const result = mesh.validate({
        tasks: [{ task: 'Do something' }],
        concurrency: 5,
      });
      expect(result.valid).toBe(true);
    });

    it('accepts tasks with engine and model', () => {
      const result = mesh.validate({
        tasks: [{ task: 'Do something', engine: 'native', model: 'gpt-4' }],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects tasks with non-string engine', () => {
      const result = mesh.validate({
        tasks: [{ task: 'Do something', engine: 123 }],
      });
      expect(result.valid).toBe(false);
    });
  });

  // ---- Execution ----

  describe('execute', () => {
    it('executes multiple tasks and aggregates results', async () => {
      const engine = createMockEngine('test', 'task result');
      const context = createMockContext({
        resolveEngine: vi.fn().mockReturnValue(engine),
      });

      const result = await mesh.execute(
        {
          tasks: [
            { task: 'Research topic A' },
            { task: 'Research topic B' },
          ],
        },
        context as unknown as ToolContext,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('2/2 tasks succeeded');
      expect(result.metadata).toBeDefined();
      expect((result.metadata as Record<string, unknown>).succeeded).toBe(2);
    });

    it('handles partial failures gracefully', async () => {
      const goodEngine = createMockEngine('good', 'good result');
      const badEngine = createMockEngine('bad', '', 0, true);

      const context = createMockContext({
        resolveEngine: vi.fn().mockImplementation((id?: string) => {
          if (id === 'bad') return badEngine;
          return goodEngine;
        }),
      });

      const result = await mesh.execute(
        {
          tasks: [
            { task: 'Good task' },
            { task: 'Bad task', engine: 'bad' },
          ],
        },
        context as unknown as ToolContext,
      );

      expect(result.success).toBe(false); // Partial failure
      expect(result.output).toContain('1/2 tasks succeeded');
      expect((result.metadata as Record<string, unknown>).failed).toBe(1);
    });

    it('handles engine resolution failure', async () => {
      const context = createMockContext({
        resolveEngine: vi.fn().mockReturnValue(undefined),
      });

      const result = await mesh.execute(
        {
          tasks: [{ task: 'Some task' }],
        },
        context as unknown as ToolContext,
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain('0/1 tasks succeeded');
    });

    it('throws when resolveEngine is not available', async () => {
      const context = createMockContext({
        resolveEngine: undefined,
      });

      await expect(
        mesh.execute({ tasks: [{ task: 'test' }] }, context as unknown as ToolContext),
      ).rejects.toThrow('engine registry');
    });

    it('returns validation error for invalid args', async () => {
      const context = createMockContext();
      const result = await mesh.execute(
        { tasks: [] },
        context as unknown as ToolContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid arguments');
    });

    it('respects abort signal', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const context = createMockContext({
        abortSignal: abortController.signal,
      });

      const result = await mesh.execute(
        { tasks: [{ task: 'test' }] },
        context as unknown as ToolContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('aborted');
    });

    it('reports progress during execution', async () => {
      const engine = createMockEngine('test', 'result');
      const onProgress = vi.fn();
      const context = createMockContext({
        resolveEngine: vi.fn().mockReturnValue(engine),
        onProgress,
      });

      await mesh.execute(
        { tasks: [{ task: 'test' }] },
        context as unknown as ToolContext,
      );

      expect(onProgress).toHaveBeenCalled();
      const firstCall = onProgress.mock.calls[0]![0] as string;
      expect(firstCall).toContain('Spawning');
    });
  });

  // ---- Abort ----

  describe('abort', () => {
    it('is callable without error', () => {
      expect(() => mesh.abort('test reason')).not.toThrow();
    });
  });
});
