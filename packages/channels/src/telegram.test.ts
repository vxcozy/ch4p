/**
 * Tests for TelegramChannel — topic/forum support and message routing.
 */

import { vi } from 'vitest';
import { TelegramChannel } from './telegram.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTelegramChannel(): TelegramChannel {
  return new TelegramChannel();
}

/** Simulate the private processMessage path by calling handleWebhookUpdate. */
function triggerMessage(
  channel: TelegramChannel,
  overrides: {
    message_id?: number;
    from_id?: number;
    chat_id?: number;
    chat_type?: string;
    text?: string;
    message_thread_id?: number;
    is_topic_message?: boolean;
  } = {},
) {
  const update = {
    update_id: 1,
    message: {
      message_id: overrides.message_id ?? 100,
      from: { id: overrides.from_id ?? 42, first_name: 'Test' },
      chat: {
        id: overrides.chat_id ?? (overrides.chat_type === 'private' ? overrides.from_id ?? 42 : 1000),
        type: overrides.chat_type ?? 'private',
      },
      text: overrides.text ?? 'Hello',
      date: Math.floor(Date.now() / 1000),
      ...(overrides.message_thread_id !== undefined ? { message_thread_id: overrides.message_thread_id } : {}),
      ...(overrides.is_topic_message !== undefined ? { is_topic_message: overrides.is_topic_message } : {}),
    },
  };
  channel.handleWebhookUpdate(update);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramChannel — topic/forum support', () => {
  describe('processMessage — threadId extraction', () => {
    it('sets threadId on forum topic messages', () => {
      const channel = makeTelegramChannel();
      let captured: Parameters<Parameters<typeof channel.onMessage>[0]>[0] | undefined;
      channel.onMessage((msg) => { captured = msg; });

      triggerMessage(channel, {
        chat_id: 1000,
        chat_type: 'supergroup',
        message_thread_id: 7,
        is_topic_message: true,
      });

      expect(captured?.from.threadId).toBe('7');
      expect(captured?.from.groupId).toBe('1000');
    });

    it('does not set threadId for non-topic group messages', () => {
      const channel = makeTelegramChannel();
      let captured: Parameters<Parameters<typeof channel.onMessage>[0]>[0] | undefined;
      channel.onMessage((msg) => { captured = msg; });

      triggerMessage(channel, {
        chat_id: 1000,
        chat_type: 'supergroup',
        // message_thread_id present but is_topic_message is false
        message_thread_id: 7,
        is_topic_message: false,
      });

      expect(captured?.from.threadId).toBeUndefined();
      expect(captured?.from.groupId).toBe('1000');
    });

    it('does not set threadId for private messages', () => {
      const channel = makeTelegramChannel();
      let captured: Parameters<Parameters<typeof channel.onMessage>[0]>[0] | undefined;
      channel.onMessage((msg) => { captured = msg; });

      triggerMessage(channel, {
        chat_type: 'private',
        from_id: 42,
        chat_id: 42,
      });

      expect(captured?.from.threadId).toBeUndefined();
      expect(captured?.from.groupId).toBeUndefined();
    });

    it('sets groupId for group messages without topics', () => {
      const channel = makeTelegramChannel();
      let captured: Parameters<Parameters<typeof channel.onMessage>[0]>[0] | undefined;
      channel.onMessage((msg) => { captured = msg; });

      triggerMessage(channel, {
        chat_id: 999,
        chat_type: 'group',
      });

      expect(captured?.from.groupId).toBe('999');
      expect(captured?.from.threadId).toBeUndefined();
    });
  });

  describe('send — message_thread_id forwarding', () => {
    it('includes message_thread_id when recipient has threadId', async () => {
      const channel = makeTelegramChannel();
      // @ts-expect-error — bypass private field for testing
      channel.baseUrl = 'https://api.telegram.org/botTEST';
      // @ts-expect-error
      channel.abortController = new AbortController();

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 200 } }),
      } as Response);

      await channel.send(
        { channelId: 'telegram', userId: '42', groupId: '1000', threadId: '7' },
        { text: 'Reply in topic' },
      );

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(body.message_thread_id).toBe(7);

      fetchSpy.mockRestore();
    });

    it('omits message_thread_id for non-topic sends', async () => {
      const channel = makeTelegramChannel();
      // @ts-expect-error
      channel.baseUrl = 'https://api.telegram.org/botTEST';
      // @ts-expect-error
      channel.abortController = new AbortController();

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 201 } }),
      } as Response);

      await channel.send(
        { channelId: 'telegram', userId: '42' },
        { text: 'Private reply' },
      );

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(body.message_thread_id).toBeUndefined();

      fetchSpy.mockRestore();
    });
  });

  describe('webhook secret verification', () => {
    it('accepts requests when no secret is configured', () => {
      const channel = makeTelegramChannel();
      expect(channel.verifyWebhookSecret(undefined)).toBe(true);
      expect(channel.verifyWebhookSecret('anything')).toBe(true);
    });
  });

  describe('getStreamMode', () => {
    it('returns "off" by default', () => {
      expect(makeTelegramChannel().getStreamMode()).toBe('off');
    });
  });
});
