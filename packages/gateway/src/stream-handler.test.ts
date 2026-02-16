/**
 * Tests for StreamHandler — progressive edit-based message streaming.
 *
 * Uses a mock channel to verify the StreamHandler correctly coordinates
 * initial sends, progressive edits, and final complete messages.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IChannel, Recipient, OutboundMessage, SendResult, ChannelConfig, PresenceEvent } from '@ch4p/core';
import { StreamHandler } from './stream-handler.js';
import type { StreamableEvent } from './stream-handler.js';

// ---------------------------------------------------------------------------
// Mock channel that supports editMessage
// ---------------------------------------------------------------------------

function createMockChannel(supportsEdit = true): IChannel & { editMessage?: IChannel['editMessage'] } {
  const ch: IChannel & { editMessage?: IChannel['editMessage'] } = {
    id: 'test',
    name: 'Test',
    start: vi.fn(async (_config: ChannelConfig) => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async (_to: Recipient, _message: OutboundMessage): Promise<SendResult> => ({
      success: true,
      messageId: 'msg-001',
    })),
    onMessage: vi.fn((_handler: (msg: any) => void) => {}),
    isHealthy: vi.fn(async () => true),
  };

  if (supportsEdit) {
    ch.editMessage = vi.fn(async (_to: Recipient, _msgId: string, _message: OutboundMessage): Promise<SendResult> => ({
      success: true,
      messageId: 'msg-001',
    }));
  }

  return ch;
}

const TO: Recipient = { channelId: 'test', userId: 'user-1' };

// ===========================================================================
// StreamHandler
// ===========================================================================

describe('StreamHandler', () => {
  // -------------------------------------------------------------------------
  // With editMessage support
  // -------------------------------------------------------------------------

  describe('with editMessage support', () => {
    let channel: ReturnType<typeof createMockChannel>;

    beforeEach(() => {
      channel = createMockChannel(true);
    });

    it('sends initial message on first text event', async () => {
      const handler = new StreamHandler({ channel, to: TO });

      const event: StreamableEvent = { type: 'text', delta: 'Hello', partial: 'Hello' };
      const result = await handler.handleEvent(event);

      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.messageId).toBe('msg-001');
      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledWith(TO, expect.objectContaining({ text: 'Hello' }));
    });

    it('edits message on subsequent text events', async () => {
      const handler = new StreamHandler({ channel, to: TO });

      // First event — sends.
      await handler.handleEvent({ type: 'text', delta: 'Hello', partial: 'Hello' });
      expect(channel.send).toHaveBeenCalledTimes(1);

      // Second event — edits.
      await handler.handleEvent({ type: 'text', delta: ' world', partial: 'Hello world' });
      expect(channel.editMessage).toHaveBeenCalledTimes(1);
      expect(channel.editMessage).toHaveBeenCalledWith(
        TO,
        'msg-001',
        expect.objectContaining({ text: 'Hello world' }),
      );
    });

    it('does final edit on complete event', async () => {
      const handler = new StreamHandler({ channel, to: TO });

      // Send initial message.
      await handler.handleEvent({ type: 'text', delta: 'Hi', partial: 'Hi' });

      // Complete event — final edit.
      const result = await handler.handleEvent({ type: 'complete', answer: 'Hi there!' });
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(channel.editMessage).toHaveBeenCalledWith(
        TO,
        'msg-001',
        expect.objectContaining({ text: 'Hi there!' }),
      );
    });

    it('sends full answer on complete if no text events preceded', async () => {
      const handler = new StreamHandler({ channel, to: TO });

      // No text events — complete directly sends.
      const result = await handler.handleEvent({ type: 'complete', answer: 'Full answer here.' });
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledWith(TO, expect.objectContaining({ text: 'Full answer here.' }));
      expect(channel.editMessage).not.toHaveBeenCalled();
    });

    it('tracks accumulated text', async () => {
      const handler = new StreamHandler({ channel, to: TO });

      await handler.handleEvent({ type: 'text', delta: 'A', partial: 'A' });
      expect(handler.getAccumulatedText()).toBe('A');

      await handler.handleEvent({ type: 'text', delta: 'B', partial: 'AB' });
      expect(handler.getAccumulatedText()).toBe('AB');
    });

    it('tracks sent message ID', async () => {
      const handler = new StreamHandler({ channel, to: TO });

      expect(handler.getSentMessageId()).toBeNull();
      await handler.handleEvent({ type: 'text', delta: 'Hi', partial: 'Hi' });
      expect(handler.getSentMessageId()).toBe('msg-001');
    });

    it('passes format and replyTo options', async () => {
      const handler = new StreamHandler({
        channel,
        to: TO,
        format: 'markdown',
        replyTo: 'parent-msg-123',
      });

      await handler.handleEvent({ type: 'text', delta: '**bold**', partial: '**bold**' });
      expect(channel.send).toHaveBeenCalledWith(TO, expect.objectContaining({
        text: '**bold**',
        format: 'markdown',
        replyTo: 'parent-msg-123',
      }));
    });

    it('returns null for unrecognized event types', async () => {
      const handler = new StreamHandler({ channel, to: TO });

      const result = await handler.handleEvent({ type: 'tool_call', name: 'search' } as StreamableEvent);
      expect(result).toBeNull();
      expect(channel.send).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Without editMessage support
  // -------------------------------------------------------------------------

  describe('without editMessage support', () => {
    let channel: ReturnType<typeof createMockChannel>;

    beforeEach(() => {
      channel = createMockChannel(false);
    });

    it('skips intermediate text events', async () => {
      const handler = new StreamHandler({ channel, to: TO });

      const result1 = await handler.handleEvent({ type: 'text', delta: 'Hi', partial: 'Hi' });
      expect(result1).toBeNull();
      expect(channel.send).not.toHaveBeenCalled();

      const result2 = await handler.handleEvent({ type: 'text', delta: ' there', partial: 'Hi there' });
      expect(result2).toBeNull();
      expect(channel.send).not.toHaveBeenCalled();
    });

    it('sends full answer on complete', async () => {
      const handler = new StreamHandler({ channel, to: TO });

      // Text events are skipped.
      await handler.handleEvent({ type: 'text', delta: 'Hi', partial: 'Hi' });

      // Complete sends the full answer.
      const result = await handler.handleEvent({ type: 'complete', answer: 'Hi there, how are you?' });
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledWith(TO, expect.objectContaining({
        text: 'Hi there, how are you?',
      }));
    });

    it('sends complete even with no preceding text events', async () => {
      const handler = new StreamHandler({ channel, to: TO });

      const result = await handler.handleEvent({ type: 'complete', answer: 'Direct answer.' });
      expect(result!.success).toBe(true);
      expect(channel.send).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles send failure gracefully', async () => {
      const channel = createMockChannel(true);
      (channel.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Network error',
      });

      const handler = new StreamHandler({ channel, to: TO });
      const result = await handler.handleEvent({ type: 'text', delta: 'Hi', partial: 'Hi' });

      expect(result!.success).toBe(false);
      expect(result!.error).toBe('Network error');
      // sentMessageId should remain null since send failed.
      expect(handler.getSentMessageId()).toBeNull();
    });

    it('handles send without messageId in response', async () => {
      const channel = createMockChannel(true);
      (channel.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        // No messageId returned.
      });

      const handler = new StreamHandler({ channel, to: TO });
      await handler.handleEvent({ type: 'text', delta: 'Hi', partial: 'Hi' });

      // Without messageId, cannot do edit-based streaming.
      // sentMessageId stays null.
      expect(handler.getSentMessageId()).toBeNull();
    });

    it('falls back to send on complete when send returned no messageId', async () => {
      const channel = createMockChannel(true);
      (channel.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        // No messageId.
      });

      const handler = new StreamHandler({ channel, to: TO });
      await handler.handleEvent({ type: 'text', delta: 'Hi', partial: 'Hi' });

      // Complete should fall back to send (since sentMessageId is null).
      const result = await handler.handleEvent({ type: 'complete', answer: 'Full answer.' });
      expect(result!.success).toBe(true);
      // send called twice: once for initial text, once for complete fallback.
      expect(channel.send).toHaveBeenCalledTimes(2);
    });
  });
});
