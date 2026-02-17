/**
 * TeamsChannel unit tests.
 *
 * Validates Bot Framework activity processing, OAuth2 token management,
 * message sending/editing, access control, and lifecycle methods.
 * All fetch calls are mocked — no real network traffic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TeamsChannel } from './teams.js';
import type { TeamsConfig } from './teams.js';
import type { InboundMessage } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig: TeamsConfig = {
  appId: 'test-app-id',
  appPassword: 'test-app-secret',
};

/** Create a mock token response. */
function tokenResponse(expiresIn = 3600) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'mock-token-123', expires_in: expiresIn }),
    text: async () => '',
  };
}

/** Create a mock send/edit response. */
function activityResponse(id = 'activity-1') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ id }),
    text: async () => '',
  };
}

/** Create a basic Bot Framework message activity. */
function createMessageActivity(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    id: 'msg-001',
    timestamp: '2025-01-15T10:30:00Z',
    channelId: 'msteams',
    from: { id: 'user-1', name: 'Test User', aadObjectId: 'aad-user-1' },
    conversation: { id: 'conv-1', tenantId: 'tenant-1', isGroup: false },
    recipient: { id: 'test-app-id', name: 'Bot' },
    text: 'Hello bot!',
    serviceUrl: 'https://smba.trafficmanager.net/teams/',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamsChannel', () => {
  let channel: TeamsChannel;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    channel = new TeamsChannel();
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
      expect(channel.id).toBe('teams');
      expect(channel.name).toBe('Microsoft Teams');
    });

    it('should require appId in config', async () => {
      await expect(
        channel.start({ appPassword: 'secret' } as TeamsConfig),
      ).rejects.toThrow('appId');
    });

    it('should require appPassword in config', async () => {
      await expect(
        channel.start({ appId: 'app-id' } as TeamsConfig),
      ).rejects.toThrow('appPassword');
    });

    it('should start successfully with valid config', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);
      // Token was fetched during start (warm cache).
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should stop and clear state', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);
      await channel.stop();

      // After stop, isHealthy should return false.
      const healthy = await channel.isHealthy();
      expect(healthy).toBe(false);
    });
  });

  // ---- Token management ----

  describe('token management', () => {
    it('should acquire token on start', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      // Verify token request was made with correct params.
      expect(fetchMock).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );

      // Verify the body contains the expected params.
      const callArgs = fetchMock.mock.calls[0];
      const body = callArgs[1].body;
      expect(body).toContain('grant_type=client_credentials');
      expect(body).toContain('client_id=test-app-id');
      expect(body).toContain('client_secret=test-app-secret');
    });

    it('should reuse cached token within expiry window', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse(3600));
      await channel.start(baseConfig);

      // isHealthy should NOT fetch a new token.
      const healthy = await channel.isHealthy();
      expect(healthy).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1); // Only the initial call.
    });

    it('should fail start if token request fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Invalid credentials',
      });
      await expect(channel.start(baseConfig)).rejects.toThrow('Token request failed');
    });
  });

  // ---- Health check ----

  describe('isHealthy', () => {
    it('should return false when not started', async () => {
      expect(await channel.isHealthy()).toBe(false);
    });

    it('should return true when token is valid', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);
      expect(await channel.isHealthy()).toBe(true);
    });
  });

  // ---- Inbound activity handling ----

  describe('handleIncomingActivity', () => {
    it('should process message activities', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingActivity(createMessageActivity() as any);

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe('Hello bot!');
      expect(received[0]!.id).toBe('msg-001');
      expect(received[0]!.channelId).toBe('conv-1');
    });

    it('should skip non-message activities', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingActivity(createMessageActivity({ type: 'conversationUpdate' }) as any);

      expect(received).toHaveLength(0);
    });

    it('should skip activities with no text', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingActivity(createMessageActivity({ text: undefined }) as any);

      expect(received).toHaveLength(0);
    });

    it('should skip messages from the bot itself', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingActivity(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createMessageActivity({ from: { id: 'test-app-id', name: 'Bot' } }) as any,
      );

      expect(received).toHaveLength(0);
    });

    it('should cache serviceUrl for conversations', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      channel.onMessage(() => {});

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingActivity(createMessageActivity() as any);

      // Now send — the serviceUrl should be cached.
      fetchMock.mockResolvedValueOnce(activityResponse());
      const result = await channel.send(
        { channelId: 'conv-1', userId: 'user-1' },
        { text: 'Reply!' },
      );

      expect(result.success).toBe(true);
    });

    it('should filter by allowedUsers when configured', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start({ ...baseConfig, allowedUsers: ['allowed-aad-id'] });

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // User NOT in allowed list — should be filtered.
      channel.handleIncomingActivity(
        createMessageActivity({
          from: { id: 'user-1', name: 'Blocked User', aadObjectId: 'not-allowed-aad-id' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      );
      expect(received).toHaveLength(0);

      // User IN allowed list — should pass.
      channel.handleIncomingActivity(
        createMessageActivity({
          from: { id: 'user-2', name: 'Allowed User', aadObjectId: 'allowed-aad-id' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      );
      expect(received).toHaveLength(1);
    });

    it('should set groupId for group conversations', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingActivity(
        createMessageActivity({
          conversation: { id: 'group-conv', tenantId: 'tenant-1', isGroup: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      );

      expect(received).toHaveLength(1);
      expect(received[0]!.from.groupId).toBe('group-conv');
    });

    it('should not process when channel is not started', () => {
      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingActivity(createMessageActivity() as any);

      expect(received).toHaveLength(0);
    });
  });

  // ---- Send ----

  describe('send', () => {
    it('should return error when not started', async () => {
      const result = await channel.send(
        { channelId: 'conv-1', userId: 'user-1' },
        { text: 'Hello' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('not started');
    });

    it('should return error when no serviceUrl for conversation', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const result = await channel.send(
        { channelId: 'unknown-conv', userId: 'user-1' },
        { text: 'Hello' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('No service URL');
    });

    it('should send message via Bot Framework API', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      channel.onMessage(() => {});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingActivity(createMessageActivity() as any);

      fetchMock.mockResolvedValueOnce(activityResponse('reply-1'));

      const result = await channel.send(
        { channelId: 'conv-1', userId: 'user-1' },
        { text: 'Hello back!', format: 'markdown' },
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('reply-1');

      // Verify the API call.
      const sendCall = fetchMock.mock.calls[1];
      expect(sendCall[0]).toContain('/v3/conversations/conv-1/activities');
      expect(sendCall[1].method).toBe('POST');
      expect(sendCall[1].headers['Authorization']).toBe('Bearer mock-token-123');

      const body = JSON.parse(sendCall[1].body);
      expect(body.type).toBe('message');
      expect(body.text).toBe('Hello back!');
      expect(body.textFormat).toBe('markdown');
    });

    it('should include replyToId when replyTo is set', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      channel.onMessage(() => {});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingActivity(createMessageActivity() as any);

      fetchMock.mockResolvedValueOnce(activityResponse());

      await channel.send(
        { channelId: 'conv-1', userId: 'user-1' },
        { text: 'Threaded reply', replyTo: 'parent-msg-id' },
      );

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.replyToId).toBe('parent-msg-id');
    });

    it('should handle API errors gracefully', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      channel.onMessage(() => {});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingActivity(createMessageActivity() as any);

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      });

      const result = await channel.send(
        { channelId: 'conv-1', userId: 'user-1' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('429');
    });
  });

  // ---- Edit message ----

  describe('editMessage', () => {
    it('should return error when not started', async () => {
      const result = await channel.editMessage(
        { channelId: 'conv-1', userId: 'user-1' },
        'msg-id',
        { text: 'Updated' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('not started');
    });

    it('should edit message via PUT to activity endpoint', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      channel.onMessage(() => {});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingActivity(createMessageActivity() as any);

      fetchMock.mockResolvedValueOnce(activityResponse('msg-to-edit'));

      const result = await channel.editMessage(
        { channelId: 'conv-1', userId: 'user-1' },
        'msg-to-edit',
        { text: 'Updated text', format: 'markdown' },
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-to-edit');

      // Verify the API call uses PUT.
      const editCall = fetchMock.mock.calls[1];
      expect(editCall[0]).toContain('/v3/conversations/conv-1/activities/msg-to-edit');
      expect(editCall[1].method).toBe('PUT');

      const body = JSON.parse(editCall[1].body);
      expect(body.id).toBe('msg-to-edit');
      expect(body.text).toBe('Updated text');
    });

    it('should return error when no serviceUrl for conversation', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const result = await channel.editMessage(
        { channelId: 'unknown-conv', userId: 'user-1' },
        'msg-id',
        { text: 'Updated' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('No service URL');
    });
  });

  // ---- onMessage ----

  describe('onMessage', () => {
    it('should set the message handler', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingActivity(createMessageActivity() as any);

      expect(received).toHaveLength(1);
    });

    it('should replace previous handler', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const first: InboundMessage[] = [];
      const second: InboundMessage[] = [];

      channel.onMessage((msg) => first.push(msg));
      channel.onMessage((msg) => second.push(msg));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.handleIncomingActivity(createMessageActivity() as any);

      expect(first).toHaveLength(0);
      expect(second).toHaveLength(1);
    });
  });
});
