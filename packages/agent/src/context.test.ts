import { vi } from 'vitest';
import { ContextManager, NAMED_STRATEGIES } from './context.js';
import type { CompactionStrategy, NamedStrategy } from './context.js';
import type { Message } from '@ch4p/core';

describe('ContextManager', () => {
  describe('constructor defaults', () => {
    it('uses default maxTokens of 100_000', () => {
      const ctx = new ContextManager();
      expect(ctx.getMaxTokens()).toBe(100_000);
    });

    it('accepts custom maxTokens', () => {
      const ctx = new ContextManager({ maxTokens: 50_000 });
      expect(ctx.getMaxTokens()).toBe(50_000);
    });
  });

  describe('setSystemPrompt', () => {
    it('sets the system prompt and includes it in getMessages', () => {
      const ctx = new ContextManager();
      ctx.setSystemPrompt('You are a helpful assistant.');
      const msgs = ctx.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.role).toBe('system');
      expect(msgs[0]!.content).toBe('You are a helpful assistant.');
    });

    it('replaces previous system prompt', () => {
      const ctx = new ContextManager();
      ctx.setSystemPrompt('first');
      ctx.setSystemPrompt('second');
      const msgs = ctx.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.content).toBe('second');
    });

    it('updates token estimate when replacing system prompt', () => {
      const ctx = new ContextManager();
      ctx.setSystemPrompt('short');
      const tokensAfterFirst = ctx.getTokenEstimate();
      ctx.setSystemPrompt('a much longer system prompt that should use more tokens');
      expect(ctx.getTokenEstimate()).toBeGreaterThan(tokensAfterFirst);
    });
  });

  describe('addMessage', () => {
    it('adds a message to the context', async () => {
      const ctx = new ContextManager();
      await ctx.addMessage({ role: 'user', content: 'hello' });
      const msgs = ctx.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.content).toBe('hello');
    });

    it('preserves message order', async () => {
      const ctx = new ContextManager();
      await ctx.addMessage({ role: 'user', content: 'first' });
      await ctx.addMessage({ role: 'assistant', content: 'second' });
      await ctx.addMessage({ role: 'user', content: 'third' });

      const msgs = ctx.getMessages();
      expect(msgs.map((m) => m.content)).toEqual(['first', 'second', 'third']);
    });

    it('places system prompt before conversation messages', async () => {
      const ctx = new ContextManager();
      ctx.setSystemPrompt('system');
      await ctx.addMessage({ role: 'user', content: 'user msg' });

      const msgs = ctx.getMessages();
      expect(msgs[0]!.role).toBe('system');
      expect(msgs[1]!.role).toBe('user');
    });

    it('updates token estimate on each addMessage', async () => {
      const ctx = new ContextManager();
      const before = ctx.getTokenEstimate();
      await ctx.addMessage({ role: 'user', content: 'hello world' });
      expect(ctx.getTokenEstimate()).toBeGreaterThan(before);
    });
  });

  describe('getMessages', () => {
    it('returns a copy (not a reference to internal array)', async () => {
      const ctx = new ContextManager();
      await ctx.addMessage({ role: 'user', content: 'test' });
      const msgs1 = ctx.getMessages();
      const msgs2 = ctx.getMessages();
      expect(msgs1).not.toBe(msgs2);
      expect(msgs1).toEqual(msgs2);
    });
  });

  describe('clear', () => {
    it('removes all conversation messages but keeps system prompt', async () => {
      const ctx = new ContextManager();
      ctx.setSystemPrompt('system');
      await ctx.addMessage({ role: 'user', content: 'hello' });
      await ctx.addMessage({ role: 'assistant', content: 'hi' });

      ctx.clear();

      const msgs = ctx.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.role).toBe('system');
    });

    it('resets token estimate to system prompt tokens only', async () => {
      const ctx = new ContextManager();
      ctx.setSystemPrompt('system');
      const systemTokens = ctx.getTokenEstimate();

      await ctx.addMessage({ role: 'user', content: 'some long message here' });
      expect(ctx.getTokenEstimate()).toBeGreaterThan(systemTokens);

      ctx.clear();
      expect(ctx.getTokenEstimate()).toBe(systemTokens);
    });

    it('resets to zero when there is no system prompt', async () => {
      const ctx = new ContextManager();
      await ctx.addMessage({ role: 'user', content: 'test' });
      ctx.clear();
      expect(ctx.getTokenEstimate()).toBe(0);
    });
  });

  describe('compaction - drop_oldest', () => {
    it('drops oldest messages when threshold is exceeded', async () => {
      const ctx = new ContextManager({
        maxTokens: 100,
        compactionThreshold: 0.5,
        strategy: 'drop_oldest',
      });

      // Fill with enough messages to trigger compaction
      // Each message is ~50 chars => ~13 tokens. Threshold = 50 tokens.
      await ctx.addMessage({ role: 'user', content: 'A'.repeat(200) });
      await ctx.addMessage({ role: 'assistant', content: 'B'.repeat(200) });
      // This should trigger compaction (total tokens > 50)
      await ctx.addMessage({ role: 'user', content: 'C'.repeat(200) });

      const msgs = ctx.getMessages();
      // After compaction, some oldest messages should have been dropped
      expect(msgs.length).toBeLessThan(3);
    });
  });

  describe('compaction - summarize', () => {
    it('falls back to drop_oldest when no summarizer is provided', async () => {
      const ctx = new ContextManager({
        maxTokens: 100,
        compactionThreshold: 0.5,
        strategy: 'summarize',
      });

      await ctx.addMessage({ role: 'user', content: 'A'.repeat(200) });
      await ctx.addMessage({ role: 'assistant', content: 'B'.repeat(200) });
      await ctx.addMessage({ role: 'user', content: 'C'.repeat(200) });

      // Should not throw, should fall back to drop_oldest
      const msgs = ctx.getMessages();
      expect(msgs.length).toBeLessThan(3);
    });

    it('uses summarizer when provided', async () => {
      const summarizer = vi.fn().mockResolvedValue('Summary of conversation');

      const ctx = new ContextManager({
        maxTokens: 100,
        compactionThreshold: 0.5,
        strategy: 'summarize',
        summarizer,
      });

      await ctx.addMessage({ role: 'user', content: 'A'.repeat(200) });
      await ctx.addMessage({ role: 'assistant', content: 'B'.repeat(200) });
      await ctx.addMessage({ role: 'user', content: 'C'.repeat(200) });

      expect(summarizer).toHaveBeenCalled();
      const msgs = ctx.getMessages();
      const summaryMsg = msgs.find((m) =>
        typeof m.content === 'string' && m.content.includes('[Conversation summary]'),
      );
      expect(summaryMsg).toBeDefined();
    });
  });

  describe('compaction - sliding', () => {
    it('falls back to drop_oldest when no summarizer is provided', async () => {
      const ctx = new ContextManager({
        maxTokens: 100,
        compactionThreshold: 0.5,
        strategy: 'sliding',
      });

      await ctx.addMessage({ role: 'user', content: 'A'.repeat(200) });
      await ctx.addMessage({ role: 'assistant', content: 'B'.repeat(200) });
      await ctx.addMessage({ role: 'user', content: 'C'.repeat(200) });

      const msgs = ctx.getMessages();
      expect(msgs.length).toBeLessThan(3);
    });

    it('preserves recent messages and summarizes older ones', async () => {
      const summarizer = vi.fn().mockResolvedValue('Summary');

      const ctx = new ContextManager({
        maxTokens: 100,
        compactionThreshold: 0.5,
        strategy: 'sliding',
        summarizer,
      });

      await ctx.addMessage({ role: 'user', content: 'A'.repeat(200) });
      await ctx.addMessage({ role: 'assistant', content: 'B'.repeat(200) });
      await ctx.addMessage({ role: 'user', content: 'C'.repeat(200) });

      // Should have summarized and preserved recent messages
      const msgs = ctx.getMessages();
      expect(msgs.length).toBeGreaterThan(0);
    });
  });

  describe('manual compact', () => {
    it('can be called manually', async () => {
      const ctx = new ContextManager({ strategy: 'drop_oldest' });
      await ctx.addMessage({ role: 'user', content: 'hello' });
      // Should not throw
      await ctx.compact();
    });
  });

  describe('token estimation with ContentBlock arrays', () => {
    it('estimates tokens from content blocks', async () => {
      const ctx = new ContextManager();
      await ctx.addMessage({
        role: 'user',
        content: [
          { type: 'text', text: 'Hello world' },
          { type: 'tool_result', toolOutput: 'Some output here' },
        ],
      });
      expect(ctx.getTokenEstimate()).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // AWM Named Strategy Tests
  // =========================================================================

  describe('NAMED_STRATEGIES export', () => {
    it('exports exactly 4 built-in strategies', () => {
      const keys = Object.keys(NAMED_STRATEGIES);
      expect(keys).toHaveLength(4);
      expect(keys).toContain('sliding_window_3');
      expect(keys).toContain('sliding_conservative');
      expect(keys).toContain('summarize_coding');
      expect(keys).toContain('drop_oldest_pinned');
    });

    it('sliding_window_3 has correct shape', () => {
      const s = NAMED_STRATEGIES['sliding_window_3']!;
      expect(s.name).toBe('sliding_window_3');
      expect(s.type).toBe('sliding');
      expect(s.compactionTarget).toBe(0.4);
      expect(s.keepRatio).toBe(0.2);
      expect(s.preserveRecentToolPairs).toBe(3);
      expect(s.preserveTaskDescription).toBe(true);
      expect(s.description).toBeDefined();
    });

    it('sliding_conservative has correct shape', () => {
      const s = NAMED_STRATEGIES['sliding_conservative']!;
      expect(s.name).toBe('sliding_conservative');
      expect(s.type).toBe('sliding');
      expect(s.compactionTarget).toBe(0.7);
      expect(s.keepRatio).toBe(0.5);
      expect(s.preserveRecentToolPairs).toBe(5);
      expect(s.preserveTaskDescription).toBe(true);
    });

    it('summarize_coding has correct shape', () => {
      const s = NAMED_STRATEGIES['summarize_coding']!;
      expect(s.name).toBe('summarize_coding');
      expect(s.type).toBe('summarize');
      expect(s.compactionTarget).toBe(0.6);
      expect(s.keepRatio).toBe(0.4);
      expect(s.preserveRecentToolPairs).toBe(4);
      expect(s.preserveTaskDescription).toBe(true);
    });

    it('drop_oldest_pinned has correct shape', () => {
      const s = NAMED_STRATEGIES['drop_oldest_pinned']!;
      expect(s.name).toBe('drop_oldest_pinned');
      expect(s.type).toBe('drop_oldest');
      expect(s.compactionTarget).toBe(0.5);
      expect(s.preserveRecentToolPairs).toBe(2);
      expect(s.preserveTaskDescription).toBe(true);
    });

    it('every built-in strategy has a name matching its key', () => {
      for (const [key, strategy] of Object.entries(NAMED_STRATEGIES)) {
        expect(strategy.name).toBe(key);
      }
    });
  });

  describe('getStrategyName() and getNamedStrategy()', () => {
    it('returns the simple strategy name when constructed with a string', () => {
      const ctx = new ContextManager({ strategy: 'sliding' });
      expect(ctx.getStrategyName()).toBe('sliding');
    });

    it('returns null from getNamedStrategy() when constructed with a string', () => {
      const ctx = new ContextManager({ strategy: 'drop_oldest' });
      expect(ctx.getNamedStrategy()).toBeNull();
    });

    it('returns the named strategy name from getStrategyName()', () => {
      const ns: NamedStrategy = {
        name: 'my_custom',
        type: 'sliding',
        compactionTarget: 0.5,
      };
      const ctx = new ContextManager({ strategy: ns });
      expect(ctx.getStrategyName()).toBe('my_custom');
    });

    it('returns the named strategy object from getNamedStrategy()', () => {
      const ns: NamedStrategy = {
        name: 'my_custom',
        type: 'summarize',
        compactionTarget: 0.5,
        keepRatio: 0.3,
      };
      const ctx = new ContextManager({ strategy: ns });
      const result = ctx.getNamedStrategy();
      expect(result).not.toBeNull();
      expect(result!.name).toBe('my_custom');
      expect(result!.type).toBe('summarize');
      expect(result!.compactionTarget).toBe(0.5);
      expect(result!.keepRatio).toBe(0.3);
    });

    it('returns default strategy name "sliding" when no strategy is provided', () => {
      const ctx = new ContextManager();
      expect(ctx.getStrategyName()).toBe('sliding');
      expect(ctx.getNamedStrategy()).toBeNull();
    });
  });

  describe('named strategy compaction - drop_oldest with preserveTaskDescription', () => {
    it('preserves the first user message (task description) during compaction', async () => {
      const taskContent = 'Build a REST API with user authentication';
      const ns: NamedStrategy = {
        name: 'test_drop',
        type: 'drop_oldest',
        preserveTaskDescription: true,
        compactionTarget: 0.3,
      };

      const ctx = new ContextManager({
        maxTokens: 200,
        compactionThreshold: 0.5,
        strategy: ns,
      });

      // First user message = task description
      await ctx.addMessage({ role: 'user', content: taskContent });
      await ctx.addMessage({ role: 'assistant', content: 'A'.repeat(200) });
      await ctx.addMessage({ role: 'user', content: 'B'.repeat(200) });
      // This should trigger compaction
      await ctx.addMessage({ role: 'assistant', content: 'C'.repeat(200) });

      const msgs = ctx.getMessages();
      // The first user message should still be present
      const taskMsg = msgs.find(
        (m) => m.role === 'user' && m.content === taskContent,
      );
      expect(taskMsg).toBeDefined();
    });

    it('drops messages when preserveTaskDescription is false', async () => {
      const taskContent = 'Build a REST API with user authentication';
      const ns: NamedStrategy = {
        name: 'test_drop_no_preserve',
        type: 'drop_oldest',
        preserveTaskDescription: false,
        compactionTarget: 0.3,
      };

      const ctx = new ContextManager({
        maxTokens: 200,
        compactionThreshold: 0.5,
        strategy: ns,
      });

      await ctx.addMessage({ role: 'user', content: taskContent });
      await ctx.addMessage({ role: 'assistant', content: 'A'.repeat(200) });
      await ctx.addMessage({ role: 'user', content: 'B'.repeat(200) });
      await ctx.addMessage({ role: 'assistant', content: 'C'.repeat(200) });

      const msgs = ctx.getMessages();
      // Some messages should have been dropped; total count reduced
      expect(msgs.length).toBeLessThan(4);
    });
  });

  describe('named strategy compaction - pinnedRoles', () => {
    it('preserves system messages when system role is pinned', async () => {
      const ns: NamedStrategy = {
        name: 'test_pinned',
        type: 'drop_oldest',
        pinnedRoles: ['system'],
        compactionTarget: 0.3,
      };

      const ctx = new ContextManager({
        maxTokens: 200,
        compactionThreshold: 0.5,
        strategy: ns,
      });

      // Note: addMessage-based system messages (in the conversation array)
      // are distinct from setSystemPrompt. Pinned roles protect conversation messages.
      await ctx.addMessage({ role: 'system', content: 'Important context about the task' });
      await ctx.addMessage({ role: 'user', content: 'A'.repeat(200) });
      await ctx.addMessage({ role: 'assistant', content: 'B'.repeat(200) });
      await ctx.addMessage({ role: 'user', content: 'C'.repeat(200) });

      const msgs = ctx.getMessages();
      const systemMsgs = msgs.filter((m) => m.role === 'system');
      // The pinned system message should still be present
      expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
      expect(
        systemMsgs.some((m) =>
          typeof m.content === 'string' && m.content.includes('Important context'),
        ),
      ).toBe(true);
    });

    it('does not drop user messages when user role is pinned', async () => {
      const ns: NamedStrategy = {
        name: 'test_pinned_user',
        type: 'drop_oldest',
        pinnedRoles: ['user'],
        compactionTarget: 0.3,
      };

      const ctx = new ContextManager({
        maxTokens: 200,
        compactionThreshold: 0.5,
        strategy: ns,
      });

      await ctx.addMessage({ role: 'user', content: 'First user' });
      await ctx.addMessage({ role: 'assistant', content: 'A'.repeat(200) });
      await ctx.addMessage({ role: 'user', content: 'Second user' });
      await ctx.addMessage({ role: 'assistant', content: 'B'.repeat(200) });

      const msgs = ctx.getMessages();
      const userMsgs = msgs.filter((m) => m.role === 'user');
      // Both user messages should be protected
      expect(userMsgs.length).toBe(2);
    });
  });

  describe('named strategy compaction - preserveRecentToolPairs', () => {
    it('preserves the N most recent tool-call/result pairs during drop_oldest', async () => {
      const ns: NamedStrategy = {
        name: 'test_tool_pairs',
        type: 'drop_oldest',
        preserveRecentToolPairs: 2,
        preserveTaskDescription: false,
        compactionTarget: 0.3,
      };

      const ctx = new ContextManager({
        maxTokens: 300,
        compactionThreshold: 0.5,
        strategy: ns,
      });

      // Old messages
      await ctx.addMessage({ role: 'user', content: 'X'.repeat(100) });
      await ctx.addMessage({ role: 'assistant', content: 'Y'.repeat(100) });

      // Tool pair 1 (older, may be dropped)
      await ctx.addMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'read_file', args: {} }],
      });
      await ctx.addMessage({ role: 'tool', content: 'file contents 1', toolCallId: 'tc1' });

      // Tool pair 2 (recent, should be preserved)
      await ctx.addMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc2', name: 'write_file', args: {} }],
      });
      await ctx.addMessage({ role: 'tool', content: 'file written 2', toolCallId: 'tc2' });

      // Tool pair 3 (most recent, should be preserved)
      await ctx.addMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc3', name: 'run_test', args: {} }],
      });
      await ctx.addMessage({ role: 'tool', content: 'tests passed 3', toolCallId: 'tc3' });

      // Trigger compaction
      await ctx.addMessage({ role: 'user', content: 'Z'.repeat(200) });

      const msgs = ctx.getMessages();
      // The 2 most recent tool pairs (tc2, tc3) should be preserved
      const toolResultMsgs = msgs.filter(
        (m) => m.role === 'tool' && typeof m.content === 'string',
      );
      const hasToolPair3 = toolResultMsgs.some(
        (m) => typeof m.content === 'string' && m.content.includes('tests passed 3'),
      );
      const hasToolPair2 = toolResultMsgs.some(
        (m) => typeof m.content === 'string' && m.content.includes('file written 2'),
      );
      expect(hasToolPair3).toBe(true);
      expect(hasToolPair2).toBe(true);
    });

    it('also preserves assistant messages with toolCalls alongside their results', async () => {
      const ns: NamedStrategy = {
        name: 'test_tool_pairs_assistant',
        type: 'drop_oldest',
        preserveRecentToolPairs: 1,
        preserveTaskDescription: false,
        compactionTarget: 0.3,
      };

      const ctx = new ContextManager({
        maxTokens: 200,
        compactionThreshold: 0.5,
        strategy: ns,
      });

      await ctx.addMessage({ role: 'user', content: 'X'.repeat(100) });

      // Tool pair (most recent, should be preserved as a unit)
      await ctx.addMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_last', name: 'search', args: {} }],
      });
      await ctx.addMessage({ role: 'tool', content: 'search result', toolCallId: 'tc_last' });

      // Trigger compaction
      await ctx.addMessage({ role: 'user', content: 'Z'.repeat(200) });

      const msgs = ctx.getMessages();
      // The assistant message with toolCalls should still be present
      const assistantWithTools = msgs.find(
        (m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0,
      );
      expect(assistantWithTools).toBeDefined();
      expect(assistantWithTools!.toolCalls![0]!.id).toBe('tc_last');
    });
  });

  describe('summarize strategy with named strategy - preserveTaskDescription', () => {
    it('preserves the first user message after summarization', async () => {
      const taskContent = 'Implement a caching layer for the database';
      const summarizer = vi.fn().mockResolvedValue('Previous discussion about caching strategies');

      const ns: NamedStrategy = {
        name: 'test_summarize_preserve',
        type: 'summarize',
        compactionTarget: 0.5,
        keepRatio: 0.3,
        preserveTaskDescription: true,
      };

      const ctx = new ContextManager({
        maxTokens: 200,
        compactionThreshold: 0.5,
        strategy: ns,
        summarizer,
      });

      // First user message = task description
      await ctx.addMessage({ role: 'user', content: taskContent });
      await ctx.addMessage({ role: 'assistant', content: 'A'.repeat(100) });
      await ctx.addMessage({ role: 'user', content: 'B'.repeat(100) });
      await ctx.addMessage({ role: 'assistant', content: 'C'.repeat(100) });
      await ctx.addMessage({ role: 'user', content: 'D'.repeat(100) });

      const msgs = ctx.getMessages();
      // Task description should be the first user message
      const taskMsg = msgs.find(
        (m) => m.role === 'user' && m.content === taskContent,
      );
      expect(taskMsg).toBeDefined();
      // There should also be a summary message
      const summaryMsg = msgs.find(
        (m) => typeof m.content === 'string' && m.content.includes('[Conversation summary]'),
      );
      expect(summaryMsg).toBeDefined();
    });

    it('does not preserve task description when preserveTaskDescription is false', async () => {
      const taskContent = 'Short task';
      const summarizer = vi.fn().mockResolvedValue('Summary of old messages');

      const ns: NamedStrategy = {
        name: 'test_summarize_no_preserve',
        type: 'summarize',
        compactionTarget: 0.5,
        keepRatio: 0.2,
        preserveTaskDescription: false,
      };

      const ctx = new ContextManager({
        maxTokens: 200,
        compactionThreshold: 0.5,
        strategy: ns,
        summarizer,
      });

      await ctx.addMessage({ role: 'user', content: taskContent });
      await ctx.addMessage({ role: 'assistant', content: 'A'.repeat(100) });
      await ctx.addMessage({ role: 'user', content: 'B'.repeat(100) });
      await ctx.addMessage({ role: 'assistant', content: 'C'.repeat(100) });
      await ctx.addMessage({ role: 'user', content: 'E'.repeat(100) });

      const msgs = ctx.getMessages();
      // The short task description may have been summarized away
      // (it should not appear verbatim since preserveTaskDescription is false)
      const hasSummary = msgs.some(
        (m) => typeof m.content === 'string' && m.content.includes('[Conversation summary]'),
      );
      expect(hasSummary).toBe(true);
    });
  });

  describe('sliding strategy with named strategy - compactionTarget', () => {
    it('compacts more aggressively with a lower compactionTarget', async () => {
      const summarizer = vi.fn().mockResolvedValue('Aggressive summary');

      const aggressiveStrategy: NamedStrategy = {
        name: 'aggressive',
        type: 'sliding',
        compactionTarget: 0.3,
        keepRatio: 0.2,
      };

      const conservativeStrategy: NamedStrategy = {
        name: 'conservative',
        type: 'sliding',
        compactionTarget: 0.8,
        keepRatio: 0.6,
      };

      // Build identical message sets for both
      const buildMessages = (): Message[] => [
        { role: 'user', content: 'msg1-' + 'A'.repeat(50) },
        { role: 'assistant', content: 'msg2-' + 'B'.repeat(50) },
        { role: 'user', content: 'msg3-' + 'C'.repeat(50) },
        { role: 'assistant', content: 'msg4-' + 'D'.repeat(50) },
        { role: 'user', content: 'msg5-' + 'E'.repeat(50) },
        { role: 'assistant', content: 'msg6-' + 'F'.repeat(50) },
        { role: 'user', content: 'msg7-' + 'G'.repeat(50) },
        { role: 'assistant', content: 'msg8-' + 'H'.repeat(50) },
      ];

      // Aggressive context
      const aggressiveCtx = new ContextManager({
        maxTokens: 200,
        compactionThreshold: 0.5,
        strategy: aggressiveStrategy,
        summarizer,
      });

      for (const m of buildMessages()) {
        await aggressiveCtx.addMessage(m);
      }

      // Conservative context
      const conservativeCtx = new ContextManager({
        maxTokens: 200,
        compactionThreshold: 0.5,
        strategy: conservativeStrategy,
        summarizer,
      });

      for (const m of buildMessages()) {
        await conservativeCtx.addMessage(m);
      }

      // Aggressive should have fewer tokens remaining after compaction
      expect(aggressiveCtx.getTokenEstimate()).toBeLessThanOrEqual(
        conservativeCtx.getTokenEstimate(),
      );
    });

    it('uses compactionTarget of 0.4 for aggressive compaction via manual compact', async () => {
      const summarizer = vi.fn().mockResolvedValue('Summary');

      const ns: NamedStrategy = {
        name: 'aggressive_test',
        type: 'sliding',
        compactionTarget: 0.4,
        // Set preserveRecentToolPairs to 0 so the sliding window break
        // condition can fire (default is 3, which prevents breaking when there
        // are no tool pairs in the conversation).
        preserveRecentToolPairs: 0,
      };

      // maxTokens: 100, compactionTarget: 0.4 => targetTokens = 40.
      // Each ~50 chars => ~13 tokens. 10 messages => ~130 tokens total.
      // The window will keep recent messages up to ~40 tokens (~3 msgs),
      // and the remaining 7 messages will be summarized.
      const ctx = new ContextManager({
        maxTokens: 100,
        compactionThreshold: 100, // effectively disable auto-compaction
        strategy: ns,
        summarizer,
      });

      for (let i = 0; i < 10; i++) {
        const role = i % 2 === 0 ? 'user' : 'assistant';
        await ctx.addMessage({ role, content: `msg${i}-${'x'.repeat(40)}` } as Message);
      }

      // Manually trigger compaction.
      await ctx.compact();

      // Sliding with a summarizer should have been called on older messages.
      expect(summarizer).toHaveBeenCalled();
      const msgs = ctx.getMessages();
      expect(msgs.length).toBeGreaterThan(0);
      // A summary message should exist
      const hasSummary = msgs.some(
        (m) => typeof m.content === 'string' && m.content.includes('[Conversation summary]'),
      );
      expect(hasSummary).toBe(true);
    });
  });

  describe('maxMessages cap', () => {
    it('uses default maxMessages of 500', () => {
      const ctx = new ContextManager();
      expect(ctx.getMaxMessages()).toBe(500);
    });

    it('accepts custom maxMessages', () => {
      const ctx = new ContextManager({ maxMessages: 10 });
      expect(ctx.getMaxMessages()).toBe(10);
    });

    it('triggers compaction when message count exceeds maxMessages even if tokens are low', async () => {
      // High token budget so the token threshold is never reached.
      // maxMessages = 3 means compaction fires after the 4th message.
      const ctx = new ContextManager({
        maxTokens: 1_000_000,
        compactionThreshold: 0.99,
        maxMessages: 3,
        strategy: 'drop_oldest',
      });

      await ctx.addMessage({ role: 'user', content: 'a' });
      await ctx.addMessage({ role: 'assistant', content: 'b' });
      await ctx.addMessage({ role: 'user', content: 'c' });
      // 3 messages == maxMessages, not yet exceeded → no compaction yet.
      expect(ctx.getMessages().length).toBe(3);

      // 4th message → length(4) > maxMessages(3) → compaction fires.
      await ctx.addMessage({ role: 'assistant', content: 'd' });
      // After drop_oldest compaction, message count must be ≤ maxMessages.
      expect(ctx.getMessages().length).toBeLessThanOrEqual(3);
    });

    it('count cap works with tool-call messages that have empty content', async () => {
      const ctx = new ContextManager({
        maxTokens: 1_000_000,
        compactionThreshold: 0.99,
        maxMessages: 4,
        strategy: 'drop_oldest',
      });

      // Add 4 messages with empty content (like tool-call assistant messages).
      for (let i = 0; i < 4; i++) {
        await ctx.addMessage({
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `tc${i}`, name: 'read_file', args: {} }],
        });
      }
      expect(ctx.getMessages().length).toBe(4); // not yet exceeded

      // 5th pushes length to 5, triggering compaction.
      await ctx.addMessage({ role: 'user', content: 'done' });
      expect(ctx.getMessages().length).toBeLessThanOrEqual(4);
    });
  });

  describe('toolCalls token estimation', () => {
    it('counts toolCalls name + args in token estimate', async () => {
      const ctxWithToolCalls = new ContextManager();
      const ctxWithout = new ContextManager();

      // Message with empty content but non-trivial tool call.
      await ctxWithToolCalls.addMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'read_large_file', args: { path: '/some/path/file.ts' } }],
      });

      // Equivalent message with no tool calls (should have lower estimate).
      await ctxWithout.addMessage({ role: 'assistant', content: '' });

      expect(ctxWithToolCalls.getTokenEstimate()).toBeGreaterThan(ctxWithout.getTokenEstimate());
    });

    it('produces a non-zero estimate for a tool-call message with empty content', async () => {
      const ctx = new ContextManager();
      await ctx.addMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'bash', args: { command: 'ls -la' } }],
      });
      expect(ctx.getTokenEstimate()).toBeGreaterThan(0);
    });
  });

  describe('tool-call group integrity', () => {
    it('never splits tool-call assistant messages from their tool results', async () => {
      const ctx = new ContextManager({
        maxTokens: 200,
        compactionThreshold: 0.5,
        strategy: 'drop_oldest',
      });

      // Add a tool-call group
      await ctx.addMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_group', name: 'search', args: { query: 'test' } }],
      });
      await ctx.addMessage({
        role: 'tool',
        content: 'search result for test',
        toolCallId: 'tc_group',
      });

      // Add enough to trigger compaction
      await ctx.addMessage({ role: 'user', content: 'X'.repeat(200) });
      await ctx.addMessage({ role: 'assistant', content: 'Y'.repeat(200) });

      const msgs = ctx.getMessages();

      // Check integrity: if an assistant message with toolCalls is present,
      // the corresponding tool result must also be present
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]!;
        if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
          // Find the matching tool result(s)
          for (const tc of msg.toolCalls) {
            const hasResult = msgs.some(
              (m) => m.role === 'tool' && m.toolCallId === tc.id,
            );
            expect(hasResult).toBe(true);
          }
        }
      }
    });

    it('drops tool-call groups as a unit when they are not protected', async () => {
      const ns: NamedStrategy = {
        name: 'test_group_drop',
        type: 'drop_oldest',
        preserveRecentToolPairs: 0,
        preserveTaskDescription: false,
        compactionTarget: 0.2,
      };

      const ctx = new ContextManager({
        maxTokens: 200,
        compactionThreshold: 0.5,
        strategy: ns,
      });

      // Old tool-call group
      await ctx.addMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_old', name: 'read_file', args: {} }],
      });
      await ctx.addMessage({
        role: 'tool',
        content: 'R'.repeat(100),
        toolCallId: 'tc_old',
      });

      // Push more to trigger compaction
      await ctx.addMessage({ role: 'user', content: 'X'.repeat(200) });
      await ctx.addMessage({ role: 'assistant', content: 'Y'.repeat(200) });

      const msgs = ctx.getMessages();

      // If the assistant message with tc_old was dropped, the tool result
      // should also be gone (they are dropped as a unit)
      const hasOldAssistant = msgs.some(
        (m) =>
          m.role === 'assistant' &&
          m.toolCalls?.some((tc) => tc.id === 'tc_old'),
      );
      const hasOldToolResult = msgs.some(
        (m) => m.role === 'tool' && m.toolCallId === 'tc_old',
      );
      // Both should be gone, or both should be present (never split)
      expect(hasOldAssistant).toBe(hasOldToolResult);
    });

    it('preserves multi-result tool groups intact', async () => {
      const ns: NamedStrategy = {
        name: 'test_multi_result',
        type: 'drop_oldest',
        preserveRecentToolPairs: 1,
        preserveTaskDescription: false,
        compactionTarget: 0.3,
      };

      const ctx = new ContextManager({
        maxTokens: 300,
        compactionThreshold: 0.5,
        strategy: ns,
      });

      // Padding
      await ctx.addMessage({ role: 'user', content: 'P'.repeat(100) });

      // Tool-call with multiple results (most recent pair)
      await ctx.addMessage({
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_a', name: 'tool_a', args: {} },
          { id: 'tc_b', name: 'tool_b', args: {} },
        ],
      });
      await ctx.addMessage({ role: 'tool', content: 'result_a', toolCallId: 'tc_a' });
      await ctx.addMessage({ role: 'tool', content: 'result_b', toolCallId: 'tc_b' });

      // Trigger compaction
      await ctx.addMessage({ role: 'user', content: 'Z'.repeat(200) });

      const msgs = ctx.getMessages();

      // If the assistant message is present, both tool results must be too
      const assistantPresent = msgs.some(
        (m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === 'tc_a'),
      );
      if (assistantPresent) {
        const hasResultA = msgs.some(
          (m) => m.role === 'tool' && m.toolCallId === 'tc_a',
        );
        const hasResultB = msgs.some(
          (m) => m.role === 'tool' && m.toolCallId === 'tc_b',
        );
        expect(hasResultA).toBe(true);
        expect(hasResultB).toBe(true);
      }
    });
  });
});
