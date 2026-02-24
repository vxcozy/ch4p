/**
 * ContextManager — conversation context window management + compaction.
 *
 * Manages the message array for a session, tracks approximate token counts,
 * and compacts context when approaching the configured limit.
 *
 * Built-in compaction strategies:
 *   1. drop_oldest  — Remove oldest messages, keeping system prompt.
 *   2. summarize    — Collapse old messages into a single summary message.
 *   3. sliding      — Sliding window with a summary prefix.
 *
 * AWM (Agent World Model) named strategy system:
 *   Named strategies are first-class config objects with tunable parameters.
 *   This enables:
 *   - History-aware truncation with configurable keep ratios
 *   - Per-strategy compaction targets (how aggressively to compact)
 *   - Tool-call pair preservation across all strategies
 *   - Priority message pinning (never compact away pinned messages)
 *
 * Tool-call / tool-result pairs are never split: if a message contains
 * tool calls, the corresponding tool-result messages are kept together.
 */

import type { Message } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompactionStrategy = 'drop_oldest' | 'summarize' | 'sliding';

/**
 * Named strategy configuration — first-class objects for context truncation.
 *
 * Inspired by AWM's finding that history-aware truncation strategies
 * significantly improve agent task completion rates.
 */
export interface NamedStrategy {
  /** Unique name for this strategy (e.g., 'aggressive_sliding', 'conservative_drop'). */
  name: string;
  /** Base strategy type. */
  type: CompactionStrategy;
  /** Compaction target: compact down to this fraction of maxTokens. Default: 0.6 */
  compactionTarget?: number;
  /** For summarize/sliding: what fraction of messages to keep verbatim. Default: 0.3 */
  keepRatio?: number;
  /** Pin specific message roles — these messages are never compacted away. */
  pinnedRoles?: Array<'user' | 'assistant' | 'system' | 'tool'>;
  /** Maximum number of recent tool-call/result pairs to always preserve. Default: 3 */
  preserveRecentToolPairs?: number;
  /** If true, always keep the first user message (task description). Default: true */
  preserveTaskDescription?: boolean;
  /** Human-readable description of when to use this strategy. */
  description?: string;
}

export interface ContextManagerOpts {
  /** Maximum token budget for the context window. Default: 100 000. */
  maxTokens?: number;
  /** Compaction fires when usage exceeds this fraction of maxTokens. Default: 0.85. */
  compactionThreshold?: number;
  /** Which compaction strategy to use. Default: 'sliding'. Can be a simple
   *  strategy name or a named strategy object for fine-grained control. */
  strategy?: CompactionStrategy | NamedStrategy;
  /**
   * Optional async summarizer function. Required by 'summarize' and 'sliding'
   * strategies. Receives the messages to summarize and must return a single
   * summary string.
   */
  summarizer?: (messages: Message[]) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Built-in named strategies (AWM)
// ---------------------------------------------------------------------------

/**
 * Pre-built named strategies based on AWM research findings.
 * Use these as starting points or compose custom strategies.
 */
export const NAMED_STRATEGIES: Record<string, NamedStrategy> = {
  /** Aggressive sliding window — keeps only the 3 most recent exchanges. */
  sliding_window_3: {
    name: 'sliding_window_3',
    type: 'sliding',
    compactionTarget: 0.4,
    keepRatio: 0.2,
    preserveRecentToolPairs: 3,
    preserveTaskDescription: true,
    description: 'Aggressive sliding window. Best for long multi-step tasks where older context is less relevant.',
  },

  /** Conservative sliding — preserves more history for tasks that need it. */
  sliding_conservative: {
    name: 'sliding_conservative',
    type: 'sliding',
    compactionTarget: 0.7,
    keepRatio: 0.5,
    preserveRecentToolPairs: 5,
    preserveTaskDescription: true,
    description: 'Conservative sliding window. Best for tasks that reference earlier context frequently.',
  },

  /** Summarize with high keep ratio — good for coding tasks. */
  summarize_coding: {
    name: 'summarize_coding',
    type: 'summarize',
    compactionTarget: 0.6,
    keepRatio: 0.4,
    preserveRecentToolPairs: 4,
    preserveTaskDescription: true,
    description: 'Summarize old context while keeping recent code-related tool calls. Best for coding tasks.',
  },

  /** Drop oldest with task description pinning. */
  drop_oldest_pinned: {
    name: 'drop_oldest_pinned',
    type: 'drop_oldest',
    compactionTarget: 0.5,
    preserveRecentToolPairs: 2,
    preserveTaskDescription: true,
    description: 'Drop oldest messages but always preserve the original task and recent tool calls.',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough token estimate: ~4 characters per token. */
function estimateTokens(msg: Message): number {
  if (typeof msg.content === 'string') {
    return Math.ceil(msg.content.length / 4);
  }
  // ContentBlock array — sum text lengths across blocks.
  let chars = 0;
  for (const block of msg.content) {
    if (block.text) chars += block.text.length;
    if (block.toolOutput) chars += block.toolOutput.length;
    if (block.toolInput) chars += JSON.stringify(block.toolInput).length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Check whether `msg` is a tool-result message that belongs to a preceding
 * assistant message with tool calls.
 */
function isToolResultMessage(msg: Message): boolean {
  return msg.role === 'tool' || (msg.toolCallId !== undefined && msg.toolCallId !== '');
}

/**
 * Check whether `msg` is an assistant message that initiated tool calls.
 */
function hasToolCalls(msg: Message): boolean {
  return msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0;
}

// ---------------------------------------------------------------------------
// ContextManager
// ---------------------------------------------------------------------------

export class ContextManager {
  private messages: Message[] = [];
  private systemPrompt: Message | null = null;
  private tokenEstimate = 0;

  private readonly maxTokens: number;
  private readonly compactionThreshold: number;
  private readonly strategyType: CompactionStrategy;
  private readonly namedStrategy: NamedStrategy | null;
  private readonly summarizer?: (messages: Message[]) => Promise<string>;

  constructor(opts: ContextManagerOpts = {}) {
    this.maxTokens = opts.maxTokens ?? 100_000;
    this.compactionThreshold = opts.compactionThreshold ?? 0.85;
    this.summarizer = opts.summarizer;

    // Resolve strategy — can be a simple string or a named strategy object.
    if (typeof opts.strategy === 'object' && opts.strategy !== null) {
      this.namedStrategy = opts.strategy;
      this.strategyType = opts.strategy.type;
    } else {
      this.namedStrategy = null;
      this.strategyType = opts.strategy ?? 'sliding';
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Set or replace the system prompt (always position 0). */
  setSystemPrompt(prompt: string): void {
    const msg: Message = { role: 'system', content: prompt };
    if (this.systemPrompt) {
      this.tokenEstimate -= estimateTokens(this.systemPrompt);
    }
    this.systemPrompt = msg;
    this.tokenEstimate += estimateTokens(msg);
  }

  /** Append a message to the context. Triggers compaction if over threshold. */
  async addMessage(msg: Message): Promise<void> {
    const tokens = estimateTokens(msg);
    this.messages.push(msg);
    this.tokenEstimate += tokens;

    if (this.tokenEstimate > this.maxTokens * this.compactionThreshold) {
      await this.compact();
    }
  }

  /** Return the full message array (system prompt + conversation). */
  getMessages(): Message[] {
    if (this.systemPrompt) {
      return [this.systemPrompt, ...this.messages];
    }
    return [...this.messages];
  }

  /** Return the current approximate token usage. */
  getTokenEstimate(): number {
    return this.tokenEstimate;
  }

  /** Return the configured maximum token budget. */
  getMaxTokens(): number {
    return this.maxTokens;
  }

  /** Return the active strategy name. */
  getStrategyName(): string {
    return this.namedStrategy?.name ?? this.strategyType;
  }

  /** Return the full named strategy config if one is active. */
  getNamedStrategy(): Readonly<NamedStrategy> | null {
    return this.namedStrategy;
  }

  /** Remove all conversation messages (keeps system prompt). */
  clear(): void {
    this.messages = [];
    this.tokenEstimate = this.systemPrompt ? estimateTokens(this.systemPrompt) : 0;
  }

  // -----------------------------------------------------------------------
  // Compaction
  // -----------------------------------------------------------------------

  /**
   * Compact the context to fit within the token budget.
   *
   * This is invoked automatically when `addMessage` pushes the estimate past
   * the compaction threshold, but can also be called manually.
   */
  async compact(): Promise<void> {
    switch (this.strategyType) {
      case 'drop_oldest':
        this.compactDropOldest();
        break;
      case 'summarize':
        await this.compactSummarize();
        break;
      case 'sliding':
        await this.compactSliding();
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Strategy 1: drop_oldest — remove oldest messages, preserving tool pairs
  // -----------------------------------------------------------------------

  private compactDropOldest(): void {
    const target = this.maxTokens * (this.namedStrategy?.compactionTarget ?? 0.6);
    let idx = 0;

    // AWM: Determine protected message indices.
    const protectedIndices = this.getProtectedIndices();

    while (this.tokenEstimate > target && idx < this.messages.length - 1) {
      // Never drop the very last message (it is the most recent context).
      const msg = this.messages[idx]!;

      // AWM: Skip protected messages.
      if (protectedIndices.has(idx)) {
        idx++;
        continue;
      }

      // If this message has tool calls, skip forward past all related results.
      if (hasToolCalls(msg)) {
        const groupEnd = this.findToolGroupEnd(idx);

        // Check if any message in the group is protected.
        let groupProtected = false;
        for (let i = idx; i <= groupEnd; i++) {
          if (protectedIndices.has(i)) {
            groupProtected = true;
            break;
          }
        }

        if (groupProtected) {
          idx = groupEnd + 1;
          continue;
        }

        const dropped = this.messages.splice(idx, groupEnd - idx + 1);
        for (const d of dropped) this.tokenEstimate -= estimateTokens(d);
        // idx stays the same because splice shifted everything.
        continue;
      }

      // If this is a stray tool result, skip it (should not happen).
      if (isToolResultMessage(msg)) {
        idx++;
        continue;
      }

      // Regular message — drop it.
      this.messages.splice(idx, 1);
      this.tokenEstimate -= estimateTokens(msg);
    }
  }

  // -----------------------------------------------------------------------
  // Strategy 2: summarize — collapse old messages into one summary message
  // -----------------------------------------------------------------------

  private async compactSummarize(): Promise<void> {
    if (!this.summarizer) {
      // Fall back to drop_oldest when no summarizer is available.
      this.compactDropOldest();
      return;
    }

    const keepRatio = this.namedStrategy?.keepRatio ?? 0.3;

    // Keep the last keepRatio of messages as-is — summarize the rest.
    const keepCount = Math.max(2, Math.floor(this.messages.length * keepRatio));
    const splitIdx = this.messages.length - keepCount;

    // AWM: Preserve task description (first user message).
    if (this.namedStrategy?.preserveTaskDescription) {
      const firstUserIdx = this.messages.findIndex((m) => m.role === 'user');
      if (firstUserIdx >= 0 && firstUserIdx < splitIdx) {
        // We'll extract the first user message and put it back after summarization.
      }
    }

    const toSummarize = this.messages.slice(0, splitIdx);
    const toKeep = this.messages.slice(splitIdx);

    if (toSummarize.length === 0) return;

    // AWM: Extract task description before summarizing.
    let taskDescription: Message | undefined;
    if (this.namedStrategy?.preserveTaskDescription) {
      const firstUser = toSummarize.find((m) => m.role === 'user');
      if (firstUser) {
        taskDescription = firstUser;
      }
    }

    const summary = await this.summarizer(toSummarize);
    const summaryMsg: Message = {
      role: 'system',
      content: `[Conversation summary]\n${summary}`,
    };

    // Reconstruct: task description (if preserved) + summary + kept messages.
    if (taskDescription) {
      this.messages = [taskDescription, summaryMsg, ...toKeep];
    } else {
      this.messages = [summaryMsg, ...toKeep];
    }

    this.recalculateTokens();
  }

  // -----------------------------------------------------------------------
  // Strategy 3: sliding — sliding window with summary prefix
  // -----------------------------------------------------------------------

  private async compactSliding(): Promise<void> {
    if (!this.summarizer) {
      this.compactDropOldest();
      return;
    }

    const compactionTarget = this.namedStrategy?.compactionTarget ?? 0.6;

    // Determine the window size: keep enough recent messages to stay at target.
    const targetTokens = this.maxTokens * compactionTarget;
    let windowTokens = 0;
    let windowStart = this.messages.length;

    // AWM: Always preserve N recent tool-call pairs.
    const preserveToolPairs = this.namedStrategy?.preserveRecentToolPairs ?? 3;
    let toolPairsFound = 0;

    // Walk backwards to find the window boundary.
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(this.messages[i]!);
      if (windowTokens + msgTokens > targetTokens && toolPairsFound >= preserveToolPairs) break;

      // Don't split tool-call groups: if this message is a tool result,
      // include the preceding assistant message as well.
      if (isToolResultMessage(this.messages[i]!) && i > 0 && hasToolCalls(this.messages[i - 1]!)) {
        windowTokens += msgTokens + estimateTokens(this.messages[i - 1]!);
        windowStart = i - 1;
        toolPairsFound++;
        i--; // skip the assistant message on next iteration
      } else {
        windowTokens += msgTokens;
        windowStart = i;
        if (hasToolCalls(this.messages[i]!)) {
          toolPairsFound++;
        }
      }
    }

    if (windowStart <= 0) return; // everything already fits

    const toSummarize = this.messages.slice(0, windowStart);
    const window = this.messages.slice(windowStart);

    if (toSummarize.length === 0) return;

    // AWM: Extract task description before summarizing.
    let taskDescription: Message | undefined;
    if (this.namedStrategy?.preserveTaskDescription) {
      const firstUser = toSummarize.find((m) => m.role === 'user');
      if (firstUser) {
        taskDescription = firstUser;
      }
    }

    const summary = await this.summarizer(toSummarize);
    const summaryMsg: Message = {
      role: 'system',
      content: `[Conversation summary]\n${summary}`,
    };

    if (taskDescription) {
      this.messages = [taskDescription, summaryMsg, ...window];
    } else {
      this.messages = [summaryMsg, ...window];
    }

    this.recalculateTokens();
  }

  // -----------------------------------------------------------------------
  // AWM: Protected message index computation
  // -----------------------------------------------------------------------

  /**
   * Compute the set of message indices that should never be compacted away.
   * This implements the AWM insight that preserving task description and
   * recent tool interactions dramatically improves task success rates.
   */
  private getProtectedIndices(): Set<number> {
    const protected_ = new Set<number>();

    // Protect task description (first user message).
    if (this.namedStrategy?.preserveTaskDescription !== false) {
      const firstUserIdx = this.messages.findIndex((m) => m.role === 'user');
      if (firstUserIdx >= 0) {
        protected_.add(firstUserIdx);
      }
    }

    // Protect pinned roles.
    if (this.namedStrategy?.pinnedRoles) {
      for (let i = 0; i < this.messages.length; i++) {
        if (this.namedStrategy.pinnedRoles.includes(this.messages[i]!.role as 'user' | 'assistant' | 'system' | 'tool')) {
          protected_.add(i);
        }
      }
    }

    // Protect N most recent tool-call/result pairs.
    const preserveCount = this.namedStrategy?.preserveRecentToolPairs ?? 0;
    if (preserveCount > 0) {
      let pairsFound = 0;
      for (let i = this.messages.length - 1; i >= 0 && pairsFound < preserveCount; i--) {
        if (hasToolCalls(this.messages[i]!)) {
          protected_.add(i);
          // Also protect subsequent tool results.
          const groupEnd = this.findToolGroupEnd(i);
          for (let j = i; j <= groupEnd; j++) {
            protected_.add(j);
          }
          pairsFound++;
        }
      }
    }

    return protected_;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Given the index of an assistant message with tool calls, find the index
   * of the last related tool-result message that immediately follows it.
   */
  private findToolGroupEnd(assistantIdx: number): number {
    let end = assistantIdx;
    for (let i = assistantIdx + 1; i < this.messages.length; i++) {
      if (isToolResultMessage(this.messages[i]!)) {
        end = i;
      } else {
        break;
      }
    }
    return end;
  }

  /** Recompute tokenEstimate from scratch. */
  private recalculateTokens(): void {
    this.tokenEstimate = this.systemPrompt ? estimateTokens(this.systemPrompt) : 0;
    for (const msg of this.messages) {
      this.tokenEstimate += estimateTokens(msg);
    }
  }
}
