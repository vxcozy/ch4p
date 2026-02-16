/**
 * StreamHandler — coordinates progressive message streaming via channel edits.
 *
 * When a channel supports `editMessage()`, the StreamHandler enables
 * "edit-based streaming" where the agent's response is progressively
 * updated in-place rather than sent as a single final message.
 *
 * Flow:
 *   1. On first `text` event → `channel.send()` with initial content, capture messageId
 *   2. On subsequent `text` events → `channel.editMessage()` with accumulated content
 *   3. On `complete` event → final `channel.editMessage()` with the full answer
 *   4. Falls back to single `channel.send()` on `complete` if channel doesn't support editing
 *
 * Rate limiting is handled by the channel's `editMessage()` implementation.
 */

import type {
  IChannel,
  Recipient,
  OutboundMessage,
  SendResult,
} from '@ch4p/core';

// ---------------------------------------------------------------------------
// Minimal event type (avoids circular dependency on @ch4p/agent)
// ---------------------------------------------------------------------------

/**
 * Subset of AgentEvent that StreamHandler cares about.
 * Defined locally to avoid a dependency on @ch4p/agent from the gateway.
 */
export type StreamableEvent =
  | { type: 'text'; delta: string; partial: string }
  | { type: 'complete'; answer: string; usage?: unknown }
  | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// StreamHandler
// ---------------------------------------------------------------------------

export interface StreamHandlerOpts {
  /** The channel to stream through. */
  channel: IChannel;
  /** The recipient to send messages to. */
  to: Recipient;
  /** Message format (default: 'text'). */
  format?: OutboundMessage['format'];
  /** Optional replyTo message ID. */
  replyTo?: string;
}

export class StreamHandler {
  private readonly channel: IChannel;
  private readonly to: Recipient;
  private readonly format: OutboundMessage['format'];
  private readonly replyTo?: string;
  private sentMessageId: string | null = null;
  private accumulatedText = '';
  private supportsEdit: boolean;

  constructor(opts: StreamHandlerOpts) {
    this.channel = opts.channel;
    this.to = opts.to;
    this.format = opts.format ?? 'text';
    this.replyTo = opts.replyTo;
    this.supportsEdit = typeof this.channel.editMessage === 'function';
  }

  /**
   * Process an AgentEvent and handle streaming output to the channel.
   * Returns the SendResult when a message is sent or edited, or null
   * if no channel action was needed.
   */
  async handleEvent(event: StreamableEvent): Promise<SendResult | null> {
    if (event.type === 'text') {
      return this.handleTextDelta(event.partial as string);
    }
    if (event.type === 'complete') {
      return this.handleComplete(event.answer as string);
    }
    return null;
  }

  /**
   * Handle a text delta event. On first delta, sends a new message.
   * On subsequent deltas, edits the message if the channel supports it.
   */
  private async handleTextDelta(partial: string): Promise<SendResult | null> {
    this.accumulatedText = partial;

    if (!this.supportsEdit) {
      // Channel doesn't support editing — skip intermediate updates.
      // The final answer will be sent in handleComplete().
      return null;
    }

    if (!this.sentMessageId) {
      // First text event — send the initial message.
      const result = await this.channel.send(this.to, {
        text: partial,
        format: this.format,
        replyTo: this.replyTo,
      });

      if (result.success && result.messageId) {
        this.sentMessageId = result.messageId;
      }

      return result;
    }

    // Subsequent text event — edit the existing message.
    return this.channel.editMessage!(this.to, this.sentMessageId, {
      text: partial,
      format: this.format,
    });
  }

  /**
   * Handle the complete event — send final answer.
   * If we've been streaming edits, do one final edit with the full answer.
   * If no message was sent yet (or channel doesn't support edits), send the full answer.
   */
  private async handleComplete(answer: string): Promise<SendResult> {
    if (this.sentMessageId && this.supportsEdit) {
      // Final edit with the complete answer.
      return this.channel.editMessage!(this.to, this.sentMessageId, {
        text: answer,
        format: this.format,
      });
    }

    // Either no message was sent yet (streaming was off or no text events)
    // or the channel doesn't support editing — send the full answer.
    return this.channel.send(this.to, {
      text: answer,
      format: this.format,
      replyTo: this.replyTo,
    });
  }

  /**
   * Get the current accumulated text.
   */
  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  /**
   * Get the sent message ID (if a message has been sent).
   */
  getSentMessageId(): string | null {
    return this.sentMessageId;
  }
}
