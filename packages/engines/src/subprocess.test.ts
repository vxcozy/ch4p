/**
 * Tests for SubprocessEngine and CLI engine factories.
 *
 * Tests the subprocess engine configuration, prompt extraction,
 * and the claude-cli / codex-cli factory functions.
 */

import { describe, it, expect, vi } from 'vitest';
import { SubprocessEngine, createClaudeCliEngine, createCodexCliEngine, isAuthFailure } from './subprocess.js';
import { EngineError } from '@ch4p/core';
import type { Job } from '@ch4p/core';

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
