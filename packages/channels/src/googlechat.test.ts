/**
 * GoogleChatChannel unit tests.
 *
 * Validates Google Chat API integration, JWT token management,
 * inbound event processing, message editing, and lifecycle methods.
 * All fetch calls and crypto operations are mocked — no real network traffic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleChatChannel } from './googlechat.js';
import type { GoogleChatConfig, GoogleChatEvent } from './googlechat.js';
import type { InboundMessage } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid service account key JSON. */
const testServiceAccountKey = JSON.stringify({
  client_email: 'bot@test-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALRiMLAH+FAKE+KEY+FOR+TESTING+ONLY/abc123\n-----END RSA PRIVATE KEY-----',
  token_uri: 'https://oauth2.googleapis.com/token',
});

const baseConfig: GoogleChatConfig = {
  serviceAccountKey: testServiceAccountKey,
};

function tokenResponse(expiresIn = 3600) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'gc-mock-token', expires_in: expiresIn }),
    text: async () => '',
  };
}

function messageResponse(name = 'spaces/AAAA/messages/BBBB') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ name, text: 'response text' }),
    text: async () => '',
  };
}

function createChatEvent(overrides: Partial<GoogleChatEvent> = {}): GoogleChatEvent {
  return {
    type: 'MESSAGE',
    eventTime: '2025-01-15T10:30:00Z',
    message: {
      name: 'spaces/AAAA/messages/msg-001',
      sender: {
        name: 'users/123',
        displayName: 'Test User',
        email: 'test@example.com',
        type: 'HUMAN',
      },
      createTime: '2025-01-15T10:30:00Z',
      text: 'Hello bot!',
      argumentText: 'Hello bot!',
      thread: { name: 'spaces/AAAA/threads/thread-1' },
      space: { name: 'spaces/AAAA', type: 'ROOM' },
    },
    space: { name: 'spaces/AAAA', type: 'ROOM' },
    user: { name: 'users/123', displayName: 'Test User', email: 'test@example.com' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoogleChatChannel', () => {
  let channel: GoogleChatChannel;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    channel = new GoogleChatChannel();
    fetchMock = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;

    // Mock createSign to avoid needing a real RSA key.
    vi.mock('node:crypto', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:crypto')>();
      return {
        ...actual,
        createSign: () => ({
          update: vi.fn(),
          sign: () => 'bW9jay1zaWduYXR1cmU', // base64 of 'mock-signature'
        }),
      };
    });
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
      expect(channel.id).toBe('googlechat');
      expect(channel.name).toBe('Google Chat');
    });

    it('should require serviceAccountKey in config', async () => {
      await expect(
        channel.start({} as GoogleChatConfig),
      ).rejects.toThrow('serviceAccountKey');
    });

    it('should require valid JSON in serviceAccountKey', async () => {
      await expect(
        channel.start({ serviceAccountKey: 'not-json' } as GoogleChatConfig),
      ).rejects.toThrow('valid JSON');
    });

    it('should require client_email and private_key', async () => {
      await expect(
        channel.start({ serviceAccountKey: '{}' } as GoogleChatConfig),
      ).rejects.toThrow('client_email');
    });

    it('should start successfully with valid config', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      // Token was fetched during start.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should stop and clear state', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);
      await channel.stop();

      expect(await channel.isHealthy()).toBe(false);
    });
  });

  // ---- Token management ----

  describe('token management', () => {
    it('should acquire token via JWT assertion on start', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/token',
        expect.objectContaining({ method: 'POST' }),
      );

      const callArgs = fetchMock.mock.calls[0];
      const body = callArgs[1].body;
      expect(body).toContain('grant_type=urn');
      expect(body).toContain('jwt-bearer');
      expect(body).toContain('assertion=');
    });

    it('should reuse cached token within expiry window', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse(3600));
      await channel.start(baseConfig);

      // isHealthy should NOT fetch a new token.
      expect(await channel.isHealthy()).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should fail start if token request fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Invalid key',
      });

      await expect(channel.start(baseConfig)).rejects.toThrow('token request failed');
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

  // ---- Inbound event handling ----

  describe('handleIncomingEvent', () => {
    it('should process MESSAGE events', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createChatEvent());

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe('Hello bot!');
      expect(received[0]!.from.userId).toBe('users/123');
      expect(received[0]!.channelId).toBe('spaces/AAAA');
    });

    it('should skip non-MESSAGE events', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createChatEvent({ type: 'ADDED_TO_SPACE' }));

      expect(received).toHaveLength(0);
    });

    it('should skip bot messages', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      const event = createChatEvent();
      event.message!.sender!.type = 'BOT';
      channel.handleIncomingEvent(event);

      expect(received).toHaveLength(0);
    });

    it('should filter by allowedUsers (email)', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start({ ...baseConfig, allowedUsers: ['allowed@example.com'] });

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // Not in allowed list.
      channel.handleIncomingEvent(createChatEvent());
      expect(received).toHaveLength(0);

      // In allowed list.
      const event = createChatEvent();
      event.message!.sender!.email = 'allowed@example.com';
      channel.handleIncomingEvent(event);
      expect(received).toHaveLength(1);
    });

    it('should filter by allowedSpaces', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start({ ...baseConfig, allowedSpaces: ['spaces/BBBB'] });

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // Not in allowed spaces.
      channel.handleIncomingEvent(createChatEvent());
      expect(received).toHaveLength(0);

      // In allowed spaces.
      const event = createChatEvent();
      event.message!.space!.name = 'spaces/BBBB';
      channel.handleIncomingEvent(event);
      expect(received).toHaveLength(1);
    });

    it('should verify token when verificationToken is configured', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start({ ...baseConfig, verificationToken: 'secret-verify' });

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // Wrong token — should be filtered.
      channel.handleIncomingEvent({ ...createChatEvent(), token: 'wrong-token' });
      expect(received).toHaveLength(0);

      // Correct token — should pass.
      channel.handleIncomingEvent({ ...createChatEvent(), token: 'secret-verify' });
      expect(received).toHaveLength(1);
    });

    it('should set groupId for ROOM spaces', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createChatEvent());

      expect(received[0]!.from.groupId).toBe('spaces/AAAA');
    });

    it('should include threadId', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createChatEvent());

      expect(received[0]!.from.threadId).toBe('spaces/AAAA/threads/thread-1');
    });

    it('should not process when channel is not started', () => {
      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      channel.handleIncomingEvent(createChatEvent());

      expect(received).toHaveLength(0);
    });
  });

  // ---- Send ----

  describe('send', () => {
    it('should return error when not started', async () => {
      const result = await channel.send(
        { channelId: 'spaces/AAAA', userId: 'user-1' },
        { text: 'Hello' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('not started');
    });

    it('should send message via Google Chat API', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce(messageResponse());

      const result = await channel.send(
        { channelId: 'spaces/AAAA', userId: 'user-1' },
        { text: 'Hello from ch4p!' },
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('spaces/AAAA/messages/BBBB');

      const sendCall = fetchMock.mock.calls[1];
      expect(sendCall[0]).toBe('https://chat.googleapis.com/v1/spaces/AAAA/messages');
      expect(sendCall[1].method).toBe('POST');
      expect(sendCall[1].headers['Authorization']).toBe('Bearer gc-mock-token');

      const body = JSON.parse(sendCall[1].body);
      expect(body.text).toBe('Hello from ch4p!');
    });

    it('should include thread name when threadId is set', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce(messageResponse());

      await channel.send(
        { channelId: 'spaces/AAAA', threadId: 'spaces/AAAA/threads/T1' },
        { text: 'Threaded reply' },
      );

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.thread.name).toBe('spaces/AAAA/threads/T1');
    });

    it('should handle API errors gracefully', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      const result = await channel.send(
        { channelId: 'spaces/AAAA' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('403');
    });

    it('should return error when no space specified', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const result = await channel.send(
        { channelId: '' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No space');
    });
  });

  // ---- Edit message ----

  describe('editMessage', () => {
    it('should return error when not started', async () => {
      const result = await channel.editMessage(
        { channelId: 'spaces/AAAA' },
        'spaces/AAAA/messages/BBBB',
        { text: 'Updated' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('not started');
    });

    it('should edit message via PUT endpoint', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      fetchMock.mockResolvedValueOnce(messageResponse());

      const result = await channel.editMessage(
        { channelId: 'spaces/AAAA' },
        'spaces/AAAA/messages/BBBB',
        { text: 'Updated text' },
      );

      expect(result.success).toBe(true);

      const editCall = fetchMock.mock.calls[1];
      expect(editCall[0]).toContain('spaces/AAAA/messages/BBBB');
      expect(editCall[0]).toContain('updateMask=text');
      expect(editCall[1].method).toBe('PUT');

      const body = JSON.parse(editCall[1].body);
      expect(body.text).toBe('Updated text');
    });
  });

  // ---- onMessage ----

  describe('onMessage', () => {
    it('should replace previous handler', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await channel.start(baseConfig);

      const first: InboundMessage[] = [];
      const second: InboundMessage[] = [];

      channel.onMessage((msg) => first.push(msg));
      channel.onMessage((msg) => second.push(msg));

      channel.handleIncomingEvent(createChatEvent());

      expect(first).toHaveLength(0);
      expect(second).toHaveLength(1);
    });
  });
});
