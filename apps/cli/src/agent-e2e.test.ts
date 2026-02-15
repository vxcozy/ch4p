/**
 * End-to-end integration tests for the CLI agent pipeline.
 *
 * Tests the full flow: Session → AgentLoop → Engine → Tools.
 * Uses a controllable mock engine so tests don't need real API keys.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IEngine, EngineEvent, SessionConfig, ToolResult, ToolCall } from '@ch4p/core';
import { generateId } from '@ch4p/core';
import { Session, AgentLoop } from '@ch4p/agent';
import type { AgentEvent } from '@ch4p/agent';
import { ToolRegistry } from '@ch4p/tools';
import { NoopObserver } from '@ch4p/observability';

// ---------------------------------------------------------------------------
// Test engine — controllable responses for deterministic tests
// ---------------------------------------------------------------------------

interface MockEngineOpts {
  /** Response text to emit as deltas. */
  responseText?: string;
  /** Tool calls to emit (engine signals these, AgentLoop executes them). */
  toolCalls?: ToolCall[];
  /** Second-turn response after tool results are returned. */
  followUpText?: string;
}

function createMockEngine(opts: MockEngineOpts = {}): IEngine {
  let callCount = 0;

  return {
    id: 'mock',
    name: 'Mock Engine',

    async startRun(job, runOpts) {
      callCount++;
      const currentCall = callCount;
      const ref = generateId(12);

      async function* events(): AsyncIterable<EngineEvent> {
        yield { type: 'started' };

        // First call: emit text and optionally tool calls.
        if (currentCall === 1) {
          const text = opts.responseText ?? 'Hello from mock engine.';

          // Emit text deltas.
          yield { type: 'text_delta', delta: text };

          // If tool calls are configured, emit them.
          if (opts.toolCalls && opts.toolCalls.length > 0) {
            for (const tc of opts.toolCalls) {
              yield {
                type: 'tool_start',
                id: tc.id,
                tool: tc.name,
                args: tc.args,
              };
            }

            // Emit completed with the text but the tool calls signal
            // the AgentLoop to execute them and loop.
            yield {
              type: 'completed',
              answer: text,
              usage: { inputTokens: 10, outputTokens: 20 },
            };
          } else {
            // No tools — simple completion.
            yield {
              type: 'completed',
              answer: text,
              usage: { inputTokens: 10, outputTokens: 20 },
            };
          }
        } else {
          // Follow-up call after tool execution.
          const followUp = opts.followUpText ?? 'Done with tools.';
          yield { type: 'text_delta', delta: followUp };
          yield {
            type: 'completed',
            answer: followUp,
            usage: { inputTokens: 30, outputTokens: 15 },
          };
        }
      }

      return {
        ref,
        events: events(),
        async cancel() {},
        steer(_message: string) {},
      };
    },

    async resume(_token, _prompt) {
      throw new Error('Resume not supported');
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestSessionConfig(): SessionConfig {
  return {
    sessionId: generateId(16),
    engineId: 'mock',
    model: 'test-model',
    provider: 'mock',
    autonomyLevel: 'full',
    cwd: process.cwd(),
    systemPrompt: 'You are a test assistant.',
  };
}

async function collectEvents(loop: AgentLoop, message: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of loop.run(message)) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Agent E2E Pipeline', () => {
  describe('simple text response (no tools)', () => {
    it('should stream text through the full pipeline', async () => {
      const engine = createMockEngine({ responseText: 'Hi there!' });
      const session = new Session(createTestSessionConfig());
      const observer = new NoopObserver();

      const loop = new AgentLoop(session, engine, [], observer);
      const events = await collectEvents(loop, 'Hello');

      // Should have text and complete events.
      const textEvents = events.filter((e) => e.type === 'text');
      const completeEvents = events.filter((e) => e.type === 'complete');

      expect(textEvents.length).toBeGreaterThan(0);
      expect(completeEvents).toHaveLength(1);

      // Text content should match.
      const fullText = textEvents
        .map((e) => (e as { delta: string }).delta)
        .join('');
      expect(fullText).toBe('Hi there!');

      // Complete event should have usage.
      const complete = completeEvents[0] as { answer: string; usage?: { inputTokens: number; outputTokens: number } };
      expect(complete.answer).toBe('Hi there!');
      expect(complete.usage?.inputTokens).toBe(10);
      expect(complete.usage?.outputTokens).toBe(20);
    });

    it('should activate and complete the session', async () => {
      const engine = createMockEngine({ responseText: 'Done.' });
      const session = new Session(createTestSessionConfig());
      const observer = new NoopObserver();

      const loop = new AgentLoop(session, engine, [], observer);
      await collectEvents(loop, 'Test');

      expect(session.getState()).toBe('completed');
      expect(session.getMetadata().loopIterations).toBe(1);
      expect(session.getMetadata().llmCalls).toBe(1);
    });
  });

  describe('with tool execution', () => {
    it('should execute tool calls through AgentLoop', async () => {
      const engine = createMockEngine({
        responseText: 'Let me read that file.',
        toolCalls: [
          { id: 'tc_1', name: 'file_read', args: { path: 'README.md' } },
        ],
        followUpText: 'The README contains the project description.',
      });

      const session = new Session(createTestSessionConfig());
      const registry = ToolRegistry.createDefault({ include: ['file_read'] });
      const observer = new NoopObserver();

      const loop = new AgentLoop(session, engine, registry.list(), observer, {
        enableStateSnapshots: false, // file_read doesn't have snapshots
      });
      const events = await collectEvents(loop, 'Read the README');

      // Should have tool_start, tool_end events.
      const toolStarts = events.filter((e) => e.type === 'tool_start');
      const toolEnds = events.filter((e) => e.type === 'tool_end');

      expect(toolStarts).toHaveLength(1);
      expect(toolEnds).toHaveLength(1);

      // Tool should be file_read.
      expect((toolStarts[0] as { tool: string }).tool).toBe('file_read');

      // Should have a completion at the end.
      const completes = events.filter((e) => e.type === 'complete');
      expect(completes).toHaveLength(1);
      expect((completes[0] as { answer: string }).answer).toBe(
        'The README contains the project description.',
      );

      // Session should have recorded tool invocation.
      expect(session.getMetadata().toolInvocations).toBe(1);
      expect(session.getMetadata().llmCalls).toBe(2); // initial + follow-up
    });

    it('should validate tool calls with mandatory validation', async () => {
      const engine = createMockEngine({
        responseText: 'Running unknown tool.',
        toolCalls: [
          { id: 'tc_bad', name: 'nonexistent_tool', args: {} },
        ],
        followUpText: 'Tool not found, sorry.',
      });

      const session = new Session(createTestSessionConfig());
      const registry = ToolRegistry.createDefault({ include: ['file_read'] });
      const observer = new NoopObserver();

      const loop = new AgentLoop(session, engine, registry.list(), observer);
      const events = await collectEvents(loop, 'Do something');

      // Should have a tool_validation_error for the nonexistent tool.
      const validationErrors = events.filter((e) => e.type === 'tool_validation_error');
      expect(validationErrors.length).toBeGreaterThan(0);
      expect((validationErrors[0] as { tool: string }).tool).toBe('nonexistent_tool');
    });
  });

  describe('with state snapshots', () => {
    it('should capture snapshots for file_write tool', async () => {
      const engine = createMockEngine({
        responseText: 'Writing file.',
        toolCalls: [
          {
            id: 'tc_write',
            name: 'file_write',
            args: { path: '/tmp/ch4p-test-snapshot-e2e.txt', content: 'hello' },
          },
        ],
        followUpText: 'File written.',
      });

      const session = new Session(createTestSessionConfig());
      const registry = ToolRegistry.createDefault({
        include: ['file_write'],
      });
      const observer = new NoopObserver();

      const loop = new AgentLoop(session, engine, registry.list(), observer, {
        enableStateSnapshots: true,
      });
      const events = await collectEvents(loop, 'Write a test file');

      // The tool should have executed.
      const toolEnds = events.filter((e) => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(1);

      // State records should have been captured.
      const stateRecords = loop.getStateRecords();
      expect(stateRecords.length).toBeGreaterThanOrEqual(1);
      expect(stateRecords[0]!.tool).toBe('file_write');

      // After-snapshot should exist (file was created).
      expect(stateRecords[0]!.after).toBeDefined();
      expect(stateRecords[0]!.after?.state).toBeDefined();

      // Cleanup.
      const { unlink } = await import('node:fs/promises');
      try {
        await unlink('/tmp/ch4p-test-snapshot-e2e.txt');
      } catch {
        // ignore
      }
    });
  });

  describe('full tool registry integration', () => {
    it('should create default registry with all 10 tools', () => {
      const registry = ToolRegistry.createDefault();
      expect(registry.size).toBe(10);
      expect(registry.names()).toContain('bash');
      expect(registry.names()).toContain('file_read');
      expect(registry.names()).toContain('file_write');
      expect(registry.names()).toContain('file_edit');
      expect(registry.names()).toContain('grep');
      expect(registry.names()).toContain('glob');
      expect(registry.names()).toContain('web_fetch');
      expect(registry.names()).toContain('memory_store');
      expect(registry.names()).toContain('memory_recall');
      expect(registry.names()).toContain('delegate');
    });

    it('should exclude tools in readonly mode', () => {
      const registry = ToolRegistry.createDefault({
        exclude: ['bash', 'file_write', 'file_edit', 'delegate'],
      });
      expect(registry.size).toBe(6);
      expect(registry.names()).not.toContain('bash');
      expect(registry.names()).not.toContain('file_write');
      expect(registry.names()).not.toContain('file_edit');
      expect(registry.names()).not.toContain('delegate');
    });
  });

  describe('observer integration', () => {
    it('should notify observer on session start and end', async () => {
      const engine = createMockEngine({ responseText: 'Done.' });
      const session = new Session(createTestSessionConfig());
      const observer = new NoopObserver();

      const startSpy = vi.spyOn(observer, 'onSessionStart');
      const endSpy = vi.spyOn(observer, 'onSessionEnd');
      const flushSpy = vi.spyOn(observer, 'flush');

      const loop = new AgentLoop(session, engine, [], observer);
      await collectEvents(loop, 'Hello');

      expect(startSpy).toHaveBeenCalledOnce();
      expect(endSpy).toHaveBeenCalledOnce();
      expect(flushSpy).toHaveBeenCalledOnce();

      // Start meta should have session ID.
      const startMeta = startSpy.mock.calls[0]![0];
      expect(startMeta.sessionId).toBe(session.getId());

      // End stats should have duration > 0.
      const endStats = endSpy.mock.calls[0]![1];
      expect(endStats.duration).toBeGreaterThanOrEqual(0);
      expect(endStats.llmCalls).toBe(1);
    });

    it('should notify observer on tool invocation', async () => {
      const engine = createMockEngine({
        responseText: 'Reading.',
        toolCalls: [
          { id: 'tc_read', name: 'file_read', args: { path: 'README.md' } },
        ],
        followUpText: 'Read complete.',
      });

      const session = new Session(createTestSessionConfig());
      const registry = ToolRegistry.createDefault({ include: ['file_read'] });
      const observer = new NoopObserver();
      const toolSpy = vi.spyOn(observer, 'onToolInvocation');

      const loop = new AgentLoop(session, engine, registry.list(), observer, {
        enableStateSnapshots: false,
      });
      await collectEvents(loop, 'Read README');

      expect(toolSpy).toHaveBeenCalledOnce();
      const event = toolSpy.mock.calls[0]![0];
      expect(event.tool).toBe('file_read');
      expect(event.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('error handling', () => {
    it('should handle engine errors gracefully', async () => {
      const failEngine: IEngine = {
        id: 'fail',
        name: 'Failing Engine',
        async startRun() {
          throw new Error('Connection refused');
        },
        async resume() {
          throw new Error('Not supported');
        },
      };

      const session = new Session(createTestSessionConfig());
      const observer = new NoopObserver();
      const loop = new AgentLoop(session, failEngine, [], observer, {
        maxRetries: 1,
      });

      const events = await collectEvents(loop, 'Hello');
      const errors = events.filter((e) => e.type === 'error');
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should respect max iterations limit', async () => {
      // Engine that always returns tool calls, creating an infinite loop.
      let calls = 0;
      const loopEngine: IEngine = {
        id: 'loop',
        name: 'Loop Engine',
        async startRun(job) {
          calls++;
          const ref = generateId(12);
          async function* events(): AsyncIterable<EngineEvent> {
            yield { type: 'started' };
            yield { type: 'text_delta', delta: `Iteration ${calls}. ` };
            yield {
              type: 'tool_start',
              id: `tc_${calls}`,
              tool: 'file_read',
              args: { path: 'README.md' },
            };
            yield {
              type: 'completed',
              answer: `Iteration ${calls}`,
              usage: { inputTokens: 5, outputTokens: 5 },
            };
          }
          return { ref, events: events(), async cancel() {}, steer() {} };
        },
        async resume() { throw new Error('Not supported'); },
      };

      const session = new Session(createTestSessionConfig());
      const registry = ToolRegistry.createDefault({ include: ['file_read'] });
      const observer = new NoopObserver();
      const loop = new AgentLoop(session, loopEngine, registry.list(), observer, {
        maxIterations: 3,
      });

      const events = await collectEvents(loop, 'Loop forever');

      // Should hit max iterations error.
      const errors = events.filter((e) => e.type === 'error');
      expect(errors.length).toBeGreaterThan(0);
      const errorMsg = (errors[0] as { error: Error }).error.message;
      expect(errorMsg).toContain('maximum iterations');
    });
  });

  describe('session lifecycle', () => {
    it('should track metadata through the pipeline', async () => {
      const engine = createMockEngine({
        responseText: 'Using a tool.',
        toolCalls: [
          { id: 'tc_1', name: 'file_read', args: { path: 'package.json' } },
        ],
        followUpText: 'All done.',
      });

      const session = new Session(createTestSessionConfig());
      const registry = ToolRegistry.createDefault({ include: ['file_read'] });
      const observer = new NoopObserver();

      const loop = new AgentLoop(session, engine, registry.list(), observer);
      await collectEvents(loop, 'Read package.json');

      const meta = session.getMetadata();
      expect(meta.state).toBe('completed');
      expect(meta.loopIterations).toBe(2); // initial + post-tool
      expect(meta.llmCalls).toBe(2);
      expect(meta.toolInvocations).toBe(1);
      expect(meta.errors).toHaveLength(0);
    });
  });
});
