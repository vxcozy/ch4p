/**
 * End-to-end integration tests for the CLI agent pipeline.
 *
 * Tests the full flow: Session → AgentLoop → Engine → Tools.
 * Uses a controllable mock engine so tests don't need real API keys.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IEngine, EngineEvent, SessionConfig, ToolResult, ToolCall, IMemoryBackend, MemoryResult, MemoryEntry, RecallOpts } from '@ch4p/core';
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
      expect(registry.size).toBe(11);
      expect(registry.names()).toContain('bash');
      expect(registry.names()).toContain('file_read');
      expect(registry.names()).toContain('file_write');
      expect(registry.names()).toContain('file_edit');
      expect(registry.names()).toContain('grep');
      expect(registry.names()).toContain('glob');
      expect(registry.names()).toContain('web_fetch');
      expect(registry.names()).toContain('web_search');
      expect(registry.names()).toContain('memory_store');
      expect(registry.names()).toContain('memory_recall');
      expect(registry.names()).toContain('delegate');
    });

    it('should exclude tools in readonly mode', () => {
      const registry = ToolRegistry.createDefault({
        exclude: ['bash', 'file_write', 'file_edit', 'delegate'],
      });
      expect(registry.size).toBe(7);
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

  // -------------------------------------------------------------------------
  // Memory integration — agent loop with memory_store and memory_recall tools
  // -------------------------------------------------------------------------

  describe('memory integration (store → recall → answer)', () => {
    /**
     * In-memory IMemoryBackend for deterministic tests.
     * Stores entries in a Map and returns keyword-matched results.
     */
    function createMockMemoryBackend(): IMemoryBackend {
      const entries = new Map<string, { content: string; metadata?: Record<string, unknown>; createdAt: Date; updatedAt: Date }>();

      return {
        id: 'mock-memory',

        async store(key: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
          const now = new Date();
          entries.set(key, {
            content,
            metadata,
            createdAt: entries.get(key)?.createdAt ?? now,
            updatedAt: now,
          });
        },

        async recall(query: string, opts?: RecallOpts): Promise<MemoryResult[]> {
          const limit = opts?.limit ?? 10;
          const results: MemoryResult[] = [];
          const queryLower = query.toLowerCase();

          for (const [key, entry] of entries) {
            const keyMatch = key.toLowerCase().includes(queryLower);
            const contentMatch = entry.content.toLowerCase().includes(queryLower);
            if (keyMatch || contentMatch) {
              results.push({
                key,
                content: entry.content,
                score: keyMatch && contentMatch ? 1.0 : 0.75,
                metadata: entry.metadata,
                matchType: 'keyword',
              });
            }
          }

          // Sort by score descending, limit results.
          return results
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
        },

        async forget(key: string): Promise<boolean> {
          return entries.delete(key);
        },

        async list(prefix?: string): Promise<MemoryEntry[]> {
          const result: MemoryEntry[] = [];
          for (const [key, entry] of entries) {
            if (!prefix || key.startsWith(prefix)) {
              result.push({ key, content: entry.content, metadata: entry.metadata, createdAt: entry.createdAt, updatedAt: entry.updatedAt });
            }
          }
          return result;
        },

        async reindex(): Promise<void> { /* no-op */ },
        async close(): Promise<void> { entries.clear(); },
      };
    }

    /**
     * Multi-turn mock engine that drives a store → recall → answer flow.
     *
     * Turn 1: emit memory_store tool call
     * Turn 2: emit memory_recall tool call
     * Turn 3: emit final answer that references the recalled data
     */
    function createMemoryTestEngine(): IEngine {
      let callCount = 0;

      return {
        id: 'memory-test',
        name: 'Memory Test Engine',

        async startRun(job) {
          callCount++;
          const turn = callCount;
          const ref = generateId(12);

          async function* events(): AsyncIterable<EngineEvent> {
            yield { type: 'started' };

            if (turn === 1) {
              // Turn 1: store a fact.
              yield { type: 'text_delta', delta: 'Storing project info.' };
              yield {
                type: 'tool_start',
                id: 'tc_store',
                tool: 'memory_store',
                args: {
                  key: 'project/name',
                  content: 'ch4p is a security-first AI assistant platform.',
                  metadata: { source: 'test', importance: 'high' },
                },
              };
              yield {
                type: 'completed',
                answer: 'Storing project info.',
                usage: { inputTokens: 20, outputTokens: 10 },
              };
            } else if (turn === 2) {
              // Turn 2: recall the stored fact.
              yield { type: 'text_delta', delta: 'Looking up project info.' };
              yield {
                type: 'tool_start',
                id: 'tc_recall',
                tool: 'memory_recall',
                args: { query: 'ch4p', limit: 5 },
              };
              yield {
                type: 'completed',
                answer: 'Looking up project info.',
                usage: { inputTokens: 40, outputTokens: 15 },
              };
            } else {
              // Turn 3: final answer referencing the recalled data.
              const answer = 'Based on my memory, ch4p is a security-first AI assistant platform.';
              yield { type: 'text_delta', delta: answer };
              yield {
                type: 'completed',
                answer,
                usage: { inputTokens: 60, outputTokens: 20 },
              };
            }
          }

          return { ref, events: events(), async cancel() {}, steer() {} };
        },

        async resume() { throw new Error('Not supported'); },
      };
    }

    it('should store and recall memory entries through the agent loop', async () => {
      const engine = createMemoryTestEngine();
      const session = new Session(createTestSessionConfig());
      const registry = ToolRegistry.createDefault({ include: ['memory_store', 'memory_recall'] });
      const memoryBackend = createMockMemoryBackend();
      const observer = new NoopObserver();

      const loop = new AgentLoop(session, engine, registry.list(), observer, {
        memoryBackend,
        enableStateSnapshots: false,
      });

      const events = await collectEvents(loop, 'Remember the project name and then look it up');

      // Should have tool events for both store and recall.
      const toolStarts = events.filter((e) => e.type === 'tool_start');
      const toolEnds = events.filter((e) => e.type === 'tool_end');
      expect(toolStarts).toHaveLength(2);
      expect(toolEnds).toHaveLength(2);

      // First tool call should be memory_store.
      expect((toolStarts[0] as { tool: string }).tool).toBe('memory_store');
      // Second tool call should be memory_recall.
      expect((toolStarts[1] as { tool: string }).tool).toBe('memory_recall');

      // memory_store should succeed.
      const storeResult = (toolEnds[0] as { result: ToolResult }).result;
      expect(storeResult.success).toBe(true);
      expect(storeResult.output).toContain('project/name');

      // memory_recall should find the stored entry.
      const recallResult = (toolEnds[1] as { result: ToolResult }).result;
      expect(recallResult.success).toBe(true);
      expect(recallResult.output).toContain('ch4p');
      expect(recallResult.output).toContain('security-first');

      // Final answer should reference the recalled info.
      const completes = events.filter((e) => e.type === 'complete');
      expect(completes).toHaveLength(1);
      expect((completes[0] as { answer: string }).answer).toContain('security-first');
    });

    it('should track session metadata for memory tool invocations', async () => {
      const engine = createMemoryTestEngine();
      const session = new Session(createTestSessionConfig());
      const registry = ToolRegistry.createDefault({ include: ['memory_store', 'memory_recall'] });
      const memoryBackend = createMockMemoryBackend();
      const observer = new NoopObserver();

      const loop = new AgentLoop(session, engine, registry.list(), observer, {
        memoryBackend,
        enableStateSnapshots: false,
      });

      await collectEvents(loop, 'Store and recall');

      const meta = session.getMetadata();
      expect(meta.state).toBe('completed');
      expect(meta.loopIterations).toBe(3); // store turn + recall turn + final answer turn
      expect(meta.llmCalls).toBe(3);
      expect(meta.toolInvocations).toBe(2); // store + recall
      expect(meta.errors).toHaveLength(0);
    });

    it('should handle memory recall with no results', async () => {
      // Engine that only does a recall (no prior store).
      let callCount = 0;
      const recallOnlyEngine: IEngine = {
        id: 'recall-only',
        name: 'Recall Only Engine',
        async startRun() {
          callCount++;
          const ref = generateId(12);
          async function* events(): AsyncIterable<EngineEvent> {
            yield { type: 'started' };
            if (callCount === 1) {
              yield { type: 'text_delta', delta: 'Searching memory.' };
              yield {
                type: 'tool_start',
                id: 'tc_recall_empty',
                tool: 'memory_recall',
                args: { query: 'nonexistent topic' },
              };
              yield {
                type: 'completed',
                answer: 'Searching memory.',
                usage: { inputTokens: 10, outputTokens: 5 },
              };
            } else {
              const answer = 'No relevant memories found.';
              yield { type: 'text_delta', delta: answer };
              yield {
                type: 'completed',
                answer,
                usage: { inputTokens: 20, outputTokens: 10 },
              };
            }
          }
          return { ref, events: events(), async cancel() {}, steer() {} };
        },
        async resume() { throw new Error('Not supported'); },
      };

      const session = new Session(createTestSessionConfig());
      const registry = ToolRegistry.createDefault({ include: ['memory_recall'] });
      const memoryBackend = createMockMemoryBackend();
      const observer = new NoopObserver();

      const loop = new AgentLoop(session, recallOnlyEngine, registry.list(), observer, {
        memoryBackend,
        enableStateSnapshots: false,
      });

      const events = await collectEvents(loop, 'What do you remember?');

      // Recall should succeed but return empty.
      const toolEnds = events.filter((e) => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(1);
      const recallResult = (toolEnds[0] as { result: ToolResult }).result;
      expect(recallResult.success).toBe(true);
      expect(recallResult.output).toContain('No matching memory entries found');
    });

    it('should fail gracefully when memory backend is not configured', async () => {
      const engine = createMockEngine({
        responseText: 'Storing data.',
        toolCalls: [
          {
            id: 'tc_no_mem',
            name: 'memory_store',
            args: { key: 'test', content: 'data' },
          },
        ],
        followUpText: 'Memory not available.',
      });

      const session = new Session(createTestSessionConfig());
      const registry = ToolRegistry.createDefault({ include: ['memory_store'] });
      const observer = new NoopObserver();

      // No memoryBackend provided — tools should error.
      const loop = new AgentLoop(session, engine, registry.list(), observer, {
        enableStateSnapshots: false,
      });

      const events = await collectEvents(loop, 'Store something');

      // Tool should have been called but returned an error.
      const toolEnds = events.filter((e) => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(1);
      const result = (toolEnds[0] as { result: ToolResult }).result;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Memory backend');
    });

    it('should persist data across store and recall within the same session', async () => {
      const memoryBackend = createMockMemoryBackend();

      // Verify the mock backend works independently first.
      await memoryBackend.store('fact/1', 'TypeScript is great', { tag: 'language' });
      await memoryBackend.store('fact/2', 'Vitest is a fast test runner', { tag: 'tool' });

      const results = await memoryBackend.recall('TypeScript');
      expect(results).toHaveLength(1);
      expect(results[0]!.key).toBe('fact/1');
      expect(results[0]!.content).toContain('TypeScript');

      const allResults = await memoryBackend.recall('fast');
      expect(allResults).toHaveLength(1);
      expect(allResults[0]!.key).toBe('fact/2');

      // Verify list with prefix.
      const facts = await memoryBackend.list('fact/');
      expect(facts).toHaveLength(2);

      // Verify forget.
      const forgotten = await memoryBackend.forget('fact/1');
      expect(forgotten).toBe(true);
      const afterForget = await memoryBackend.recall('TypeScript');
      expect(afterForget).toHaveLength(0);
    });

    it('should notify observer for memory tool invocations', async () => {
      const engine = createMemoryTestEngine();
      const session = new Session(createTestSessionConfig());
      const registry = ToolRegistry.createDefault({ include: ['memory_store', 'memory_recall'] });
      const memoryBackend = createMockMemoryBackend();
      const observer = new NoopObserver();
      const toolSpy = vi.spyOn(observer, 'onToolInvocation');

      const loop = new AgentLoop(session, engine, registry.list(), observer, {
        memoryBackend,
        enableStateSnapshots: false,
      });

      await collectEvents(loop, 'Store and recall with observation');

      // Observer should have been called for both memory tools.
      expect(toolSpy).toHaveBeenCalledTimes(2);

      const firstCall = toolSpy.mock.calls[0]![0];
      expect(firstCall.tool).toBe('memory_store');
      expect(firstCall.result.success).toBe(true);
      expect(firstCall.duration).toBeGreaterThanOrEqual(0);

      const secondCall = toolSpy.mock.calls[1]![0];
      expect(secondCall.tool).toBe('memory_recall');
      expect(secondCall.result.success).toBe(true);
    });
  });
});
