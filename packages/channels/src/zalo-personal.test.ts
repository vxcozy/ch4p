/**
 * ZaloPersonalChannel unit tests.
 *
 * Validates bridge communication, TOS warning, access control,
 * inbound event processing, and lifecycle methods.
 * All fetch calls are mocked — no real network traffic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZaloPersonalChannel } from './zalo-personal.js';
import type { ZaloPersonalConfig, ZaloPersonalEvent } from './zalo-personal.js';
import type { InboundMessage } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig: ZaloPersonalConfig = {
  bridgeUrl: 'http://localhost:9999',
};

function healthyResponse() {
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
}

function sendResponse(messageId = 'zp-123') {
  return { ok: true, status: 200, json: async () => ({ messageId }), text: async () => '' };
}

function createEvent(overrides: Partial<ZaloPersonalEvent> = {}): ZaloPersonalEvent {
  return {
    sender: 'user-123',
    text: 'Hello from Zalo!',
    timestamp: 1700000000000,
    messageId: 'msg-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ZaloPersonalChannel', () => {
  let channel: ZaloPersonalChannel;
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    channel = new ZaloPersonalChannel();
    fetchMock = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
      expect(channel.id).toBe('zalo-personal');
      expect(channel.name).toBe('Zalo Personal');
    });

    it('should require bridgeUrl in config', async () => {
      await expect(
        channel.start({} as ZaloPersonalConfig),
      ).rejects.toThrow('bridgeUrl');
    });

    it('should start successfully and log TOS warning', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start(baseConfig);

      // TOS warning should be logged.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Terms of Service'),
      );
    });

    it('should strip trailing slash from bridgeUrl', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start({ bridgeUrl: 'http://localhost:9999///' });

      // Verify health check used normalized URL.
      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/health');
    });

    it('should warn but not throw when bridge is unreachable', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await channel.start(baseConfig);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('not responding'),
      );
    });

    it('should stop and clear state', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
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

    it('should return true when bridge responds 200', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce(healthyResponse());
      expect(await channel.isHealthy()).toBe(true);
    });

    it('should return false when bridge returns non-200', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
      expect(await channel.isHealthy()).toBe(false);
    });

    it('should include bearer token in health check when configured', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start({ ...baseConfig, bridgeToken: 'secret-tok' });

      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.isHealthy();

      const healthCall = fetchMock.mock.calls[1];
      expect(healthCall[1].headers['Authorization']).toBe('Bearer secret-tok');
    });
  });

  // ---- Inbound event handling ----

  describe('handleIncomingEvent', () => {
    it('should process valid events', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createEvent());

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe('Hello from Zalo!');
      expect(received[0]!.from.userId).toBe('user-123');
      expect(received[0]!.id).toBe('msg-001');
    });

    it('should skip events with no sender', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createEvent({ sender: '' }));

      expect(received).toHaveLength(0);
    });

    it('should skip events with no text', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createEvent({ text: '' }));

      expect(received).toHaveLength(0);
    });

    it('should filter by allowedUsers', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start({ ...baseConfig, allowedUsers: ['allowed-user'] });

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // Not in allowed list.
      channel.handleIncomingEvent(createEvent({ sender: 'blocked-user' }));
      expect(received).toHaveLength(0);

      // In allowed list.
      channel.handleIncomingEvent(createEvent({ sender: 'allowed-user' }));
      expect(received).toHaveLength(1);
    });

    it('should set groupId when threadId is present', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createEvent({ threadId: 'thread-1' }));

      expect(received[0]!.from.groupId).toBe('thread-1');
      expect(received[0]!.channelId).toBe('thread-1');
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
        { channelId: 'user-1', userId: 'user-1' },
        { text: 'Hello' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('not started');
    });

    it('should send message via bridge API', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce(sendResponse('msg-sent'));

      const result = await channel.send(
        { channelId: 'user-1', userId: 'user-1' },
        { text: 'Hello Zalo!' },
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-sent');

      const sendCall = fetchMock.mock.calls[1];
      expect(sendCall[0]).toBe('http://localhost:9999/send');
      expect(sendCall[1].method).toBe('POST');

      const body = JSON.parse(sendCall[1].body);
      expect(body.to).toBe('user-1');
      expect(body.text).toBe('Hello Zalo!');
    });

    it('should include bearer token when configured', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start({ ...baseConfig, bridgeToken: 'my-token' });

      fetchMock.mockResolvedValueOnce(sendResponse());

      await channel.send(
        { channelId: 'user-1', userId: 'user-1' },
        { text: 'Hello' },
      );

      const sendCall = fetchMock.mock.calls[1];
      expect(sendCall[1].headers['Authorization']).toBe('Bearer my-token');
    });

    it('should handle bridge errors gracefully', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      });

      const result = await channel.send(
        { channelId: 'user-1', userId: 'user-1' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });

    it('should return error when no target specified', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
      await channel.start(baseConfig);

      const result = await channel.send(
        { channelId: '' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No target');
    });
  });

  // ---- onMessage ----

  describe('onMessage', () => {
    it('should replace previous handler', async () => {
      fetchMock.mockResolvedValueOnce(healthyResponse());
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
