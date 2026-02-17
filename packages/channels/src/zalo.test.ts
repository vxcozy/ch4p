/**
 * ZaloChannel unit tests.
 *
 * Validates Zalo OA webhook processing, message sending, access token
 * management, MAC verification, access control, and lifecycle methods.
 * All fetch calls are mocked — no real network traffic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZaloChannel } from './zalo.js';
import type { ZaloConfig } from './zalo.js';
import type { InboundMessage } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig: ZaloConfig = {
  oaId: 'oa-123',
  oaSecretKey: 'test-secret-key',
  accessToken: 'test-access-token',
  appId: 'app-456',
};

/** Create a mock send response (success). */
function sendResponse(msgId = 'zalo-msg-1') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ error: 0, message: 'Success', data: { message_id: msgId } }),
    text: async () => '',
  };
}

/** Create a mock health check response. */
function healthResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ error: 0, data: { oa_id: 'oa-123', name: 'Test OA' } }),
    text: async () => '',
  };
}

/** Create a basic Zalo user_send_text webhook event. */
function createTextEvent(overrides: Record<string, unknown> = {}) {
  return {
    app_id: 'app-456',
    user_id_by_app: 'user-app-1',
    event_name: 'user_send_text',
    timestamp: '1705312200000',
    sender: { id: 'sender-1' },
    recipient: { id: 'oa-123' },
    message: {
      msg_id: 'zmsg-001',
      text: 'Hello from Zalo!',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ZaloChannel', () => {
  let channel: ZaloChannel;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    channel = new ZaloChannel();
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
      expect(channel.id).toBe('zalo');
      expect(channel.name).toBe('Zalo');
    });

    it('should require oaId in config', async () => {
      await expect(
        channel.start({ oaSecretKey: 's', accessToken: 't', appId: 'a' } as ZaloConfig),
      ).rejects.toThrow('oaId');
    });

    it('should require oaSecretKey in config', async () => {
      await expect(
        channel.start({ oaId: 'o', accessToken: 't', appId: 'a' } as ZaloConfig),
      ).rejects.toThrow('oaSecretKey');
    });

    it('should require accessToken in config', async () => {
      await expect(
        channel.start({ oaId: 'o', oaSecretKey: 's', appId: 'a' } as ZaloConfig),
      ).rejects.toThrow('accessToken');
    });

    it('should require appId in config', async () => {
      await expect(
        channel.start({ oaId: 'o', oaSecretKey: 's', accessToken: 't' } as ZaloConfig),
      ).rejects.toThrow('appId');
    });

    it('should start successfully with valid config', async () => {
      await channel.start(baseConfig);
      // No fetch calls during start — unlike Teams, Zalo uses pre-existing tokens.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should stop and clear state', async () => {
      await channel.start(baseConfig);
      await channel.stop();

      const healthy = await channel.isHealthy();
      expect(healthy).toBe(false);
    });
  });

  // ---- Health check ----

  describe('isHealthy', () => {
    it('should return false when not started', async () => {
      expect(await channel.isHealthy()).toBe(false);
    });

    it('should return true when API responds successfully', async () => {
      await channel.start(baseConfig);
      fetchMock.mockResolvedValueOnce(healthResponse());

      expect(await channel.isHealthy()).toBe(true);
    });

    it('should return false on API error', async () => {
      await channel.start(baseConfig);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ error: -216, message: 'Invalid access token' }),
      });

      expect(await channel.isHealthy()).toBe(false);
    });

    it('should return false on network error', async () => {
      await channel.start(baseConfig);
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      expect(await channel.isHealthy()).toBe(false);
    });
  });

  // ---- Inbound event handling ----

  describe('handleIncomingEvent', () => {
    it('should process user_send_text events', async () => {
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingEvent(createTextEvent() as any);

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe('Hello from Zalo!');
      expect(received[0]!.id).toBe('zmsg-001');
      expect(received[0]!.from.userId).toBe('sender-1');
    });

    it('should skip non-text events', async () => {
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingEvent(createTextEvent({ event_name: 'user_send_image' }) as any);

      expect(received).toHaveLength(0);
    });

    it('should skip events with no text', async () => {
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createTextEvent({ message: { msg_id: 'z1', text: undefined } }) as any,
      );

      expect(received).toHaveLength(0);
    });

    it('should skip events with no sender', async () => {
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingEvent(createTextEvent({ sender: { id: '' } }) as any);

      expect(received).toHaveLength(0);
    });

    it('should not process when channel is not started', () => {
      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingEvent(createTextEvent() as any);

      expect(received).toHaveLength(0);
    });

    it('should filter by allowedUsers when configured', async () => {
      await channel.start({ ...baseConfig, allowedUsers: ['allowed-user'] });

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // User NOT in allowed list.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingEvent(createTextEvent({ sender: { id: 'blocked-user' } }) as any);
      expect(received).toHaveLength(0);

      // User IN allowed list.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingEvent(createTextEvent({ sender: { id: 'allowed-user' } }) as any);
      expect(received).toHaveLength(1);
    });

    it('should parse timestamp correctly', async () => {
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingEvent(createTextEvent({ timestamp: '1705312200000' }) as any);

      expect(received).toHaveLength(1);
      expect(received[0]!.timestamp).toBeInstanceOf(Date);
      expect(received[0]!.timestamp.getTime()).toBe(1705312200000);
    });
  });

  // ---- Send ----

  describe('send', () => {
    it('should return error when not started', async () => {
      const result = await channel.send(
        { channelId: 'zalo', userId: 'user-1' },
        { text: 'Hello' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('not started');
    });

    it('should return error when no userId', async () => {
      await channel.start(baseConfig);

      const result = await channel.send(
        { channelId: 'zalo' },
        { text: 'Hello' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('userId');
    });

    it('should send message via Zalo OA API', async () => {
      await channel.start(baseConfig);
      fetchMock.mockResolvedValueOnce(sendResponse('zalo-msg-1'));

      const result = await channel.send(
        { channelId: 'zalo', userId: 'recipient-1' },
        { text: 'Hello Zalo user!' },
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('zalo-msg-1');

      // Verify the API call.
      const call = fetchMock.mock.calls[0];
      expect(call[0]).toContain('/v3.0/oa/message/cs');
      expect(call[1].method).toBe('POST');
      expect(call[1].headers['access_token']).toBe('test-access-token');

      const body = JSON.parse(call[1].body);
      expect(body.recipient.user_id).toBe('recipient-1');
      expect(body.message.text).toBe('Hello Zalo user!');
    });

    it('should handle Zalo API error responses', async () => {
      await channel.start(baseConfig);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ error: -216, message: 'Invalid access token' }),
        text: async () => '',
      });

      const result = await channel.send(
        { channelId: 'zalo', userId: 'user-1' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('-216');
    });

    it('should handle HTTP errors', async () => {
      await channel.start(baseConfig);
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const result = await channel.send(
        { channelId: 'zalo', userId: 'user-1' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });

    it('should handle network errors', async () => {
      await channel.start(baseConfig);
      fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await channel.send(
        { channelId: 'zalo', userId: 'user-1' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
    });
  });

  // ---- MAC verification ----

  describe('verifyWebhookMac', () => {
    it('should return false when not started', async () => {
      const result = await channel.verifyWebhookMac('{}', 'abc');
      expect(result).toBe(false);
    });

    it('should verify valid MAC', async () => {
      await channel.start(baseConfig);

      // Compute the expected MAC manually.
      const { createHash } = await import('node:crypto');
      const rawBody = JSON.stringify({ app_id: 'app-456', timestamp: '1705312200000', event_name: 'user_send_text' });
      const baseString = `app-456${rawBody}1705312200000test-secret-key`;
      const expectedMac = createHash('sha256').update(baseString).digest('hex');

      const result = await channel.verifyWebhookMac(rawBody, expectedMac);
      expect(result).toBe(true);
    });

    it('should reject invalid MAC', async () => {
      await channel.start(baseConfig);

      const rawBody = JSON.stringify({ app_id: 'app-456', timestamp: '1705312200000' });
      const result = await channel.verifyWebhookMac(rawBody, 'invalid-mac-value');
      expect(result).toBe(false);
    });

    it('should handle malformed body gracefully', async () => {
      await channel.start(baseConfig);

      const result = await channel.verifyWebhookMac('not json', 'abc');
      expect(result).toBe(false);
    });
  });

  // ---- Token refresh ----

  describe('token refresh', () => {
    it('should refresh token when expired and refreshToken is available', async () => {
      await channel.start({
        ...baseConfig,
        refreshToken: 'refresh-token-1',
        appSecret: 'app-secret-1',
      });

      // Expire the current token.
      // Access private field via any cast.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (channel as any).tokenExpiry = 0;

      // Mock token refresh response, then send response.
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'new-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce(sendResponse());

      const result = await channel.send(
        { channelId: 'zalo', userId: 'user-1' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(true);

      // Verify token refresh was called.
      const refreshCall = fetchMock.mock.calls[0];
      expect(refreshCall[0]).toContain('/v2.0/me/token');
      expect(refreshCall[1].body).toContain('refresh_token');

      // Verify send used new token.
      const sendCall = fetchMock.mock.calls[1];
      expect(sendCall[1].headers['access_token']).toBe('new-token');
    });

    it('should fall back to current token when refresh fails', async () => {
      await channel.start({
        ...baseConfig,
        refreshToken: 'refresh-token-1',
        appSecret: 'app-secret-1',
      });

      // Expire the current token.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (channel as any).tokenExpiry = 0;

      // Mock refresh failure, then send response.
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => 'Token expired',
        })
        .mockResolvedValueOnce(sendResponse());

      const result = await channel.send(
        { channelId: 'zalo', userId: 'user-1' },
        { text: 'Hello' },
      );

      // Should still succeed using the original token.
      expect(result.success).toBe(true);
    });
  });

  // ---- onMessage ----

  describe('onMessage', () => {
    it('should set the message handler', async () => {
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingEvent(createTextEvent() as any);

      expect(received).toHaveLength(1);
    });

    it('should replace previous handler', async () => {
      await channel.start(baseConfig);

      const first: InboundMessage[] = [];
      const second: InboundMessage[] = [];

      channel.onMessage((msg) => first.push(msg));
      channel.onMessage((msg) => second.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingEvent(createTextEvent() as any);

      expect(first).toHaveLength(0);
      expect(second).toHaveLength(1);
    });
  });
});
