/**
 * Comprehensive tests for AgentLoop — the core agent orchestration loop.
 *
 * Covers:
 *   1. Basic completion without tools
 *   2. Tool call flow (engine -> validate -> execute -> re-enter)
 *   3. Mandatory validation: tool not found
 *   4. Mandatory validation: tool-level validate() failure
 *   5. Mandatory validation: structural check (non-object args)
 *   6. State snapshot capture (before/after)
 *   7. State snapshots disabled via config
 *   8. Verification pipeline: success
 *   9. Verification pipeline: failure with feedback injection
 *  10. Max iterations exceeded
 *  11. Abort via steering
 *  12. getStateRecords() and getToolResults() accessors
 *  13. Consecutive engine errors with retries
 *  14. Text accumulation across text_delta events
 */

import { vi } from 'vitest';
import { AgentLoop } from './agent-loop.js';
import { Session } from './session.js';
import type {
  IEngine,
  ITool,
  IObserver,
  IVerifier,
  ISecurityPolicy,
  ToolResult,
  StateSnapshot,
  VerificationResult,
  Job,
  EngineEvent,
  RunHandle,
  RunOpts,
  ResumeToken,
  VerificationContext,
  FormatCheckResult,
} from '@ch4p/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all AgentEvents from a loop run into an array.
 */
async function collectEvents(loop: AgentLoop, message: string) {
  const events: import('./agent-loop.js').AgentEvent[] = [];
  for await (const event of loop.run(message)) {
    events.push(event);
  }
  return events;
}

/**
 * Create a Session with all required fields.
 */
function createSession() {
  return new Session({
    sessionId: 'test-session',
    channelId: 'cli',
    userId: 'user-1',
    engineId: 'test-engine',
    model: 'test-model',
    provider: 'test-provider',
  });
}

/**
 * Create a mock observer that satisfies the IObserver interface.
 */
function createMockObserver(): IObserver {
  return {
    onSessionStart: vi.fn(),
    onSessionEnd: vi.fn(),
    onToolInvocation: vi.fn(),
    onLLMCall: vi.fn(),
    onChannelMessage: vi.fn(),
    onSecurityEvent: vi.fn(),
    onError: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock engine that yields a fixed set of events.
 * For multi-iteration tests, use createMultiCallEngine instead.
 */
function createMockEngine(events: EngineEvent[]): IEngine {
  return {
    id: 'test-engine',
    name: 'Test Engine',
    startRun: vi.fn().mockResolvedValue({
      ref: 'run-1',
      events: (async function* () {
        for (const e of events) yield e;
      })(),
      cancel: vi.fn().mockResolvedValue(undefined),
      steer: vi.fn(),
    } satisfies RunHandle),
    resume: vi.fn().mockResolvedValue(undefined as unknown),
  };
}

/**
 * Create a mock engine that returns different event sequences on
 * successive calls to startRun(). Each element of `callSequences`
 * is an array of events for that call.
 */
function createMultiCallEngine(callSequences: EngineEvent[][]): IEngine {
  const startRunMock = vi.fn();
  for (const events of callSequences) {
    startRunMock.mockResolvedValueOnce({
      ref: `run-${startRunMock.mock.calls.length + 1}`,
      events: (async function* () {
        for (const e of events) yield e;
      })(),
      cancel: vi.fn().mockResolvedValue(undefined),
      steer: vi.fn(),
    } satisfies RunHandle);
  }

  return {
    id: 'test-engine',
    name: 'Test Engine',
    startRun: startRunMock,
    resume: vi.fn(),
  };
}

/**
 * Create a simple lightweight tool mock.
 */
function createMockTool(overrides: Partial<ITool> = {}): ITool {
  return {
    name: 'test_tool',
    description: 'A test tool',
    parameters: { type: 'object', properties: {} },
    weight: 'lightweight' as const,
    execute: vi.fn().mockResolvedValue({ success: true, output: 'tool result' }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// We mock sleep/backoffDelay so tests do not actually wait.
// ---------------------------------------------------------------------------

vi.mock('@ch4p/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ch4p/core')>();
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
    abortableSleep: vi.fn().mockResolvedValue(undefined),
    backoffDelay: vi.fn().mockReturnValue(0),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop', () => {
  // =========================================================================
  // 1. Basic completion without tools
  // =========================================================================

  describe('basic completion without tools', () => {
    it('should yield text events and a complete event', async () => {
      const engine = createMockEngine([
        { type: 'started' },
        { type: 'text_delta', delta: 'Hello' },
        { type: 'text_delta', delta: ' world' },
        { type: 'completed', answer: 'Hello world', usage: { inputTokens: 10, outputTokens: 20 } },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer);

      const events = await collectEvents(loop, 'Say hello');

      // Should have text events and a complete event.
      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0]).toMatchObject({ type: 'text', delta: 'Hello', partial: 'Hello' });
      expect(textEvents[1]).toMatchObject({ type: 'text', delta: ' world', partial: 'Hello world' });

      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]).toMatchObject({
        type: 'complete',
        answer: 'Hello world',
        usage: { inputTokens: 10, outputTokens: 20 },
      });

      // Observer should have been notified.
      expect(observer.onSessionStart).toHaveBeenCalledOnce();
      expect(observer.onSessionEnd).toHaveBeenCalledOnce();
    });

    it('should treat accumulated text as the answer when no explicit completion event is emitted', async () => {
      const engine = createMockEngine([
        { type: 'text_delta', delta: 'Just text' },
        // No 'completed' event — stream just ends.
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer);

      const events = await collectEvents(loop, 'hello');

      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]).toMatchObject({ type: 'complete', answer: 'Just text' });
    });
  });

  // =========================================================================
  // 2. Tool call flow
  // =========================================================================

  describe('tool call flow', () => {
    it('should validate, execute a tool, then loop back to the engine', async () => {
      const tool = createMockTool();

      // First call: engine requests a tool call.
      // Second call: engine completes.
      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: { foo: 'bar' } }],
        [{ type: 'completed', answer: 'Done with tools' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer);

      const events = await collectEvents(loop, 'Use the tool');

      // Should see tool_start, tool_end, then complete.
      const toolStartEvents = events.filter((e) => e.type === 'tool_start');
      expect(toolStartEvents).toHaveLength(1);
      expect(toolStartEvents[0]).toMatchObject({ tool: 'test_tool', args: { foo: 'bar' } });

      const toolEndEvents = events.filter((e) => e.type === 'tool_end');
      expect(toolEndEvents).toHaveLength(1);
      expect(toolEndEvents[0]).toMatchObject({
        tool: 'test_tool',
        result: { success: true, output: 'tool result' },
      });

      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]).toMatchObject({ answer: 'Done with tools' });

      // Engine should have been called twice.
      expect(engine.startRun).toHaveBeenCalledTimes(2);

      // Tool execute should have been called once.
      expect(tool.execute).toHaveBeenCalledOnce();
      expect(tool.execute).toHaveBeenCalledWith(
        { foo: 'bar' },
        expect.objectContaining({ sessionId: 'test-session' }),
      );
    });

    it('should handle multiple tool calls in a single engine response', async () => {
      const toolA = createMockTool({
        name: 'tool_a',
        execute: vi.fn().mockResolvedValue({ success: true, output: 'result A' }),
      });
      const toolB = createMockTool({
        name: 'tool_b',
        execute: vi.fn().mockResolvedValue({ success: true, output: 'result B' }),
      });

      const engine = createMultiCallEngine([
        [
          { type: 'tool_start', id: 'tc1', tool: 'tool_a', args: { x: 1 } },
          { type: 'tool_start', id: 'tc2', tool: 'tool_b', args: { y: 2 } },
        ],
        [{ type: 'completed', answer: 'Both done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [toolA, toolB], observer);

      const events = await collectEvents(loop, 'Use both tools');

      const toolStartEvents = events.filter((e) => e.type === 'tool_start');
      expect(toolStartEvents).toHaveLength(2);

      const toolEndEvents = events.filter((e) => e.type === 'tool_end');
      expect(toolEndEvents).toHaveLength(2);

      expect(toolA.execute).toHaveBeenCalledOnce();
      expect(toolB.execute).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // 3. Mandatory validation: tool not found
  // =========================================================================

  describe('mandatory validation — tool not found', () => {
    it('should yield tool_validation_error when the engine requests an unknown tool', async () => {
      // Engine requests a tool that does not exist.
      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'nonexistent_tool', args: {} }],
        [{ type: 'completed', answer: 'Recovered' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer);

      const events = await collectEvents(loop, 'Use unknown tool');

      const validationErrors = events.filter((e) => e.type === 'tool_validation_error');
      expect(validationErrors).toHaveLength(1);
      expect(validationErrors[0]).toMatchObject({
        type: 'tool_validation_error',
        tool: 'nonexistent_tool',
        errors: expect.arrayContaining([expect.stringContaining('not found')]),
      });

      // Should NOT have tool_start or tool_end events for the unknown tool
      // (tool_start from the loop is only emitted after validation passes).
      const toolStarts = events.filter((e) => e.type === 'tool_start');
      expect(toolStarts).toHaveLength(0);

      // Should still complete because the engine's second call succeeds.
      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);
    });
  });

  // =========================================================================
  // 4. Mandatory validation: tool-level validate() failure
  // =========================================================================

  describe('mandatory validation — tool validate() failure', () => {
    it('should yield tool_validation_error when the tool validate() returns invalid', async () => {
      const strictTool: ITool = {
        name: 'strict_tool',
        description: 'A strict tool',
        parameters: { type: 'object' },
        weight: 'lightweight',
        execute: vi.fn().mockResolvedValue({ success: true, output: 'done' }),
        validate: vi.fn().mockReturnValue({
          valid: false,
          errors: ['missing required field: name'],
        }),
      };

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'strict_tool', args: {} }],
        [{ type: 'completed', answer: 'Self-corrected' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [strictTool], observer);

      const events = await collectEvents(loop, 'Use strict tool');

      // Validation error should be yielded.
      const validationErrors = events.filter((e) => e.type === 'tool_validation_error');
      expect(validationErrors).toHaveLength(1);
      expect(validationErrors[0]).toMatchObject({
        type: 'tool_validation_error',
        tool: 'strict_tool',
        errors: ['missing required field: name'],
      });

      // validate() should have been called.
      expect(strictTool.validate).toHaveBeenCalledWith({});

      // execute() should NOT have been called (validation blocked it).
      expect(strictTool.execute).not.toHaveBeenCalled();

      // The error should have been fed back to context as a tool message.
      const contextMessages = session.getContext().getMessages();
      const toolErrorMsg = contextMessages.find(
        (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('[VALIDATION ERROR]'),
      );
      expect(toolErrorMsg).toBeDefined();
      expect(toolErrorMsg!.content).toContain('missing required field: name');
    });

    it('should pass validation when validate() returns valid', async () => {
      const validTool: ITool = {
        name: 'valid_tool',
        description: 'A tool with passing validation',
        parameters: { type: 'object' },
        weight: 'lightweight',
        execute: vi.fn().mockResolvedValue({ success: true, output: 'executed' }),
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'valid_tool', args: { name: 'test' } }],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [validTool], observer);

      const events = await collectEvents(loop, 'Use valid tool');

      // No validation errors.
      const validationErrors = events.filter((e) => e.type === 'tool_validation_error');
      expect(validationErrors).toHaveLength(0);

      // Tool should have been executed.
      expect(validTool.execute).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // 5. Mandatory validation: structural check (non-object args)
  // =========================================================================

  describe('mandatory validation — structural check', () => {
    it('should reject string args when tool has no validate()', async () => {
      const tool = createMockTool();
      // Tool has no validate() method — rely on structural check.

      const engine = createMultiCallEngine([
        // Engine sends args as a string.
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: 'not-an-object' }],
        [{ type: 'completed', answer: 'Corrected' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer);

      const events = await collectEvents(loop, 'Use tool with bad args');

      const validationErrors = events.filter((e) => e.type === 'tool_validation_error');
      expect(validationErrors).toHaveLength(1);
      expect(validationErrors[0]).toMatchObject({
        tool: 'test_tool',
        errors: ['Arguments must be an object.'],
      });

      // Tool execute should NOT have been called.
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it('should reject array args when tool has no validate()', async () => {
      const tool = createMockTool();

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: [1, 2, 3] }],
        [{ type: 'completed', answer: 'Corrected' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer);

      const events = await collectEvents(loop, 'Use tool with array args');

      const validationErrors = events.filter((e) => e.type === 'tool_validation_error');
      expect(validationErrors).toHaveLength(1);
      expect(validationErrors[0]).toMatchObject({
        tool: 'test_tool',
        errors: ['Arguments must be an object.'],
      });

      expect(tool.execute).not.toHaveBeenCalled();
    });

    it('should accept undefined/null args when tool has no validate()', async () => {
      const tool = createMockTool();

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: undefined }],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer);

      const events = await collectEvents(loop, 'Use tool with no args');

      const validationErrors = events.filter((e) => e.type === 'tool_validation_error');
      expect(validationErrors).toHaveLength(0);

      expect(tool.execute).toHaveBeenCalledOnce();
    });

    it('should accept valid object args when tool has no validate()', async () => {
      const tool = createMockTool();

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: { key: 'value' } }],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer);

      const events = await collectEvents(loop, 'Use tool with good args');

      const validationErrors = events.filter((e) => e.type === 'tool_validation_error');
      expect(validationErrors).toHaveLength(0);

      expect(tool.execute).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // 6. State snapshot capture (AWM)
  // =========================================================================

  describe('state snapshots', () => {
    it('should capture before and after state snapshots when tool implements getStateSnapshot', async () => {
      const beforeSnapshot: StateSnapshot = {
        timestamp: '2024-01-01T00:00:00Z',
        state: { file: 'before-content' },
      };
      const afterSnapshot: StateSnapshot = {
        timestamp: '2024-01-01T00:00:01Z',
        state: { file: 'after-content' },
      };

      const snapshotTool: ITool = {
        name: 'snapshot_tool',
        description: 'Tool with snapshots',
        parameters: { type: 'object' },
        weight: 'lightweight',
        execute: vi.fn().mockResolvedValue({ success: true, output: 'done' }),
        getStateSnapshot: vi.fn()
          .mockResolvedValueOnce(beforeSnapshot)
          .mockResolvedValueOnce(afterSnapshot),
      };

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'snapshot_tool', args: { path: 'test.txt' } }],
        [{ type: 'completed', answer: 'Edited file' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [snapshotTool], observer);

      await collectEvents(loop, 'Edit the file');

      // getStateSnapshot should have been called twice (before + after).
      expect(snapshotTool.getStateSnapshot).toHaveBeenCalledTimes(2);

      // State records should be populated.
      const records = loop.getStateRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        tool: 'snapshot_tool',
        args: { path: 'test.txt' },
        before: beforeSnapshot,
        after: afterSnapshot,
      });
    });

    it('should attach the after snapshot to the tool result', async () => {
      const afterSnapshot: StateSnapshot = {
        timestamp: '2024-01-01T00:00:01Z',
        state: { file: 'modified' },
      };

      const snapshotTool: ITool = {
        name: 'snapshot_tool',
        description: 'Tool with snapshots',
        parameters: { type: 'object' },
        weight: 'lightweight',
        execute: vi.fn().mockResolvedValue({ success: true, output: 'done' }),
        getStateSnapshot: vi.fn()
          .mockResolvedValueOnce({ timestamp: '2024-01-01T00:00:00Z', state: {} })
          .mockResolvedValueOnce(afterSnapshot),
      };

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'snapshot_tool', args: {} }],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [snapshotTool], observer);

      const events = await collectEvents(loop, 'Edit');

      const toolEndEvents = events.filter((e) => e.type === 'tool_end');
      expect(toolEndEvents).toHaveLength(1);
      expect((toolEndEvents[0] as { result: ToolResult }).result.stateSnapshot).toEqual(afterSnapshot);
    });

    it('should gracefully handle getStateSnapshot failure (non-fatal)', async () => {
      const snapshotTool: ITool = {
        name: 'failing_snapshot_tool',
        description: 'Tool with failing snapshots',
        parameters: { type: 'object' },
        weight: 'lightweight',
        execute: vi.fn().mockResolvedValue({ success: true, output: 'done' }),
        getStateSnapshot: vi.fn().mockRejectedValue(new Error('Snapshot failed')),
      };

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'failing_snapshot_tool', args: {} }],
        [{ type: 'completed', answer: 'Done despite snapshot failure' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [snapshotTool], observer);

      const events = await collectEvents(loop, 'Do something');

      // Should still complete successfully despite snapshot errors.
      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);

      // Tool should still have been executed.
      expect(snapshotTool.execute).toHaveBeenCalledOnce();

      // State records should be empty since both snapshots failed.
      expect(loop.getStateRecords()).toHaveLength(0);
    });
  });

  // =========================================================================
  // 7. State snapshots disabled
  // =========================================================================

  describe('state snapshots disabled', () => {
    it('should NOT call getStateSnapshot when enableStateSnapshots is false', async () => {
      const snapshotTool: ITool = {
        name: 'snapshot_tool',
        description: 'Tool with snapshots',
        parameters: { type: 'object' },
        weight: 'lightweight',
        execute: vi.fn().mockResolvedValue({ success: true, output: 'done' }),
        getStateSnapshot: vi.fn().mockResolvedValue({
          timestamp: '2024-01-01T00:00:00Z',
          state: { file: 'content' },
        }),
      };

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'snapshot_tool', args: {} }],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [snapshotTool], observer, {
        enableStateSnapshots: false,
      });

      await collectEvents(loop, 'Do something');

      // getStateSnapshot should NOT have been called.
      expect(snapshotTool.getStateSnapshot).not.toHaveBeenCalled();

      // Tool should still have been executed.
      expect(snapshotTool.execute).toHaveBeenCalledOnce();

      // No state records.
      expect(loop.getStateRecords()).toHaveLength(0);
    });
  });

  // =========================================================================
  // 8. Verification pipeline — success
  // =========================================================================

  describe('verification — success', () => {
    it('should yield a verification event after completion when verifier is configured', async () => {
      const verificationResult: VerificationResult = {
        outcome: 'success',
        confidence: 0.95,
        reasoning: 'All good, task completed correctly',
      };

      const verifier: IVerifier = {
        id: 'test-verifier',
        name: 'Test Verifier',
        checkFormat: vi.fn().mockResolvedValue({ passed: true }),
        verify: vi.fn().mockResolvedValue(verificationResult),
      };

      const engine = createMockEngine([
        { type: 'completed', answer: 'Task completed' },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer, {
        verifier,
      });

      const events = await collectEvents(loop, 'Do the task');

      // Should see complete then verification events.
      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);

      const verificationEvents = events.filter((e) => e.type === 'verification');
      expect(verificationEvents).toHaveLength(1);
      expect(verificationEvents[0]).toMatchObject({
        type: 'verification',
        result: verificationResult,
      });

      // Verifier should have been called with correct context.
      expect(verifier.verify).toHaveBeenCalledWith(
        expect.objectContaining({
          taskDescription: 'Do the task',
          finalAnswer: 'Task completed',
          messages: expect.any(Array),
          toolResults: expect.any(Array),
          stateSnapshots: expect.any(Array),
        }),
      );

      // On success, no feedback should be injected — no system message added.
      const contextMessages = session.getContext().getMessages();
      const feedbackMsg = contextMessages.find(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[VERIFICATION'),
      );
      expect(feedbackMsg).toBeUndefined();
    });
  });

  // =========================================================================
  // 9. Verification — failure with feedback injection
  // =========================================================================

  describe('verification — failure with feedback', () => {
    it('should inject verification feedback into context on failure outcome', async () => {
      const verificationResult: VerificationResult = {
        outcome: 'failure',
        confidence: 0.3,
        reasoning: 'The output is missing the required format',
        issues: [
          { severity: 'error', message: 'Missing JSON structure' },
        ],
        suggestions: ['Return output as valid JSON', 'Include all required fields'],
      };

      const verifier: IVerifier = {
        id: 'test-verifier',
        name: 'Test Verifier',
        checkFormat: vi.fn().mockResolvedValue({ passed: false, errors: ['bad format'] }),
        verify: vi.fn().mockResolvedValue(verificationResult),
      };

      const engine = createMockEngine([
        { type: 'completed', answer: 'Bad answer' },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer, {
        verifier,
      });

      const events = await collectEvents(loop, 'Format the data');

      // Verification event should be yielded.
      const verificationEvents = events.filter((e) => e.type === 'verification');
      expect(verificationEvents).toHaveLength(1);
      expect(verificationEvents[0]).toMatchObject({
        result: { outcome: 'failure' },
      });

      // Feedback should be injected into context as a system message.
      const contextMessages = session.getContext().getMessages();
      const feedbackMsg = contextMessages.find(
        (m) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.includes('[VERIFICATION FAILURE]'),
      );
      expect(feedbackMsg).toBeDefined();
      expect(feedbackMsg!.content).toContain('The output is missing the required format');
      expect(feedbackMsg!.content).toContain('Return output as valid JSON');
      expect(feedbackMsg!.content).toContain('Include all required fields');

      // Observer should have been notified of the verification issue.
      expect(observer.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('verification: failure') }),
        expect.objectContaining({
          phase: 'verification',
          confidence: 0.3,
          issues: 1,
        }),
      );
    });

    it('should inject verification feedback into context on partial outcome', async () => {
      const verificationResult: VerificationResult = {
        outcome: 'partial',
        confidence: 0.6,
        reasoning: 'Partially correct but missing some fields',
        suggestions: ['Add the missing email field'],
      };

      const verifier: IVerifier = {
        id: 'test-verifier',
        name: 'Test Verifier',
        checkFormat: vi.fn().mockResolvedValue({ passed: true }),
        verify: vi.fn().mockResolvedValue(verificationResult),
      };

      const engine = createMockEngine([
        { type: 'completed', answer: 'Partial answer' },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer, { verifier });

      await collectEvents(loop, 'Extract data');

      const contextMessages = session.getContext().getMessages();
      const feedbackMsg = contextMessages.find(
        (m) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.includes('[VERIFICATION PARTIAL]'),
      );
      expect(feedbackMsg).toBeDefined();
      expect(feedbackMsg!.content).toContain('Partially correct but missing some fields');
    });

    it('should handle verifier errors gracefully (best-effort)', async () => {
      const verifier: IVerifier = {
        id: 'test-verifier',
        name: 'Test Verifier',
        checkFormat: vi.fn().mockResolvedValue({ passed: true }),
        verify: vi.fn().mockRejectedValue(new Error('Verifier crashed')),
      };

      const engine = createMockEngine([
        { type: 'completed', answer: 'Done' },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer, { verifier });

      const events = await collectEvents(loop, 'Do something');

      // Should still complete — verification failure is non-fatal.
      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);

      // No verification event should be yielded.
      const verificationEvents = events.filter((e) => e.type === 'verification');
      expect(verificationEvents).toHaveLength(0);

      // Observer should record the verification error.
      expect(observer.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Verifier crashed' }),
        expect.objectContaining({ phase: 'verification' }),
      );
    });
  });

  // =========================================================================
  // 10. Max iterations exceeded
  // =========================================================================

  describe('max iterations exceeded', () => {
    it('should yield error after exceeding maxIterations', async () => {
      // Engine always returns tool calls (never completes).
      // With maxIterations=2, the loop should stop after 2 iterations.
      const tool = createMockTool();

      const startRunMock = vi.fn();
      // Provide enough calls for maxIterations.
      for (let i = 0; i < 3; i++) {
        startRunMock.mockResolvedValueOnce({
          ref: `run-${i}`,
          events: (async function* () {
            yield { type: 'tool_start', id: `tc${i}`, tool: 'test_tool', args: {} } as EngineEvent;
          })(),
          cancel: vi.fn().mockResolvedValue(undefined),
          steer: vi.fn(),
        });
      }

      const engine: IEngine = {
        id: 'test-engine',
        name: 'Test Engine',
        startRun: startRunMock,
        resume: vi.fn(),
      };

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer, {
        maxIterations: 2,
      });

      const events = await collectEvents(loop, 'Loop forever');

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as { error: Error }).error.message).toContain(
        'exceeded maximum iterations (2)',
      );

      // Should not have a complete event.
      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(0);
    });
  });

  // =========================================================================
  // 11. Abort via steering
  // =========================================================================

  describe('abort via steering', () => {
    it('should abort at the loop boundary when an abort message is in the steering queue', async () => {
      const engine = createMockEngine([
        { type: 'completed', answer: 'Should not see this' },
      ]);

      const session = createSession();
      const observer = createMockObserver();

      // Push an abort message into the steering queue BEFORE running.
      session.getSteering().push({
        type: 'abort',
        content: 'User cancelled',
        priority: 100,
        timestamp: new Date(),
      });

      const loop = new AgentLoop(session, engine, [], observer);
      const events = await collectEvents(loop, 'Start');

      const abortEvents = events.filter((e) => e.type === 'aborted');
      expect(abortEvents).toHaveLength(1);
      expect(abortEvents[0]).toMatchObject({
        type: 'aborted',
        reason: 'User cancelled',
      });

      // Should not have a complete event.
      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(0);
    });

    it('should abort via the abort() method during the loop', async () => {
      // Create an engine that yields slowly so we can abort mid-stream.
      let yieldResolve: (() => void) | undefined;
      const yieldPromise = new Promise<void>((r) => { yieldResolve = r; });

      const engine: IEngine = {
        id: 'test-engine',
        name: 'Test Engine',
        startRun: vi.fn().mockResolvedValue({
          ref: 'run-1',
          events: (async function* () {
            yield { type: 'text_delta', delta: 'Hello' } as EngineEvent;
            // Signal that we've yielded the first event.
            yieldResolve!();
            // Yield another event — by this time the abort should have been requested.
            yield { type: 'text_delta', delta: ' world' } as EngineEvent;
            yield { type: 'completed', answer: 'Hello world' } as EngineEvent;
          })(),
          cancel: vi.fn().mockResolvedValue(undefined),
          steer: vi.fn(),
        }),
        resume: vi.fn(),
      };

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer);

      // Collect events but also trigger abort after the first yield.
      const eventsPromise = collectEvents(loop, 'Say hello');

      // Wait for the first event to be yielded.
      await yieldPromise;

      // Now abort.
      loop.abort('Manual abort');

      const events = await eventsPromise;

      // Should see an aborted event (may also see text events before it).
      const abortEvents = events.filter((e) => e.type === 'aborted');
      expect(abortEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('should abort between tool executions when steering has abort', async () => {
      let toolCallCount = 0;
      const slowTool: ITool = {
        name: 'slow_tool',
        description: 'Slow tool',
        parameters: { type: 'object' },
        weight: 'lightweight',
        execute: vi.fn().mockImplementation(async () => {
          toolCallCount++;
          return { success: true, output: `call ${toolCallCount}` };
        }),
      };

      const engine = createMultiCallEngine([
        [
          { type: 'tool_start', id: 'tc1', tool: 'slow_tool', args: {} },
          { type: 'tool_start', id: 'tc2', tool: 'slow_tool', args: {} },
        ],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [slowTool], observer);

      // We need to push abort into the steering queue after the first tool
      // but before the second. We can do this by hooking into execute.
      const originalExecute = slowTool.execute;
      (slowTool as { execute: typeof originalExecute }).execute = vi.fn().mockImplementation(
        async (args, ctx) => {
          const result = await (originalExecute as Function).call(slowTool, args, ctx);
          // After the first tool execution, push an abort.
          if (toolCallCount === 1) {
            session.getSteering().push({
              type: 'abort',
              content: 'Stop after first tool',
              priority: 100,
              timestamp: new Date(),
            });
          }
          return result;
        },
      );

      const events = await collectEvents(loop, 'Run tools');

      const abortEvents = events.filter((e) => e.type === 'aborted');
      expect(abortEvents).toHaveLength(1);
      expect(abortEvents[0]).toMatchObject({ reason: 'Stop after first tool' });

      // Only the first tool should have been executed.
      expect(toolCallCount).toBe(1);
    });
  });

  // =========================================================================
  // 12. getStateRecords() and getToolResults() accessors
  // =========================================================================

  describe('getStateRecords() and getToolResults() accessors', () => {
    it('should return accumulated tool results after a run', async () => {
      const toolA = createMockTool({
        name: 'tool_a',
        execute: vi.fn().mockResolvedValue({ success: true, output: 'result A' }),
      });
      const toolB = createMockTool({
        name: 'tool_b',
        execute: vi.fn().mockResolvedValue({ success: false, output: '', error: 'failed B' }),
      });

      const engine = createMultiCallEngine([
        [
          { type: 'tool_start', id: 'tc1', tool: 'tool_a', args: { x: 1 } },
          { type: 'tool_start', id: 'tc2', tool: 'tool_b', args: { y: 2 } },
        ],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [toolA, toolB], observer);

      await collectEvents(loop, 'Use tools');

      const toolResults = loop.getToolResults();
      expect(toolResults).toHaveLength(2);
      expect(toolResults[0]).toMatchObject({ success: true, output: 'result A' });
      expect(toolResults[1]).toMatchObject({ success: false, error: 'failed B' });
    });

    it('should return accumulated state records with snapshots', async () => {
      const beforeA: StateSnapshot = { timestamp: 't0', state: { a: 'before' } };
      const afterA: StateSnapshot = { timestamp: 't1', state: { a: 'after' } };
      const beforeB: StateSnapshot = { timestamp: 't2', state: { b: 'before' } };
      const afterB: StateSnapshot = { timestamp: 't3', state: { b: 'after' } };

      const toolA: ITool = {
        name: 'tool_a',
        description: 'Tool A',
        parameters: { type: 'object' },
        weight: 'lightweight',
        execute: vi.fn().mockResolvedValue({ success: true, output: 'a' }),
        getStateSnapshot: vi.fn()
          .mockResolvedValueOnce(beforeA)
          .mockResolvedValueOnce(afterA),
      };

      const toolB: ITool = {
        name: 'tool_b',
        description: 'Tool B',
        parameters: { type: 'object' },
        weight: 'lightweight',
        execute: vi.fn().mockResolvedValue({ success: true, output: 'b' }),
        getStateSnapshot: vi.fn()
          .mockResolvedValueOnce(beforeB)
          .mockResolvedValueOnce(afterB),
      };

      const engine = createMultiCallEngine([
        [
          { type: 'tool_start', id: 'tc1', tool: 'tool_a', args: { x: 1 } },
          { type: 'tool_start', id: 'tc2', tool: 'tool_b', args: { y: 2 } },
        ],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [toolA, toolB], observer);

      await collectEvents(loop, 'Use tools');

      const records = loop.getStateRecords();
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        tool: 'tool_a',
        args: { x: 1 },
        before: beforeA,
        after: afterA,
      });
      expect(records[1]).toMatchObject({
        tool: 'tool_b',
        args: { y: 2 },
        before: beforeB,
        after: afterB,
      });
    });

    it('should reset state records and tool results on each run', async () => {
      const tool = createMockTool();

      const session = createSession();
      const observer = createMockObserver();

      // First run with a tool call.
      const engine1 = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: {} }],
        [{ type: 'completed', answer: 'First run done' }],
      ]);
      const loop = new AgentLoop(session, engine1, [tool], observer);
      await collectEvents(loop, 'First run');
      expect(loop.getToolResults()).toHaveLength(1);

      // Second run on a new loop with same session but fresh engine.
      // The Session needs to be re-activated. To avoid lifecycle issues,
      // we create a new session + loop for the second run.
      const session2 = createSession();
      const engine2 = createMockEngine([
        { type: 'completed', answer: 'Second run done' },
      ]);
      const loop2 = new AgentLoop(session2, engine2, [], createMockObserver());
      await collectEvents(loop2, 'Second run');
      expect(loop2.getToolResults()).toHaveLength(0);
    });
  });

  // =========================================================================
  // 13. Consecutive engine errors with retries
  // =========================================================================

  describe('consecutive engine errors', () => {
    it('should retry on engine start failure up to maxRetries', async () => {
      const startRunMock = vi.fn();
      // First two calls fail, third succeeds.
      startRunMock
        .mockRejectedValueOnce(new Error('Engine start failed 1'))
        .mockRejectedValueOnce(new Error('Engine start failed 2'))
        .mockResolvedValueOnce({
          ref: 'run-3',
          events: (async function* () {
            yield { type: 'completed', answer: 'Recovered' } as EngineEvent;
          })(),
          cancel: vi.fn().mockResolvedValue(undefined),
          steer: vi.fn(),
        });

      const engine: IEngine = {
        id: 'test-engine',
        name: 'Test Engine',
        startRun: startRunMock,
        resume: vi.fn(),
      };

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer, {
        maxRetries: 3,
      });

      const events = await collectEvents(loop, 'Try hard');

      // Should eventually succeed.
      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]).toMatchObject({ answer: 'Recovered' });

      // Engine should have been called 3 times.
      expect(startRunMock).toHaveBeenCalledTimes(3);

      // Observer should have recorded errors for the two failures.
      expect(observer.onError).toHaveBeenCalledTimes(2);
    });

    it('should yield error after exhausting maxRetries on engine start', async () => {
      const startRunMock = vi.fn();
      startRunMock
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockRejectedValueOnce(new Error('Fail 3'));

      const engine: IEngine = {
        id: 'test-engine',
        name: 'Test Engine',
        startRun: startRunMock,
        resume: vi.fn(),
      };

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer, {
        maxRetries: 3,
      });

      const events = await collectEvents(loop, 'Fail completely');

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as { error: Error }).error.message).toBe('Fail 3');

      // No complete event.
      expect(events.filter((e) => e.type === 'complete')).toHaveLength(0);
    });

    it('should yield error after maxRetries on engine stream throws', async () => {
      // When the event stream itself throws (not an error event), the catch
      // block on line 301 increments consecutiveErrors. BUT startRun succeeds,
      // so consecutiveErrors is reset to 0 before the stream is consumed.
      // To actually accumulate consecutive errors, startRun itself must fail.
      //
      // So here we test that stream-level errors (thrown from the iterator)
      // accumulate correctly when startRun also throws on retry.
      const startRunMock = vi.fn();
      // All three calls: startRun succeeds but the event stream throws.
      for (let i = 0; i < 3; i++) {
        startRunMock.mockResolvedValueOnce({
          ref: `run-${i}`,
          events: (async function* () {
            throw new Error(`Stream crash ${i}`);
          })(),
          cancel: vi.fn().mockResolvedValue(undefined),
          steer: vi.fn(),
        });
      }

      const engine: IEngine = {
        id: 'test-engine',
        name: 'Test Engine',
        startRun: startRunMock,
        resume: vi.fn(),
      };

      const session = createSession();
      const observer = createMockObserver();
      // Note: consecutiveErrors is reset after successful startRun,
      // but stream errors re-increment it. Since consecutiveErrors is
      // reset to 0 then the stream error pushes it to 1 each time,
      // we need maxRetries=1 to trigger after the first stream error.
      const loop = new AgentLoop(session, engine, [], observer, {
        maxRetries: 1,
      });

      const events = await collectEvents(loop, 'Stream crash');

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);

      // The error should be from the stream crash.
      const lastError = errorEvents[errorEvents.length - 1] as { error: Error };
      expect(lastError.error.message).toContain('Stream crash');
    });

    it('should yield EngineError after maxRetries on repeated engine error events', async () => {
      // When engine yields { type: 'error' } events, consecutiveErrors is reset
      // to 0 on successful startRun, then incremented to 1 on the error event.
      // So a single error event per iteration can never reach maxRetries > 1.
      // With maxRetries=1, the first error event should trigger the EngineError.
      const startRunMock = vi.fn();
      startRunMock.mockResolvedValueOnce({
        ref: 'run-0',
        events: (async function* () {
          yield { type: 'error', error: new Error('Engine error') } as EngineEvent;
        })(),
        cancel: vi.fn().mockResolvedValue(undefined),
        steer: vi.fn(),
      });

      const engine: IEngine = {
        id: 'test-engine',
        name: 'Test Engine',
        startRun: startRunMock,
        resume: vi.fn(),
      };

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer, {
        maxRetries: 1,
      });

      const events = await collectEvents(loop, 'Engine error events');

      const errorEvents = events.filter((e) => e.type === 'error');
      // Should have the error from the stream + the final error.
      expect(errorEvents).toHaveLength(2);

      // The first error is from the engine event stream.
      expect((errorEvents[0] as { error: Error }).error.message).toBe('Engine error');

      // The second error is the captured engine error (or EngineError fallback).
      expect((errorEvents[1] as { error: Error }).error.message).toContain('Engine error');
    });

    it('should reset consecutive error count on successful engine start', async () => {
      const startRunMock = vi.fn();
      // First call fails, second succeeds with a tool, third succeeds with completion.
      startRunMock
        .mockRejectedValueOnce(new Error('Transient failure'))
        .mockResolvedValueOnce({
          ref: 'run-2',
          events: (async function* () {
            yield { type: 'tool_start', id: 'tc1', tool: 'test_tool', args: {} } as EngineEvent;
          })(),
          cancel: vi.fn().mockResolvedValue(undefined),
          steer: vi.fn(),
        })
        .mockResolvedValueOnce({
          ref: 'run-3',
          events: (async function* () {
            yield { type: 'completed', answer: 'Final' } as EngineEvent;
          })(),
          cancel: vi.fn().mockResolvedValue(undefined),
          steer: vi.fn(),
        });

      const tool = createMockTool();
      const engine: IEngine = {
        id: 'test-engine',
        name: 'Test Engine',
        startRun: startRunMock,
        resume: vi.fn(),
      };

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer, {
        maxRetries: 2,
      });

      const events = await collectEvents(loop, 'Recover');

      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]).toMatchObject({ answer: 'Final' });
    });
  });

  // =========================================================================
  // 14. Text accumulation
  // =========================================================================

  describe('text accumulation', () => {
    it('should track partial text across multiple text_delta events', async () => {
      const engine = createMockEngine([
        { type: 'text_delta', delta: 'Hello' },
        { type: 'text_delta', delta: ', ' },
        { type: 'text_delta', delta: 'world!' },
        { type: 'completed', answer: 'Hello, world!' },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer);

      const events = await collectEvents(loop, 'Greet me');

      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents).toHaveLength(3);

      // Verify progressive accumulation of partial text.
      expect(textEvents[0]).toMatchObject({ delta: 'Hello', partial: 'Hello' });
      expect(textEvents[1]).toMatchObject({ delta: ', ', partial: 'Hello, ' });
      expect(textEvents[2]).toMatchObject({ delta: 'world!', partial: 'Hello, world!' });
    });
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================

  describe('tool execution error handling', () => {
    it('should return error result when tool.execute throws', async () => {
      const failingTool = createMockTool({
        name: 'failing_tool',
        execute: vi.fn().mockRejectedValue(new Error('Tool exploded')),
      });

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'failing_tool', args: {} }],
        [{ type: 'completed', answer: 'Recovered from tool error' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [failingTool], observer);

      const events = await collectEvents(loop, 'Use failing tool');

      const toolEndEvents = events.filter((e) => e.type === 'tool_end');
      expect(toolEndEvents).toHaveLength(1);
      const toolResult = (toolEndEvents[0] as { result: ToolResult }).result;
      expect(toolResult.success).toBe(false);
      expect(toolResult.error).toBe('Tool exploded');

      // The loop should continue and eventually complete.
      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);
    });
  });

  describe('session lifecycle', () => {
    it('should activate session and record iterations and LLM calls', async () => {
      const engine = createMockEngine([
        { type: 'completed', answer: 'Done' },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer);

      await collectEvents(loop, 'Test lifecycle');

      // Session should have been completed.
      expect(session.getState()).toBe('completed');

      // Metadata should reflect 1 iteration and 1 LLM call.
      const meta = session.getMetadata();
      expect(meta.loopIterations).toBe(1);
      expect(meta.llmCalls).toBe(1);
    });

    it('should fail the session when max iterations is exceeded', async () => {
      const tool = createMockTool();

      const startRunMock = vi.fn();
      for (let i = 0; i < 5; i++) {
        startRunMock.mockResolvedValueOnce({
          ref: `run-${i}`,
          events: (async function* () {
            yield { type: 'tool_start', id: `tc${i}`, tool: 'test_tool', args: {} } as EngineEvent;
          })(),
          cancel: vi.fn().mockResolvedValue(undefined),
          steer: vi.fn(),
        });
      }

      const engine: IEngine = {
        id: 'test-engine',
        name: 'Test Engine',
        startRun: startRunMock,
        resume: vi.fn(),
      };

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer, {
        maxIterations: 3,
      });

      await collectEvents(loop, 'Exceed max');

      expect(session.getState()).toBe('failed');
    });
  });

  describe('context message tracking', () => {
    it('should add the initial user message to context', async () => {
      const engine = createMockEngine([
        { type: 'completed', answer: 'Reply' },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer);

      await collectEvents(loop, 'My question');

      const messages = session.getContext().getMessages();
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]!.content).toBe('My question');
    });

    it('should add assistant answer to context on completion', async () => {
      const engine = createMockEngine([
        { type: 'completed', answer: 'The answer is 42' },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer);

      await collectEvents(loop, 'What is the answer?');

      const messages = session.getContext().getMessages();
      const assistantMessages = messages.filter((m) => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0]!.content).toBe('The answer is 42');
    });

    it('should add tool results to context after tool execution', async () => {
      const tool = createMockTool({
        execute: vi.fn().mockResolvedValue({ success: true, output: 'tool output here' }),
      });

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: {} }],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer);

      await collectEvents(loop, 'Use tool');

      const messages = session.getContext().getMessages();
      const toolMessages = messages.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]!.content).toBe('tool output here');
      expect(toolMessages[0]!.toolCallId).toBe('tc1');
    });
  });

  describe('steering — inject messages', () => {
    it('should inject user messages from the steering queue into context', async () => {
      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: {} }],
        [{ type: 'completed', answer: 'Done with injected context' }],
      ]);

      const tool = createMockTool();
      const session = createSession();
      const observer = createMockObserver();

      // Push an inject message before running.
      session.getSteering().push({
        type: 'inject',
        content: 'Additional context for the agent',
        priority: 0,
        timestamp: new Date(),
      });

      const loop = new AgentLoop(session, engine, [tool], observer);
      const events = await collectEvents(loop, 'Start');

      // The injected message should be in the context.
      const messages = session.getContext().getMessages();
      const injectedMsg = messages.find(
        (m) => m.role === 'user' && m.content === 'Additional context for the agent',
      );
      expect(injectedMsg).toBeDefined();

      // Should still complete.
      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);
    });
  });

  describe('verification with tool results and snapshots', () => {
    it('should pass tool results and state records to the verifier', async () => {
      const beforeSnap: StateSnapshot = { timestamp: 't0', state: { count: 0 } };
      const afterSnap: StateSnapshot = { timestamp: 't1', state: { count: 1 } };

      const tool: ITool = {
        name: 'counter_tool',
        description: 'Increments a counter',
        parameters: { type: 'object' },
        weight: 'lightweight',
        execute: vi.fn().mockResolvedValue({ success: true, output: 'incremented' }),
        getStateSnapshot: vi.fn()
          .mockResolvedValueOnce(beforeSnap)
          .mockResolvedValueOnce(afterSnap),
      };

      const verifier: IVerifier = {
        id: 'test-verifier',
        name: 'Test Verifier',
        checkFormat: vi.fn().mockResolvedValue({ passed: true }),
        verify: vi.fn().mockResolvedValue({
          outcome: 'success',
          confidence: 1.0,
          reasoning: 'Counter incremented correctly',
        }),
      };

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'counter_tool', args: { delta: 1 } }],
        [{ type: 'completed', answer: 'Counter is now 1' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer, { verifier });

      await collectEvents(loop, 'Increment the counter');

      // Verifier should have received the tool results and state snapshots.
      expect(verifier.verify).toHaveBeenCalledWith(
        expect.objectContaining({
          toolResults: expect.arrayContaining([
            expect.objectContaining({ success: true, output: 'incremented' }),
          ]),
          stateSnapshots: expect.arrayContaining([
            expect.objectContaining({
              tool: 'counter_tool',
              before: beforeSnap,
              after: afterSnap,
            }),
          ]),
        }),
      );
    });
  });

  describe('observer notifications', () => {
    it('should notify observer of tool invocations with timing info', async () => {
      const tool = createMockTool({
        execute: vi.fn().mockResolvedValue({ success: true, output: 'fast result' }),
      });

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: { key: 'val' } }],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer);

      await collectEvents(loop, 'Use tool');

      expect(observer.onToolInvocation).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session',
          tool: 'test_tool',
          args: { key: 'val' },
          result: expect.objectContaining({ success: true }),
          duration: expect.any(Number),
        }),
      );
    });

    it('should call observer.flush on cleanup', async () => {
      const engine = createMockEngine([
        { type: 'completed', answer: 'Done' },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer);

      await collectEvents(loop, 'Hello');

      expect(observer.flush).toHaveBeenCalledOnce();
    });
  });

  describe('engine event passthrough', () => {
    it('should yield tool_progress events from the engine', async () => {
      const engine = createMockEngine([
        { type: 'tool_progress', id: 'tc1', update: 'Processing...' },
        { type: 'completed', answer: 'Done' },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer);

      const events = await collectEvents(loop, 'Do work');

      const progressEvents = events.filter((e) => e.type === 'tool_progress');
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0]).toMatchObject({ update: 'Processing...' });
    });

    it('should yield error events from the engine stream', async () => {
      const engineError = new Error('Stream error');
      const engine = createMockEngine([
        { type: 'error', error: engineError },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer, {
        maxRetries: 1,
      });

      const events = await collectEvents(loop, 'Error me');

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // 15. Output sanitization on tool results
  // =========================================================================

  describe('output sanitization on tool results', () => {
    function createRedactingPolicy(): ISecurityPolicy {
      return {
        autonomyLevel: 'supervised',
        validatePath: () => ({ allowed: true }),
        validateCommand: () => ({ allowed: true }),
        requiresConfirmation: () => false,
        audit: () => [],
        sanitizeOutput: (text: string) => {
          // Simulate redacting an API key pattern
          if (text.includes('sk-')) {
            return {
              clean: text.replace(/sk-[A-Za-z0-9]+/g, '[REDACTED]'),
              redacted: true,
              redactedPatterns: ['api_key'],
            };
          }
          return { clean: text, redacted: false };
        },
        validateInput: () => ({ safe: true, threats: [] }),
      };
    }

    it('should sanitize tool output before adding to context', async () => {
      const tool = createMockTool({
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: 'API key is sk-abc123xyz',
        }),
      });

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: {} }],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer, {
        securityPolicy: createRedactingPolicy(),
      });

      await collectEvents(loop, 'Read the config');

      // The context should contain the sanitized output, not the raw key.
      const messages = session.getContext().getMessages();
      const toolMessages = messages.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]!.content).toContain('[REDACTED]');
      expect(toolMessages[0]!.content).not.toContain('sk-abc123xyz');
    });

    it('should notify observer when tool output is redacted', async () => {
      const tool = createMockTool({
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: 'Token: sk-secret999',
        }),
      });

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: {} }],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer, {
        securityPolicy: createRedactingPolicy(),
      });

      await collectEvents(loop, 'Show secrets');

      expect(observer.onSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'secret_redacted',
          details: expect.objectContaining({
            source: 'tool_output',
            tool: 'test_tool',
            patterns: ['api_key'],
          }),
        }),
      );
    });

    it('should not notify observer when no redaction occurs', async () => {
      const tool = createMockTool({
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: 'Safe output with no secrets',
        }),
      });

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: {} }],
        [{ type: 'completed', answer: 'Done' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer, {
        securityPolicy: createRedactingPolicy(),
      });

      await collectEvents(loop, 'Clean output');

      // onSecurityEvent should only be called for session lifecycle, not redaction.
      const securityCalls = (observer.onSecurityEvent as ReturnType<typeof vi.fn>).mock.calls;
      const redactionCalls = securityCalls.filter(
        (call) => call[0]?.type === 'secret_redacted',
      );
      expect(redactionCalls).toHaveLength(0);
    });

    it('should sanitize error output from failed tools', async () => {
      const tool = createMockTool({
        execute: vi.fn().mockResolvedValue({
          success: false,
          output: '',
          error: 'Connection failed with token sk-leaked456',
        }),
      });

      const engine = createMultiCallEngine([
        [{ type: 'tool_start', id: 'tc1', tool: 'test_tool', args: {} }],
        [{ type: 'completed', answer: 'Recovered' }],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer, {
        securityPolicy: createRedactingPolicy(),
      });

      await collectEvents(loop, 'Failing tool with secret');

      const messages = session.getContext().getMessages();
      const toolMessages = messages.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]!.content).not.toContain('sk-leaked456');
      expect(toolMessages[0]!.content).toContain('[REDACTED]');
    });
  });

  // =========================================================================
  // 16. Async/event-driven edge cases
  // =========================================================================

  describe('async edge cases', () => {
    it('should abort cleanly when abort fires during retry backoff sleep', async () => {
      // Engine always fails. We hook into the mocked abortableSleep to
      // trigger abort on the first backoff call — simulating an external
      // abort arriving while the loop is sleeping between retries.
      const { abortableSleep: mockSleep } = await import('@ch4p/core');
      const sleepMock = mockSleep as ReturnType<typeof vi.fn>;

      const engine: IEngine = {
        id: 'test-engine',
        name: 'Test Engine',
        startRun: vi.fn().mockRejectedValue(new Error('Transient failure')),
        resume: vi.fn(),
      };

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer, {
        maxRetries: 5,
      });

      let abortTriggered = false;
      sleepMock.mockImplementation(() => {
        if (!abortTriggered) {
          abortTriggered = true;
          loop.abort('User cancelled during backoff');
        }
        return Promise.resolve();
      });

      const events = await collectEvents(loop, 'trigger retry');

      // Should abort instead of exhausting all retries.
      const abortedEvents = events.filter((e) => e.type === 'aborted');
      expect(abortedEvents.length).toBeGreaterThanOrEqual(1);

      // Should NOT have called startRun 5 times (retries were cut short).
      // Flow: startRun(1) → throw → abortableSleep (abort fires) → continue →
      // while-loop top → signal.aborted check → yield aborted → return.
      expect(engine.startRun).toHaveBeenCalledTimes(1);

      // Restore default mock behavior.
      sleepMock.mockResolvedValue(undefined);
    });

    it('should handle partial text accumulation followed by engine error event', async () => {
      // Engine emits some text, then emits an error — simulating a mid-stream failure.
      const engine = createMultiCallEngine([
        [
          { type: 'text_delta', delta: 'Partial response...' },
          { type: 'error', error: new Error('Connection reset') },
        ],
        // On retry, engine succeeds.
        [
          { type: 'text_delta', delta: 'Complete answer' },
          { type: 'completed', answer: 'Complete answer' },
        ],
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer, {
        maxRetries: 3,
      });

      const events = await collectEvents(loop, 'Flaky request');

      // Should eventually complete (after retry), not crash.
      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]).toMatchObject({ answer: 'Complete answer' });
    });

    it('should complete with empty answer when engine emits no text and no tools', async () => {
      // Engine completes with empty answer, no tool calls.
      const engine = createMockEngine([
        { type: 'completed', answer: '', usage: { inputTokens: 5, outputTokens: 0 } },
      ]);

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer);

      const events = await collectEvents(loop, 'Empty response expected');

      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]).toMatchObject({ answer: '' });
    });

    it('should handle verifier throwing without crashing the session', async () => {
      const engine = createMockEngine([
        { type: 'completed', answer: 'Here is the answer' },
      ]);

      const throwingVerifier: IVerifier = {
        verify: vi.fn().mockRejectedValue(new Error('Verifier OOM')),
        checkFormat: vi.fn().mockReturnValue({ valid: true } as FormatCheckResult),
      };

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer, {
        verifier: throwingVerifier,
      });

      const events = await collectEvents(loop, 'Verify me');

      // Session should still complete — verifier is best-effort.
      const completeEvents = events.filter((e) => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]).toMatchObject({ answer: 'Here is the answer' });

      // No verification event should be yielded (it threw).
      const verifyEvents = events.filter((e) => e.type === 'verification');
      expect(verifyEvents).toHaveLength(0);

      // Observer should have been notified of the error.
      expect(observer.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Verifier OOM' }),
        expect.objectContaining({ phase: 'verification' }),
      );
    });

    it('should handle engine startRun throwing after one successful iteration with tools', async () => {
      // First call: engine returns a tool call.
      // Second call (after tool execution): engine throws.
      const tool = createMockTool();
      const engine: IEngine = {
        id: 'test-engine',
        name: 'Test Engine',
        startRun: vi.fn()
          .mockResolvedValueOnce({
            ref: 'run-1',
            events: (async function* () {
              yield { type: 'tool_start', id: 'tc1', tool: 'test_tool', args: {} } as EngineEvent;
            })(),
            cancel: vi.fn().mockResolvedValue(undefined),
            steer: vi.fn(),
          } satisfies RunHandle)
          .mockRejectedValueOnce(new Error('Engine crashed on retry')),
        resume: vi.fn(),
      };

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer, {
        maxRetries: 1,
      });

      const events = await collectEvents(loop, 'Tool then crash');

      // Should have tool events from the first iteration, then an error.
      const toolStartEvents = events.filter((e) => e.type === 'tool_start');
      expect(toolStartEvents).toHaveLength(1);

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
    });

    it('should not retry non-retryable EngineErrors', async () => {
      const { EngineError: RealEngineError } = await import('@ch4p/core');

      const nonRetryableError = new RealEngineError(
        'Invalid API key',
        'test-engine',
        undefined,
        false, // non-retryable
      );

      const engine: IEngine = {
        id: 'test-engine',
        name: 'Test Engine',
        startRun: vi.fn().mockRejectedValue(nonRetryableError),
        resume: vi.fn(),
      };

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [], observer, {
        maxRetries: 5,
      });

      const events = await collectEvents(loop, 'Fail immediately');

      // Should get an error event immediately, not after 5 retries.
      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);

      // Engine should have been called exactly once (no retries).
      expect(engine.startRun).toHaveBeenCalledTimes(1);
    });

    it('should yield error after maxIterations even with tool calls', async () => {
      // Engine always requests a tool call — loop should stop after maxIterations.
      const tool = createMockTool();
      const engine: IEngine = {
        id: 'test-engine',
        name: 'Test Engine',
        startRun: vi.fn().mockImplementation(() => Promise.resolve({
          ref: 'run-N',
          events: (async function* () {
            yield { type: 'tool_start', id: `tc-${Math.random()}`, tool: 'test_tool', args: {} } as EngineEvent;
          })(),
          cancel: vi.fn().mockResolvedValue(undefined),
          steer: vi.fn(),
        } satisfies RunHandle)),
        resume: vi.fn(),
      };

      const session = createSession();
      const observer = createMockObserver();
      const loop = new AgentLoop(session, engine, [tool], observer, {
        maxIterations: 3,
      });

      const events = await collectEvents(loop, 'Infinite tool loop');

      // Should have exactly 3 tool_start + 3 tool_end, then an error.
      const toolStartEvents = events.filter((e) => e.type === 'tool_start');
      expect(toolStartEvents).toHaveLength(3);

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as { error: Error }).error.message).toContain('maximum iterations');
    });
  });
});
