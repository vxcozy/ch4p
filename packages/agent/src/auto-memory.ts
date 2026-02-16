/**
 * Auto-memory — lifecycle hooks for automatic memory recall and summarization.
 *
 * These factory functions create the onBeforeFirstRun and onAfterComplete hooks
 * that wire into AgentLoopOpts, enabling ch4p to continuously learn from
 * conversations without requiring explicit memory_store/memory_recall tool calls.
 *
 * - createAutoRecallHook: retrieves relevant memories before the first engine call
 * - createAutoSummarizeHook: stores a conversation summary after completion
 */

import type { IMemoryBackend, RecallOpts } from '@ch4p/core';
import type { ContextManager } from './context.js';
import type { AgentLoopOpts } from './agent-loop.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AutoRecallOpts {
  /** Maximum number of memories to inject. Default: 5. */
  maxResults?: number;
  /** Minimum relevance score (0–1) for a memory to be included. Default: 0.1. */
  minScore?: number;
  /** RecallOpts forwarded to the backend (vectorWeight, keywordWeight, etc.). */
  recallOpts?: RecallOpts;
}

export interface AutoSummarizeOpts {
  /** Minimum number of user messages before a summary is worth storing. Default: 1. */
  minMessages?: number;
  /** Maximum length of the stored summary content. Default: 2000 chars. */
  maxSummaryLength?: number;
}

// ---------------------------------------------------------------------------
// Auto-recall hook
// ---------------------------------------------------------------------------

/**
 * Create a lifecycle hook that recalls relevant memories and injects them
 * into the conversation context before the first engine call.
 */
export function createAutoRecallHook(
  backend: IMemoryBackend,
  opts?: AutoRecallOpts,
): NonNullable<AgentLoopOpts['onBeforeFirstRun']> {
  const maxResults = opts?.maxResults ?? 5;
  const minScore = opts?.minScore ?? 0.1;

  return async (ctx: ContextManager): Promise<void> => {
    // Extract the last user message as the recall query.
    const messages = ctx.getMessages();
    const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
    if (!lastUserMsg || typeof lastUserMsg.content !== 'string') return;

    const query = lastUserMsg.content;
    if (!query.trim()) return;

    const results = await backend.recall(query, {
      limit: maxResults,
      minScore,
      ...opts?.recallOpts,
    });

    if (results.length === 0) return;

    // Format the recalled memories as a system context message.
    const memoryLines = results.map(
      (r, i) => `${i + 1}. [${r.matchType}, score=${r.score.toFixed(2)}] ${r.content}`,
    );
    const memoryText =
      'Relevant memories from previous conversations:\n' +
      memoryLines.join('\n') +
      '\n\nUse these memories to provide more personalized and context-aware responses.';

    await ctx.addMessage({ role: 'system', content: memoryText });
  };
}

// ---------------------------------------------------------------------------
// Auto-summarize hook
// ---------------------------------------------------------------------------

/**
 * Create a lifecycle hook that summarizes the completed conversation and
 * stores it in the memory backend for future recall.
 */
export function createAutoSummarizeHook(
  backend: IMemoryBackend,
  opts?: AutoSummarizeOpts,
): NonNullable<AgentLoopOpts['onAfterComplete']> {
  const minMessages = opts?.minMessages ?? 1;
  const maxLength = opts?.maxSummaryLength ?? 2000;

  return async (ctx: ContextManager, answer: string): Promise<void> => {
    const messages = ctx.getMessages();

    // Extract user messages (skip system prompts and injected memories).
    const userMessages = messages.filter((m) => m.role === 'user');
    if (userMessages.length < minMessages) return;

    // Skip if the answer is empty or trivially short.
    if (!answer || answer.trim().length < 10) return;

    // Build the summary content.
    const userQueries = userMessages
      .map((m) => typeof m.content === 'string' ? m.content : '')
      .filter(Boolean);

    const summaryParts = [
      `User asked: ${userQueries.join(' → ')}`,
      `Assistant answered: ${answer}`,
    ];

    let summary = summaryParts.join('\n');
    if (summary.length > maxLength) {
      summary = summary.slice(0, maxLength - 3) + '...';
    }

    // Generate a unique key from the timestamp and user query prefix.
    const timestamp = new Date().toISOString();
    const queryPrefix = userQueries[0]?.slice(0, 50).replace(/[^a-zA-Z0-9 ]/g, '') ?? 'conversation';
    const key = `conv:${timestamp}:${queryPrefix}`;

    await backend.store(key, summary, {
      type: 'conversation_summary',
      timestamp,
      messageCount: messages.length,
      userMessageCount: userMessages.length,
    });
  };
}
