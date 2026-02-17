/**
 * Tests for SubprocessEngine and CLI engine factories.
 *
 * Tests the subprocess engine configuration, prompt extraction,
 * and the claude-cli / codex-cli factory functions.
 */

import { describe, it, expect, vi } from 'vitest';
import { SubprocessEngine, createClaudeCliEngine, createCodexCliEngine, isAuthFailure } from './subprocess.js';
import { EngineError } from '@ch4p/core';
import type { Job, EngineEvent, ToolDefinition } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(text: string, overrides: Partial<Job> = {}): Job {
  return {
    sessionId: 'test-session',
    messages: [{ role: 'user', content: text }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SubprocessEngine construction
// ---------------------------------------------------------------------------

describe('SubprocessEngine', () => {
  describe('constructor', () => {
    it('throws EngineError if command is empty', () => {
      expect(() => new SubprocessEngine({
        id: 'test',
        name: 'Test',
        command: '',
      })).toThrow(EngineError);
    });

    it('creates engine with required config', () => {
      const engine = new SubprocessEngine({
        id: 'my-cli',
        name: 'My CLI',
        command: '/usr/bin/my-cli',
      });

      expect(engine.id).toBe('my-cli');
      expect(engine.name).toBe('My CLI');
    });

    it('accepts optional config', () => {
      const engine = new SubprocessEngine({
        id: 'test',
        name: 'Test',
        command: 'test-cmd',
        args: ['--verbose'],
        env: { MY_VAR: 'value' },
        timeout: 60_000,
        promptMode: 'stdin',
        promptFlag: '--input',
        cwd: '/tmp',
      });

      expect(engine.id).toBe('test');
    });
  });

  describe('resume', () => {
    it('throws EngineError — subprocess engines do not support resume', async () => {
      const engine = new SubprocessEngine({
        id: 'test',
        name: 'Test',
        command: 'echo',
      });

      await expect(engine.resume(
        { engineId: 'test', ref: 'ref_1', state: {} },
        'continue',
      )).rejects.toThrow(EngineError);
    });
  });

  describe('startRun with echo command', () => {
    it('produces text_delta and completed events from subprocess stdout', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-test',
        name: 'Echo Test',
        command: 'echo',
        args: [],
        promptMode: 'arg',
        timeout: 5000,
      });

      const job = makeJob('hello world');
      const handle = await engine.startRun(job);

      const events: Array<{ type: string }> = [];
      for await (const event of handle.events) {
        events.push(event);
      }

      // Should have at least 'started' and 'completed'.
      const types = events.map((e) => e.type);
      expect(types).toContain('started');
      expect(types).toContain('completed');

      // The completed answer should contain our prompt text.
      const completed = events.find((e) => e.type === 'completed') as
        { type: string; answer: string } | undefined;
      expect(completed?.answer).toContain('hello world');
    });

    it('supports cancellation via signal', async () => {
      const engine = new SubprocessEngine({
        id: 'sleep-test',
        name: 'Sleep Test',
        command: 'sleep',
        args: ['10'],
        promptMode: 'stdin', // sleep ignores stdin
        timeout: 30_000,
      });

      const abortController = new AbortController();
      const job = makeJob('test');
      const handle = await engine.startRun(job, { signal: abortController.signal });

      // Cancel immediately.
      setTimeout(() => abortController.abort(), 100);

      const events: Array<{ type: string }> = [];
      for await (const event of handle.events) {
        events.push(event);
      }

      // Should get an error or just complete (process was killed).
      const types = events.map((e) => e.type);
      expect(types).toContain('started');
    });

    it('extracts prompt from last user message', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-test',
        name: 'Echo Test',
        command: 'echo',
        promptMode: 'arg',
        timeout: 5000,
      });

      const job: Job = {
        sessionId: 'test',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'first message' },
          { role: 'assistant', content: 'response' },
          { role: 'user', content: 'second message' },
        ],
      };

      const handle = await engine.startRun(job);
      const events: Array<{ type: string; answer?: string }> = [];
      for await (const event of handle.events) {
        events.push(event);
      }

      // Echo should output the last user message.
      const completed = events.find((e) => e.type === 'completed');
      expect(completed?.answer).toContain('second message');
    });

    it('handles cancel() method', async () => {
      const engine = new SubprocessEngine({
        id: 'sleep-cancel',
        name: 'Sleep Cancel',
        command: 'sleep',
        args: ['10'],
        promptMode: 'stdin',
        timeout: 30_000,
      });

      const job = makeJob('test');
      const handle = await engine.startRun(job);

      // Cancel via the handle.
      setTimeout(() => handle.cancel(), 100);

      const events: Array<{ type: string }> = [];
      for await (const event of handle.events) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('steer', () => {
    it('steer is a no-op that does not throw', async () => {
      const engine = new SubprocessEngine({
        id: 'test',
        name: 'Test',
        command: 'echo',
        timeout: 5000,
      });

      const handle = await engine.startRun(makeJob('test'));
      expect(() => handle.steer('new instruction')).not.toThrow();

      // Drain events.
      for await (const _ of handle.events) { /* drain */ }
    });
  });
});

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

describe('createClaudeCliEngine', () => {
  it('creates engine with claude-cli defaults', () => {
    const engine = createClaudeCliEngine();

    expect(engine.id).toBe('claude-cli');
    expect(engine.name).toBe('Claude CLI');
  });

  it('accepts overrides', () => {
    const engine = createClaudeCliEngine({
      id: 'custom-claude',
      name: 'Custom Claude',
      command: '/usr/local/bin/claude',
    });

    expect(engine.id).toBe('custom-claude');
    expect(engine.name).toBe('Custom Claude');
  });
});

describe('createCodexCliEngine', () => {
  it('creates engine with codex-cli defaults', () => {
    const engine = createCodexCliEngine();

    expect(engine.id).toBe('codex-cli');
    expect(engine.name).toBe('Codex CLI');
  });

  it('accepts overrides', () => {
    const engine = createCodexCliEngine({
      timeout: 120_000,
    });

    expect(engine.id).toBe('codex-cli');
  });
});

// ---------------------------------------------------------------------------
// isAuthFailure
// ---------------------------------------------------------------------------

describe('isAuthFailure', () => {
  it('detects "not logged in" pattern', () => {
    expect(isAuthFailure('Not logged in · Please run /login')).toBe(true);
  });

  it('detects "please run /login" pattern', () => {
    expect(isAuthFailure('Error: please run /login first')).toBe(true);
  });

  it('detects "authentication required" pattern', () => {
    expect(isAuthFailure('Authentication required to continue')).toBe(true);
  });

  it('detects "unauthorized" pattern', () => {
    expect(isAuthFailure('401 Unauthorized')).toBe(true);
  });

  it('detects "auth token expired" pattern', () => {
    expect(isAuthFailure('Error: auth token expired, please re-authenticate')).toBe(true);
  });

  it('detects "invalid api key" pattern', () => {
    expect(isAuthFailure('Error: Invalid API key provided')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAuthFailure('NOT LOGGED IN')).toBe(true);
    expect(isAuthFailure('UNAUTHORIZED')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isAuthFailure('Timeout waiting for response')).toBe(false);
    expect(isAuthFailure('Connection refused')).toBe(false);
    expect(isAuthFailure('Out of memory')).toBe(false);
    expect(isAuthFailure('')).toBe(false);
  });

  it('returns false for empty strings', () => {
    expect(isAuthFailure('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EngineError retryable
// ---------------------------------------------------------------------------

describe('EngineError retryable', () => {
  it('defaults to retryable=true', () => {
    const err = new EngineError('something failed', 'test-engine');
    expect(err.retryable).toBe(true);
  });

  it('can be set to non-retryable', () => {
    const err = new EngineError('auth failed', 'claude-cli', undefined, false);
    expect(err.retryable).toBe(false);
  });

  it('preserves engine id and message', () => {
    const err = new EngineError('not authenticated', 'claude-cli', undefined, false);
    expect(err.engine).toBe('claude-cli');
    expect(err.message).toBe('not authenticated');
    expect(err.code).toBe('ENGINE_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Tool support — prompt injection, parsing, and event emission
// ---------------------------------------------------------------------------

const SAMPLE_TOOLS: ToolDefinition[] = [
  {
    name: 'canvas_render',
    description: 'Render components on the canvas.',
    parameters: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove'] },
        component: { type: 'object' },
      },
    },
  },
];

/** Collect all events from a RunHandle into an array. */
async function collectEvents(handle: { events: AsyncIterable<EngineEvent> }): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
  }
  return events;
}

describe('SubprocessEngine tool support', () => {
  /**
   * Create a subprocess engine that outputs a fixed string, ignoring all args.
   * Uses `bash -c 'printf ...'` with stdin mode so the prompt doesn't appear
   * in the output — only the hardcoded string is echoed.
   */
  const makeFixedOutputEngine = (output: string) => new SubprocessEngine({
    id: 'fixed-output',
    name: 'Fixed Output',
    command: 'bash',
    args: ['-c', `printf '%s' '${output.replace(/'/g, "'\\''")}'`],
    promptMode: 'stdin',
    timeout: 5000,
  });

  describe('tool prompt injection into system prompt', () => {
    it('does not emit tool_start when output has no tool_call blocks', async () => {
      const engine = makeFixedOutputEngine('Just a plain response.');

      const job = makeJob('test prompt', {
        tools: SAMPLE_TOOLS,
        systemPrompt: 'You are helpful.',
      });
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const types = events.map((e) => e.type);
      expect(types).toContain('started');
      expect(types).toContain('completed');
      expect(types).not.toContain('tool_start');
    });
  });

  describe('tool call parsing from subprocess output', () => {
    it('emits tool_start events when output contains <tool_call> blocks', async () => {
      const output = 'Let me add that.\n<tool_call>\n{"tool": "canvas_render", "args": {"action": "add"}}\n</tool_call>\nDone.';
      const engine = makeFixedOutputEngine(output);

      const job = makeJob('add a card', { tools: SAMPLE_TOOLS });
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const types = events.map((e) => e.type);
      expect(types).toContain('started');
      expect(types).toContain('tool_start');
      expect(types).toContain('completed');

      const toolStart = events.find((e) => e.type === 'tool_start') as
        Extract<EngineEvent, { type: 'tool_start' }>;
      expect(toolStart.tool).toBe('canvas_render');
      expect(toolStart.args).toEqual({ action: 'add' });
      expect(toolStart.id).toBeTruthy();
    });

    it('strips tool_call blocks from the completed answer', async () => {
      const output = 'Before text.\n<tool_call>\n{"tool": "canvas_render", "args": {"action": "remove"}}\n</tool_call>\nAfter text.';
      const engine = makeFixedOutputEngine(output);

      const job = makeJob('remove it', { tools: SAMPLE_TOOLS });
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const completed = events.find((e) => e.type === 'completed') as
        Extract<EngineEvent, { type: 'completed' }>;
      expect(completed.answer).toContain('Before text.');
      expect(completed.answer).toContain('After text.');
      expect(completed.answer).not.toContain('<tool_call>');
      expect(completed.answer).not.toContain('</tool_call>');
      expect(completed.answer).not.toContain('"canvas_render"');
    });

    it('handles multiple tool calls in a single output', async () => {
      const output = [
        '<tool_call>',
        '{"tool": "canvas_render", "args": {"action": "add"}}',
        '</tool_call>',
        'middle text',
        '<tool_call>',
        '{"tool": "canvas_render", "args": {"action": "update"}}',
        '</tool_call>',
      ].join('\n');
      const engine = makeFixedOutputEngine(output);

      const job = makeJob('add and update', { tools: SAMPLE_TOOLS });
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const toolStarts = events.filter((e) => e.type === 'tool_start') as
        Array<Extract<EngineEvent, { type: 'tool_start' }>>;
      expect(toolStarts).toHaveLength(2);
      expect(toolStarts[0]!.args).toEqual({ action: 'add' });
      expect(toolStarts[1]!.args).toEqual({ action: 'update' });
    });

    it('treats malformed JSON in <tool_call> as plain text', async () => {
      const output = 'Some text.\n<tool_call>\nnot valid json\n</tool_call>\nMore text.';
      const engine = makeFixedOutputEngine(output);

      const job = makeJob('do something', { tools: SAMPLE_TOOLS });
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      // No tool_start events — malformed JSON is left in text.
      const types = events.map((e) => e.type);
      expect(types).not.toContain('tool_start');

      const completed = events.find((e) => e.type === 'completed') as
        Extract<EngineEvent, { type: 'completed' }>;
      expect(completed.answer).toContain('not valid json');
    });

    it('handles output with no tool calls when tools are configured', async () => {
      const plainOutput = 'Just a normal text response with no tools.';
      const engine = makeFixedOutputEngine(plainOutput);

      const job = makeJob('hello', { tools: SAMPLE_TOOLS });
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const types = events.map((e) => e.type);
      expect(types).not.toContain('tool_start');
      expect(types).toContain('completed');

      const completed = events.find((e) => e.type === 'completed') as
        Extract<EngineEvent, { type: 'completed' }>;
      expect(completed.answer).toBe(plainOutput);
    });
  });

  describe('buffered streaming when tools are present', () => {
    it('does not emit text_delta during streaming when tools are configured', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-buffered',
        name: 'Echo Buffered',
        command: 'echo',
        promptMode: 'arg',
        timeout: 5000,
      });

      const job = makeJob('hello', { tools: SAMPLE_TOOLS });
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      // When tools are configured, we buffer output and parse at the end.
      // We should see exactly one text_delta (the post-parse clean text)
      // and one completed event.
      const textDeltas = events.filter((e) => e.type === 'text_delta');
      const completed = events.find((e) => e.type === 'completed') as
        Extract<EngineEvent, { type: 'completed' }>;

      // There should be at most one text_delta (the parsed clean output).
      expect(textDeltas.length).toBeLessThanOrEqual(1);
      expect(completed).toBeDefined();
    });

    it('streams text_delta in real-time when no tools are configured', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-stream',
        name: 'Echo Stream',
        command: 'echo',
        promptMode: 'arg',
        timeout: 5000,
      });

      // No tools — standard real-time streaming.
      const job = makeJob('hello world');
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const types = events.map((e) => e.type);
      expect(types).toContain('text_delta');
      expect(types).toContain('completed');
    });
  });

  describe('backward compatibility', () => {
    it('behaves identically when job.tools is undefined', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-compat',
        name: 'Echo Compat',
        command: 'echo',
        promptMode: 'arg',
        timeout: 5000,
      });

      const job = makeJob('hello');
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const types = events.map((e) => e.type);
      expect(types).toContain('started');
      expect(types).toContain('text_delta');
      expect(types).toContain('completed');
      expect(types).not.toContain('tool_start');
    });

    it('behaves identically when job.tools is empty array', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-compat',
        name: 'Echo Compat',
        command: 'echo',
        promptMode: 'arg',
        timeout: 5000,
      });

      const job = makeJob('hello', { tools: [] });
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const types = events.map((e) => e.type);
      expect(types).toContain('text_delta');
      expect(types).not.toContain('tool_start');
    });
  });

  describe('extractPrompt with tool messages', () => {
    it('includes tool calls and results in conversation history', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-tool-hist',
        name: 'Echo Tool History',
        command: 'echo',
        promptMode: 'arg',
        timeout: 5000,
      });

      const job: Job = {
        sessionId: 'test',
        messages: [
          { role: 'user', content: 'Add a card to the canvas.' },
          {
            role: 'assistant',
            content: 'I\'ll add a card.',
            toolCalls: [{ id: 'tc_1', name: 'canvas_render', args: { action: 'add' } }],
          },
          { role: 'tool', content: 'Component added with id "abc".', toolCallId: 'tc_1' },
          { role: 'user', content: 'Now update it.' },
        ],
        tools: SAMPLE_TOOLS,
      };

      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const completed = events.find((e) => e.type === 'completed') as
        Extract<EngineEvent, { type: 'completed' }>;

      // The prompt should include conversation_history with tool call/result.
      expect(completed.answer).toContain('conversation_history');
      expect(completed.answer).toContain('[Tool Call: canvas_render]');
      expect(completed.answer).toContain('[Tool Result (canvas_render)]');
      expect(completed.answer).toContain('Component added');
      expect(completed.answer).toContain('Now update it');
    });

    it('handles tool result without matching toolCallId', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-orphan',
        name: 'Echo Orphan',
        command: 'echo',
        promptMode: 'arg',
        timeout: 5000,
      });

      const job: Job = {
        sessionId: 'test',
        messages: [
          { role: 'user', content: 'Do something.' },
          { role: 'tool', content: 'Orphan result.', toolCallId: 'unknown_id' },
          { role: 'user', content: 'Continue.' },
        ],
        tools: SAMPLE_TOOLS,
      };

      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const completed = events.find((e) => e.type === 'completed') as
        Extract<EngineEvent, { type: 'completed' }>;

      // Should still include the result, just without tool name.
      expect(completed.answer).toContain('[Tool Result]');
      expect(completed.answer).toContain('Orphan result');
    });
  });
});
