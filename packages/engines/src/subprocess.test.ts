/**
 * Tests for SubprocessEngine and CLI engine factories.
 *
 * Tests the subprocess engine configuration, prompt extraction,
 * and the claude-cli / codex-cli factory functions.
 */

import { describe, it, expect, vi } from 'vitest';
import { SubprocessEngine, createClaudeCliEngine, createCodexCliEngine, isAuthFailure, isRateLimit, StreamingToolParser, longestPrefixMatchingSuffix } from './subprocess.js';
import { EngineError } from '@ch4p/core';
import type { Job, EngineEvent, ToolDefinition, ResumeToken } from '@ch4p/core';

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
    it('succeeds with a valid ResumeToken from the same engine', async () => {
      // Use an echo-based engine that outputs whatever argv it receives.
      const engine = new SubprocessEngine({
        id: 'echo-resume',
        name: 'Echo Resume',
        command: 'echo',
        promptMode: 'arg',
        timeout: 5000,
      });

      // First run — capture the ResumeToken emitted in the 'started' event.
      const handle1 = await engine.startRun(makeJob('first question'));
      let capturedToken: ResumeToken | undefined;
      const events1: EngineEvent[] = [];
      for await (const ev of handle1.events) {
        events1.push(ev);
        if (ev.type === 'started' && ev.resumeToken) {
          capturedToken = ev.resumeToken;
        }
      }
      expect(capturedToken).toBeDefined();
      expect(capturedToken!.engineId).toBe('echo-resume');

      // Resume — should reconstruct a job and produce a completed event.
      const handle2 = await engine.resume(capturedToken!, 'follow-up question');
      const events2: EngineEvent[] = [];
      for await (const ev of handle2.events) {
        events2.push(ev);
      }
      const types = events2.map((e) => e.type);
      expect(types).toContain('started');
      expect(types).toContain('completed');
    });

    it('throws EngineError when token engineId does not match', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-test',
        name: 'Echo Test',
        command: 'echo',
      });

      await expect(engine.resume(
        { engineId: 'different-engine', ref: 'ref_1', state: { sessionId: 'x', messages: [] } },
        'continue',
      )).rejects.toThrow(EngineError);
    });

    it('throws EngineError when resume state is missing', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-test',
        name: 'Echo Test',
        command: 'echo',
      });

      await expect(engine.resume(
        { engineId: 'echo-test', ref: 'ref_1', state: null },
        'continue',
      )).rejects.toThrow(EngineError);
    });

    it('includes prior messages in the resumed conversation', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-resume-hist',
        name: 'Echo Resume',
        command: 'echo',
        promptMode: 'arg',
        timeout: 5000,
      });

      // Build a job with some existing conversation history.
      const job: Job = {
        sessionId: 'hist-session',
        messages: [
          { role: 'user', content: 'initial message' },
          { role: 'assistant', content: 'initial response' },
        ],
      };
      const handle1 = await engine.startRun(job);
      let token: ResumeToken | undefined;
      for await (const ev of handle1.events) {
        if (ev.type === 'started' && ev.resumeToken) token = ev.resumeToken;
      }

      // Resume with a new prompt — the token's state should include prior messages.
      const handle2 = await engine.resume(token!, 'follow-up');
      let completedAnswer = '';
      for await (const ev of handle2.events) {
        if (ev.type === 'completed') completedAnswer = ev.answer;
      }
      // Echo will output the prompt; for multi-turn it echoes the full history block.
      // Verify the run completed without error (answer is non-empty).
      expect(completedAnswer.length).toBeGreaterThan(0);
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
// isRateLimit
// ---------------------------------------------------------------------------

describe('isRateLimit', () => {
  it('detects "rate limit" pattern', () => {
    expect(isRateLimit('Error: rate limit exceeded')).toBe(true);
  });

  it('detects "too many requests" pattern', () => {
    expect(isRateLimit('429 Too Many Requests')).toBe(true);
  });

  it('detects "usage limit" pattern', () => {
    expect(isRateLimit('You have reached your usage limit for this period.')).toBe(true);
  });

  it('detects "quota exceeded" pattern', () => {
    expect(isRateLimit('Quota exceeded for this billing period')).toBe(true);
  });

  it('detects "try again later" pattern', () => {
    expect(isRateLimit('Service unavailable, try again later')).toBe(true);
  });

  it('detects "limit reached" pattern', () => {
    expect(isRateLimit('Monthly limit reached')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isRateLimit('RATE LIMIT EXCEEDED')).toBe(true);
    expect(isRateLimit('QUOTA EXCEEDED')).toBe(true);
  });

  it('returns false for auth errors', () => {
    expect(isRateLimit('Not logged in')).toBe(false);
    expect(isRateLimit('Unauthorized')).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(isRateLimit('Connection refused')).toBe(false);
    expect(isRateLimit('File not found')).toBe(false);
    expect(isRateLimit('')).toBe(false);
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

  describe('real-time streaming (tools configured or not)', () => {
    it('emits text_delta events even when tools are configured', async () => {
      // Previously, tools caused buffering. Now text_delta is always real-time.
      const engine = new SubprocessEngine({
        id: 'echo-streaming-tools',
        name: 'Echo Streaming Tools',
        command: 'echo',
        promptMode: 'arg',
        timeout: 5000,
      });

      const job = makeJob('hello', { tools: SAMPLE_TOOLS });
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const textDeltas = events.filter((e) => e.type === 'text_delta');
      const completed = events.find((e) => e.type === 'completed') as
        Extract<EngineEvent, { type: 'completed' }>;

      // text_delta events MUST be emitted in real-time even with tools.
      expect(textDeltas.length).toBeGreaterThanOrEqual(1);
      expect(completed).toBeDefined();
    });

    it('emits text_delta events when no tools are configured', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-stream',
        name: 'Echo Stream',
        command: 'echo',
        promptMode: 'arg',
        timeout: 5000,
      });

      const job = makeJob('hello world');
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const types = events.map((e) => e.type);
      expect(types).toContain('text_delta');
      expect(types).toContain('completed');
    });

    it('includes a ResumeToken in the started event', async () => {
      const engine = new SubprocessEngine({
        id: 'echo-token',
        name: 'Echo Token',
        command: 'echo',
        promptMode: 'arg',
        timeout: 5000,
      });

      const job = makeJob('hello', { tools: SAMPLE_TOOLS });
      const handle = await engine.startRun(job);
      const events = await collectEvents(handle);

      const started = events.find((e) => e.type === 'started') as
        Extract<EngineEvent, { type: 'started' }>;
      expect(started).toBeDefined();
      expect(started.resumeToken).toBeDefined();
      expect(started.resumeToken!.engineId).toBe('echo-token');
      expect(started.resumeToken!.ref).toBeTruthy();
      const state = started.resumeToken!.state as { sessionId: string; messages: unknown[] };
      expect(state.sessionId).toBe('test-session');
      expect(Array.isArray(state.messages)).toBe(true);
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

// ---------------------------------------------------------------------------
// StreamingToolParser unit tests
// ---------------------------------------------------------------------------

describe('StreamingToolParser', () => {
  describe('plain text (no tool calls)', () => {
    it('emits text events for plain content', () => {
      const parser = new StreamingToolParser();
      const events = parser.process('Hello world');
      expect(events).toEqual([{ type: 'text', delta: 'Hello world' }]);
    });

    it('accumulates partial TOOL_OPEN prefix in hold buffer', () => {
      const parser = new StreamingToolParser();
      // '<tool_' is a prefix of '<tool_call>' — should be held back
      const events = parser.process('Hello <tool_');
      // 'Hello ' is safe, '<tool_' is held
      expect(events).toEqual([{ type: 'text', delta: 'Hello ' }]);
      // Flush confirms the held content
      expect(parser.flush()).toBe('<tool_');
    });

    it('releases held prefix when next chunk rules out a match', () => {
      const parser = new StreamingToolParser();
      parser.process('text <tool_');  // hold back '<tool_'
      const events = parser.process('X not a tag');
      // '<tool_X not a tag' is not a tool tag — the parser releases it as text
      const allText = events.map((e) => e.type === 'text' ? e.delta : '').join('');
      expect(allText).toContain('<tool_');
    });

    it('emits nothing when input is empty', () => {
      const parser = new StreamingToolParser();
      expect(parser.process('')).toEqual([]);
    });

    it('flush returns empty string when nothing is held', () => {
      const parser = new StreamingToolParser();
      parser.process('safe text');
      expect(parser.flush()).toBe('');
    });
  });

  describe('complete tool call in one chunk', () => {
    it('emits tool event for well-formed tool_call block', () => {
      const parser = new StreamingToolParser();
      const events = parser.process('<tool_call>\n{"tool":"canvas_render","args":{"action":"add"}}\n</tool_call>');

      const toolEvents = events.filter((e) => e.type === 'tool');
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0]).toMatchObject({ type: 'tool', tool: 'canvas_render', args: { action: 'add' } });
    });

    it('emits text before and after a tool_call block', () => {
      const parser = new StreamingToolParser();
      const events = parser.process('Before.\n<tool_call>\n{"tool":"t","args":{}}\n</tool_call>\nAfter.');

      const textEvents = events.filter((e) => e.type === 'text').map((e) => (e as { type: 'text'; delta: string }).delta).join('');
      const toolEvents = events.filter((e) => e.type === 'tool');
      expect(textEvents).toContain('Before.');
      expect(textEvents).toContain('After.');
      expect(toolEvents).toHaveLength(1);
    });

    it('emits multiple tool_start events for sequential tool blocks', () => {
      const parser = new StreamingToolParser();
      const input = '<tool_call>{"tool":"a","args":{}}</tool_call><tool_call>{"tool":"b","args":{}}</tool_call>';
      const events = parser.process(input);

      const toolEvents = events.filter((e) => e.type === 'tool');
      expect(toolEvents).toHaveLength(2);
      expect((toolEvents[0] as { tool: string }).tool).toBe('a');
      expect((toolEvents[1] as { tool: string }).tool).toBe('b');
    });
  });

  describe('split chunks (boundary handling)', () => {
    it('handles tool_call tag split across two chunks', () => {
      const parser = new StreamingToolParser();
      // Split '<tool_call>' across two chunks
      const events1 = parser.process('<tool_');
      const events2 = parser.process('call>{"tool":"x","args":{}}</tool_call>');

      const all = [...events1, ...events2];
      const toolEvents = all.filter((e) => e.type === 'tool');
      expect(toolEvents).toHaveLength(1);
      expect((toolEvents[0] as { tool: string }).tool).toBe('x');
    });

    it('handles tool JSON body split across chunks', () => {
      const parser = new StreamingToolParser();
      const events1 = parser.process('<tool_call>{"tool":"sp');
      const events2 = parser.process('lit","args":{"k":"v"}}</tool_call>');

      const all = [...events1, ...events2];
      const toolEvents = all.filter((e) => e.type === 'tool');
      expect(toolEvents).toHaveLength(1);
      expect((toolEvents[0] as { tool: string }).tool).toBe('split');
    });

    it('handles closing tag split across chunks', () => {
      const parser = new StreamingToolParser();
      const events1 = parser.process('<tool_call>{"tool":"z","args":{}}</tool_');
      const events2 = parser.process('call>');

      const all = [...events1, ...events2];
      const toolEvents = all.filter((e) => e.type === 'tool');
      expect(toolEvents).toHaveLength(1);
    });

    it('single character chunks', () => {
      const parser = new StreamingToolParser();
      const input = 'Hi<tool_call>{"tool":"t","args":{}}</tool_call>!';
      const all = input.split('').flatMap((c) => parser.process(c));
      const flush = parser.flush();

      const toolEvents = all.filter((e) => e.type === 'tool');
      const text = [...all.filter((e) => e.type === 'text'), ...(flush ? [{ type: 'text' as const, delta: flush }] : [])]
        .map((e) => (e as { delta: string }).delta).join('');

      expect(toolEvents).toHaveLength(1);
      expect(text).toContain('Hi');
      expect(text).toContain('!');
    });
  });

  describe('malformed JSON', () => {
    it('emits tool block as text when JSON is invalid', () => {
      const parser = new StreamingToolParser();
      const events = parser.process('<tool_call>not valid json</tool_call>');

      const textEvents = events.filter((e) => e.type === 'text');
      const toolEvents = events.filter((e) => e.type === 'tool');
      expect(toolEvents).toHaveLength(0);
      expect(textEvents.map((e) => (e as { delta: string }).delta).join('')).toContain('not valid json');
    });

    it('emits tool block as text when JSON lacks tool/args keys', () => {
      const parser = new StreamingToolParser();
      const events = parser.process('<tool_call>{"name":"foo","params":{}}</tool_call>');

      const toolEvents = events.filter((e) => e.type === 'tool');
      expect(toolEvents).toHaveLength(0);
    });
  });

  describe('flush', () => {
    it('returns incomplete tool block on flush when stream ended mid-tag', () => {
      const parser = new StreamingToolParser();
      parser.process('<tool_call>{"tool":"x","args":{}');
      const tail = parser.flush();
      expect(tail).toContain('<tool_call>');
      expect(tail).toContain('"tool":"x"');
    });
  });
});

// ---------------------------------------------------------------------------
// longestPrefixMatchingSuffix
// ---------------------------------------------------------------------------

describe('longestPrefixMatchingSuffix', () => {
  it('returns 0 when no prefix of pattern matches suffix of text', () => {
    expect(longestPrefixMatchingSuffix('hello', '<tool_call>')).toBe(0);
  });

  it('returns length of matching prefix', () => {
    // text ends with '<tool' which is the first 5 chars of '<tool_call>'
    expect(longestPrefixMatchingSuffix('some text <tool', '<tool_call>')).toBe(5);
  });

  it('returns 1 for single matching char', () => {
    expect(longestPrefixMatchingSuffix('foo <', '<tool_call>')).toBe(1);
  });

  it('does not return full pattern length (pattern.length - 1 max)', () => {
    const pattern = '<tool_call>';
    const text = pattern;
    // Full match would be pattern.length, but max is pattern.length - 1
    expect(longestPrefixMatchingSuffix(text, pattern)).toBeLessThan(pattern.length);
  });
});
