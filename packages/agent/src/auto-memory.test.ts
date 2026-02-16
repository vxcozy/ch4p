import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { IMemoryBackend, MemoryResult, MemoryEntry } from '@ch4p/core';
import { ContextManager } from './context.js';
import { createAutoRecallHook, createAutoSummarizeHook } from './auto-memory.js';

// ---------------------------------------------------------------------------
// Mock memory backend
// ---------------------------------------------------------------------------

function createMockBackend(recallResults: MemoryResult[] = []): IMemoryBackend & {
  storeCalls: Array<{ key: string; content: string; metadata?: Record<string, unknown> }>;
  recallCalls: Array<{ query: string; opts?: unknown }>;
} {
  const storeCalls: Array<{ key: string; content: string; metadata?: Record<string, unknown> }> = [];
  const recallCalls: Array<{ query: string; opts?: unknown }> = [];

  return {
    id: 'mock',
    storeCalls,
    recallCalls,
    async store(key: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
      storeCalls.push({ key, content, metadata });
    },
    async recall(query: string, opts?: unknown): Promise<MemoryResult[]> {
      recallCalls.push({ query, opts });
      return recallResults;
    },
    async forget(): Promise<boolean> { return true; },
    async list(): Promise<MemoryEntry[]> { return []; },
    async reindex(): Promise<void> {},
    async close(): Promise<void> {},
  };
}

// ---------------------------------------------------------------------------
// createAutoRecallHook
// ---------------------------------------------------------------------------

describe('createAutoRecallHook', () => {
  it('injects recalled memories into context as a system message', async () => {
    const results: MemoryResult[] = [
      { key: 'conv:1', content: 'User likes blue', score: 0.85, matchType: 'hybrid' },
      { key: 'conv:2', content: 'User works at Acme', score: 0.72, matchType: 'keyword' },
    ];
    const backend = createMockBackend(results);
    const hook = createAutoRecallHook(backend);

    const ctx = new ContextManager();
    await ctx.addMessage({ role: 'user', content: 'What is my favorite color?' });

    await hook(ctx);

    const messages = ctx.getMessages();
    // Should have: user message + injected system message
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe('system');
    expect(messages[1]!.content).toContain('Relevant memories from previous conversations');
    expect(messages[1]!.content).toContain('User likes blue');
    expect(messages[1]!.content).toContain('User works at Acme');

    // Verify recall was called with the user message.
    expect(backend.recallCalls).toHaveLength(1);
    expect(backend.recallCalls[0]!.query).toBe('What is my favorite color?');
  });

  it('does not inject anything when no memories are found', async () => {
    const backend = createMockBackend([]); // No results
    const hook = createAutoRecallHook(backend);

    const ctx = new ContextManager();
    await ctx.addMessage({ role: 'user', content: 'Hello world' });

    await hook(ctx);

    const messages = ctx.getMessages();
    // Only the original user message — no system injection.
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
  });

  it('does not inject anything when user message is empty', async () => {
    const results: MemoryResult[] = [
      { key: 'conv:1', content: 'Something', score: 0.9, matchType: 'hybrid' },
    ];
    const backend = createMockBackend(results);
    const hook = createAutoRecallHook(backend);

    const ctx = new ContextManager();
    await ctx.addMessage({ role: 'user', content: '   ' });

    await hook(ctx);

    // Recall should not even be called for empty input.
    expect(backend.recallCalls).toHaveLength(0);
  });

  it('respects maxResults and minScore options', async () => {
    const backend = createMockBackend([]);
    const hook = createAutoRecallHook(backend, { maxResults: 3, minScore: 0.5 });

    const ctx = new ContextManager();
    await ctx.addMessage({ role: 'user', content: 'test query' });

    await hook(ctx);

    expect(backend.recallCalls).toHaveLength(1);
    const opts = backend.recallCalls[0]!.opts as Record<string, unknown>;
    expect(opts.limit).toBe(3);
    expect(opts.minScore).toBe(0.5);
  });

  it('uses the last user message when multiple exist', async () => {
    const results: MemoryResult[] = [
      { key: 'conv:1', content: 'Memory hit', score: 0.8, matchType: 'vector' },
    ];
    const backend = createMockBackend(results);
    const hook = createAutoRecallHook(backend);

    const ctx = new ContextManager();
    await ctx.addMessage({ role: 'user', content: 'First question' });
    await ctx.addMessage({ role: 'assistant', content: 'First answer' });
    await ctx.addMessage({ role: 'user', content: 'Second question' });

    await hook(ctx);

    // Should recall based on the last user message.
    expect(backend.recallCalls[0]!.query).toBe('Second question');
  });

  it('includes system prompt messages in context without affecting recall', async () => {
    const results: MemoryResult[] = [
      { key: 'conv:1', content: 'Memory', score: 0.7, matchType: 'hybrid' },
    ];
    const backend = createMockBackend(results);
    const hook = createAutoRecallHook(backend);

    const ctx = new ContextManager();
    ctx.setSystemPrompt('You are ch4p');
    await ctx.addMessage({ role: 'user', content: 'Hello' });

    await hook(ctx);

    const messages = ctx.getMessages();
    // system prompt + user message + injected memory
    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe('You are ch4p');
    expect(messages[1]!.role).toBe('user');
    expect(messages[2]!.role).toBe('system');
    expect(messages[2]!.content).toContain('Relevant memories');
  });
});

// ---------------------------------------------------------------------------
// createAutoSummarizeHook
// ---------------------------------------------------------------------------

describe('createAutoSummarizeHook', () => {
  it('stores a conversation summary after completion', async () => {
    const backend = createMockBackend();
    const hook = createAutoSummarizeHook(backend);

    const ctx = new ContextManager();
    await ctx.addMessage({ role: 'user', content: 'What is the capital of France?' });
    await ctx.addMessage({ role: 'assistant', content: 'The capital of France is Paris.' });

    await hook(ctx, 'The capital of France is Paris.');

    expect(backend.storeCalls).toHaveLength(1);
    const call = backend.storeCalls[0]!;
    expect(call.key).toMatch(/^conv:/);
    expect(call.content).toContain('What is the capital of France?');
    expect(call.content).toContain('The capital of France is Paris.');
    expect(call.metadata?.type).toBe('conversation_summary');
    expect(call.metadata?.messageCount).toBe(2);
    expect(call.metadata?.userMessageCount).toBe(1);
  });

  it('skips storage when answer is empty', async () => {
    const backend = createMockBackend();
    const hook = createAutoSummarizeHook(backend);

    const ctx = new ContextManager();
    await ctx.addMessage({ role: 'user', content: 'Hello' });

    await hook(ctx, '');

    expect(backend.storeCalls).toHaveLength(0);
  });

  it('skips storage when answer is trivially short', async () => {
    const backend = createMockBackend();
    const hook = createAutoSummarizeHook(backend);

    const ctx = new ContextManager();
    await ctx.addMessage({ role: 'user', content: 'Hello' });

    await hook(ctx, 'Hi');

    expect(backend.storeCalls).toHaveLength(0);
  });

  it('skips storage when there are no user messages', async () => {
    const backend = createMockBackend();
    const hook = createAutoSummarizeHook(backend);

    const ctx = new ContextManager();
    // Only system messages, no user messages.
    ctx.setSystemPrompt('You are ch4p');

    await hook(ctx, 'Some answer text here');

    expect(backend.storeCalls).toHaveLength(0);
  });

  it('truncates very long summaries', async () => {
    const backend = createMockBackend();
    const hook = createAutoSummarizeHook(backend, { maxSummaryLength: 100 });

    const ctx = new ContextManager();
    await ctx.addMessage({ role: 'user', content: 'Tell me everything about quantum physics' });

    const longAnswer = 'A'.repeat(200);
    await hook(ctx, longAnswer);

    expect(backend.storeCalls).toHaveLength(1);
    // Summary should be truncated to maxSummaryLength.
    expect(backend.storeCalls[0]!.content.length).toBeLessThanOrEqual(100);
    expect(backend.storeCalls[0]!.content).toMatch(/\.\.\.$/);
  });

  it('handles multi-turn conversations', async () => {
    const backend = createMockBackend();
    const hook = createAutoSummarizeHook(backend);

    const ctx = new ContextManager();
    await ctx.addMessage({ role: 'user', content: 'My name is Alice' });
    await ctx.addMessage({ role: 'assistant', content: 'Nice to meet you, Alice!' });
    await ctx.addMessage({ role: 'user', content: 'What tools do you have?' });
    await ctx.addMessage({ role: 'assistant', content: 'I have memory, bash, and file tools.' });

    await hook(ctx, 'I have memory, bash, and file tools.');

    expect(backend.storeCalls).toHaveLength(1);
    const content = backend.storeCalls[0]!.content;
    // Both user messages should appear.
    expect(content).toContain('My name is Alice');
    expect(content).toContain('What tools do you have?');
    expect(backend.storeCalls[0]!.metadata?.userMessageCount).toBe(2);
  });

  it('respects minMessages option', async () => {
    const backend = createMockBackend();
    const hook = createAutoSummarizeHook(backend, { minMessages: 3 });

    const ctx = new ContextManager();
    await ctx.addMessage({ role: 'user', content: 'Hello' });
    await ctx.addMessage({ role: 'user', content: 'How are you?' });

    await hook(ctx, 'I am doing well, thank you for asking!');

    // Only 2 user messages, but minMessages is 3 — should skip.
    expect(backend.storeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Session with sharedContext
// ---------------------------------------------------------------------------

describe('Session with sharedContext', () => {
  it('uses the provided shared context instead of creating a new one', async () => {
    const { Session } = await import('./session.js');
    const sharedCtx = new ContextManager();
    sharedCtx.setSystemPrompt('Shared prompt');
    await sharedCtx.addMessage({ role: 'user', content: 'First message' });

    const session = new Session(
      { sessionId: 'test', engineId: 'echo', model: 'test', provider: 'test' },
      { sharedContext: sharedCtx },
    );

    const messages = session.getContext().getMessages();
    // Should see the shared context's messages (system prompt + user message).
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe('Shared prompt');
    expect(messages[1]!.content).toBe('First message');
  });

  it('shares context across multiple sessions', async () => {
    const { Session } = await import('./session.js');
    const sharedCtx = new ContextManager();
    sharedCtx.setSystemPrompt('You are ch4p');

    // First session adds a user message.
    const session1 = new Session(
      { sessionId: 's1', engineId: 'echo', model: 'test', provider: 'test' },
      { sharedContext: sharedCtx },
    );
    await session1.getContext().addMessage({ role: 'user', content: 'Message from session 1' });

    // Second session should see messages from session 1.
    const session2 = new Session(
      { sessionId: 's2', engineId: 'echo', model: 'test', provider: 'test' },
      { sharedContext: sharedCtx },
    );
    const messages = session2.getContext().getMessages();
    expect(messages).toHaveLength(2); // system + user from session 1
    expect(messages[1]!.content).toBe('Message from session 1');
  });

  it('clear() preserves system prompt', () => {
    const ctx = new ContextManager();
    ctx.setSystemPrompt('System prompt');
    ctx.addMessage({ role: 'user', content: 'Hello' });
    ctx.addMessage({ role: 'assistant', content: 'Hi there' });

    ctx.clear();

    const messages = ctx.getMessages();
    // Only the system prompt should remain.
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe('System prompt');
  });
});
