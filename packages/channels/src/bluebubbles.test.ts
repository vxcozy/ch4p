/**
 * BlueBubblesChannel unit tests.
 *
 * Validates BlueBubbles REST API integration, webhook event processing,
 * access control, health checks, and lifecycle methods.
 * All fetch calls are mocked — no real network traffic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlueBubblesChannel } from './bluebubbles.js';
import type { BlueBubblesConfig, BlueBubblesEvent } from './bluebubbles.js';
import type { InboundMessage } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig: BlueBubblesConfig = {
  host: 'http://localhost:1234',
  password: 'test-password',
};

function serverInfoResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: 200, data: { os_version: '14.0', server_version: '1.9.0' } }),
    text: async () => '',
  };
}

function sendMessageResponse(guid = 'msg-guid-123') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: 200, message: 'Success', data: { guid } }),
    text: async () => '',
  };
}

function createEvent(overrides: Partial<BlueBubblesEvent['data']> = {}): BlueBubblesEvent {
  return {
    type: 'new-message',
    data: {
      guid: 'bb-msg-001',
      text: 'Hello from iMessage!',
      handle: { address: '+15551234567', id: '+15551234567' },
      chats: [{ guid: 'iMessage;-;+15551234567', chatIdentifier: '+15551234567' }],
      dateCreated: 1700000000000,
      isFromMe: false,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BlueBubblesChannel', () => {
  let channel: BlueBubblesChannel;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    channel = new BlueBubblesChannel();
    fetchMock = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(async () => {
    try {
      await channel.stop();
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  // ---- Lifecycle ----

  describe('lifecycle', () => {
    it('should have correct id and name', () => {
      expect(channel.id).toBe('bluebubbles');
      expect(channel.name).toBe('BlueBubbles');
    });

    it('should require host in config', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await expect(
        channel.start({ password: 'pass' } as BlueBubblesConfig),
      ).rejects.toThrow('host');
    });

    it('should require password in config', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await expect(
        channel.start({ host: 'http://localhost:1234' } as BlueBubblesConfig),
      ).rejects.toThrow('password');
    });

    it('should start successfully when server is reachable', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      // Health check was made during start.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/api/v1/server/info');
      expect(url).toContain('password=test-password');
    });

    it('should throw when server is unreachable on start', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(channel.start(baseConfig)).rejects.toThrow('Cannot connect');
    });

    it('should strip trailing slash from host', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start({ ...baseConfig, host: 'http://localhost:1234///' });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url.startsWith('http://localhost:1234/api/')).toBe(true);
    });

    it('should stop and clear state', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);
      await channel.stop();

      expect(await channel.isHealthy()).toBe(false);
    });
  });

  // ---- Health check ----

  describe('isHealthy', () => {
    it('should return false when not started', async () => {
      expect(await channel.isHealthy()).toBe(false);
    });

    it('should return true when server responds OK', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      expect(await channel.isHealthy()).toBe(true);
    });

    it('should return false when server returns non-200 status', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 500, data: null }),
        text: async () => '',
      });
      expect(await channel.isHealthy()).toBe(false);
    });
  });

  // ---- Inbound event handling ----

  describe('handleIncomingEvent', () => {
    it('should process new-message events', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createEvent());

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe('Hello from iMessage!');
      expect(received[0]!.from.userId).toBe('+15551234567');
      expect(received[0]!.id).toBe('bb-msg-001');
    });

    it('should skip non new-message events', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent({
        type: 'updated-message',
        data: createEvent().data,
      });

      expect(received).toHaveLength(0);
    });

    it('should skip messages from self', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createEvent({ isFromMe: true }));

      expect(received).toHaveLength(0);
    });

    it('should skip messages with no text', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createEvent({ text: undefined }));

      expect(received).toHaveLength(0);
    });

    it('should skip messages with no sender address', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createEvent({ handle: {} }));

      expect(received).toHaveLength(0);
    });

    it('should filter by allowedAddresses', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start({ ...baseConfig, allowedAddresses: ['+15559999999'] });

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // Not in allowed list.
      channel.handleIncomingEvent(createEvent());
      expect(received).toHaveLength(0);

      // In allowed list.
      channel.handleIncomingEvent(createEvent({
        handle: { address: '+15559999999' },
      }));
      expect(received).toHaveLength(1);
    });

    it('should set groupId for group chats', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createEvent({
        chats: [{ guid: 'chat12345', chatIdentifier: 'chat12345' }],
      }));

      expect(received[0]!.from.groupId).toBe('chat12345');
    });

    it('should not process when channel is not started', () => {
      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createEvent());

      expect(received).toHaveLength(0);
    });
  });

  // ---- Send ----

  describe('send', () => {
    it('should return error when not started', async () => {
      const result = await channel.send(
        { channelId: 'chat-guid', userId: 'user-1' },
        { text: 'Hello' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('not started');
    });

    it('should send message via BlueBubbles API', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce(sendMessageResponse('sent-guid'));

      const result = await channel.send(
        { channelId: 'iMessage;-;+15551234567' },
        { text: 'Reply from ch4p!' },
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('sent-guid');

      const sendCall = fetchMock.mock.calls[1];
      const url = sendCall[0] as string;
      expect(url).toContain('/api/v1/message/text');
      expect(url).toContain('password=test-password');

      const body = JSON.parse(sendCall[1].body);
      expect(body.chatGuid).toBe('iMessage;-;+15551234567');
      expect(body.message).toBe('Reply from ch4p!');
    });

    it('should handle API errors gracefully', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      });

      const result = await channel.send(
        { channelId: 'chat-guid' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });

    it('should handle non-200 status in response body', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 400, message: 'Bad request', error: { message: 'Chat not found' } }),
        text: async () => '',
      });

      const result = await channel.send(
        { channelId: 'bad-chat' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Chat not found');
    });

    it('should return error when no chat GUID specified', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      const result = await channel.send(
        { channelId: '' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No chat GUID');
    });
  });

  // ---- onMessage ----

  describe('onMessage', () => {
    it('should replace previous handler', async () => {
      fetchMock.mockResolvedValueOnce(serverInfoResponse());
      await channel.start(baseConfig);

      const first: InboundMessage[] = [];
      const second: InboundMessage[] = [];

      channel.onMessage((msg) => first.push(msg));
      channel.onMessage((msg) => second.push(msg));

      channel.handleIncomingEvent(createEvent());

      expect(first).toHaveLength(0);
      expect(second).toHaveLength(1);
    });
  });
});
