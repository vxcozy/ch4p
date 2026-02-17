/**
 * WebChatChannel unit tests.
 *
 * Validates WebSocket-based message routing, multi-client support,
 * edit messages, and lifecycle methods.
 * Uses mock WebSocket objects — no real WS server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebChatChannel } from './webchat.js';
import type { InboundMessage } from '@ch4p/core';
import type { WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

function createMockWs(readyState = 1 /* OPEN */): WebSocket {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const ws = {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    // Helper to emit events in tests.
    _emit(event: string, ...args: unknown[]) {
      const handlers = listeners.get(event) ?? [];
      for (const h of handlers) h(...args);
    },
  };

  return ws as unknown as WebSocket;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebChatChannel', () => {
  let channel: WebChatChannel;

  beforeEach(() => {
    channel = new WebChatChannel();
  });

  afterEach(async () => {
    try {
      await channel.stop();
    } catch {
      // ignore
    }
  });

  // ---- Lifecycle ----

  describe('lifecycle', () => {
    it('should have correct id and name', () => {
      expect(channel.id).toBe('webchat');
      expect(channel.name).toBe('WebChat');
    });

    it('should start successfully', async () => {
      await channel.start({});
      expect(await channel.isHealthy()).toBe(true);
    });

    it('should stop and close all connections', async () => {
      await channel.start({});

      const ws = createMockWs();
      channel.handleConnection(ws);

      // Send a message to register the client.
      const mockWs = ws as unknown as { _emit: (e: string, ...a: unknown[]) => void };
      mockWs._emit('message', JSON.stringify({ type: 'message', text: 'hi', userId: 'u1' }));

      await channel.stop();

      expect(ws.close).toHaveBeenCalled();
      expect(await channel.isHealthy()).toBe(false);
    });
  });

  // ---- Health check ----

  describe('isHealthy', () => {
    it('should return false when not started', async () => {
      expect(await channel.isHealthy()).toBe(false);
    });

    it('should return true when started', async () => {
      await channel.start({});
      expect(await channel.isHealthy()).toBe(true);
    });
  });

  // ---- handleConnection ----

  describe('handleConnection', () => {
    it('should close WS if channel is not started', () => {
      const ws = createMockWs();
      channel.handleConnection(ws);
      expect(ws.close).toHaveBeenCalledWith(1013, 'Channel not started');
    });

    it('should process incoming messages', async () => {
      await channel.start({});

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      const ws = createMockWs();
      channel.handleConnection(ws);

      const mockWs = ws as unknown as { _emit: (e: string, ...a: unknown[]) => void };
      mockWs._emit('message', JSON.stringify({ type: 'message', text: 'Hello!', userId: 'user-1' }));

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe('Hello!');
      expect(received[0]!.from.userId).toBe('user-1');
    });

    it('should generate anonymous userId when none provided', async () => {
      await channel.start({});

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      const ws = createMockWs();
      channel.handleConnection(ws);

      const mockWs = ws as unknown as { _emit: (e: string, ...a: unknown[]) => void };
      mockWs._emit('message', JSON.stringify({ type: 'message', text: 'Hi' }));

      expect(received).toHaveLength(1);
      expect(received[0]!.from.userId).toMatch(/^anon-\d+$/);
    });

    it('should skip messages with no text', async () => {
      await channel.start({});

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      const ws = createMockWs();
      channel.handleConnection(ws);

      const mockWs = ws as unknown as { _emit: (e: string, ...a: unknown[]) => void };
      mockWs._emit('message', JSON.stringify({ type: 'message', userId: 'u1' }));

      expect(received).toHaveLength(0);
    });

    it('should handle invalid JSON gracefully', async () => {
      await channel.start({});

      const ws = createMockWs();
      channel.handleConnection(ws);

      const mockWs = ws as unknown as { _emit: (e: string, ...a: unknown[]) => void };
      mockWs._emit('message', 'not-json');

      // Should send error message.
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('Invalid message format'),
      );
    });

    it('should remove client on close', async () => {
      await channel.start({});

      const ws = createMockWs();
      channel.handleConnection(ws);

      const mockWs = ws as unknown as { _emit: (e: string, ...a: unknown[]) => void };
      // Register client.
      mockWs._emit('message', JSON.stringify({ type: 'message', text: 'hi', userId: 'u1' }));

      // Close the connection.
      mockWs._emit('close');

      // Sending should fail — no connections.
      const result = await channel.send(
        { channelId: 'webchat', userId: 'u1' },
        { text: 'Reply' },
      );
      expect(result.success).toBe(false);
    });

    it('should require auth when requireAuth is set', async () => {
      await channel.start({ requireAuth: true });

      const ws = createMockWs();
      channel.handleConnection(ws);

      const mockWs = ws as unknown as { _emit: (e: string, ...a: unknown[]) => void };
      // Try to send without userId when auth required.
      mockWs._emit('message', JSON.stringify({ type: 'message', text: 'hi' }));

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('Authentication required'),
      );
    });
  });

  // ---- handleAuthenticatedConnection ----

  describe('handleAuthenticatedConnection', () => {
    it('should close WS if channel is not started', () => {
      const ws = createMockWs();
      channel.handleAuthenticatedConnection(ws, 'user-1');
      expect(ws.close).toHaveBeenCalledWith(1013, 'Channel not started');
    });

    it('should process messages with authenticated userId', async () => {
      await channel.start({});

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      const ws = createMockWs();
      channel.handleAuthenticatedConnection(ws, 'auth-user-1');

      const mockWs = ws as unknown as { _emit: (e: string, ...a: unknown[]) => void };
      mockWs._emit('message', JSON.stringify({ type: 'message', text: 'Hello!' }));

      expect(received).toHaveLength(1);
      expect(received[0]!.from.userId).toBe('auth-user-1');
    });
  });

  // ---- Send ----

  describe('send', () => {
    it('should return error when not started', async () => {
      const result = await channel.send(
        { channelId: 'webchat', userId: 'u1' },
        { text: 'Hello' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('not started');
    });

    it('should send message to connected client', async () => {
      await channel.start({});

      const ws = createMockWs();
      channel.handleConnection(ws);

      const mockWs = ws as unknown as { _emit: (e: string, ...a: unknown[]) => void };
      mockWs._emit('message', JSON.stringify({ type: 'message', text: 'hi', userId: 'u1' }));

      const result = await channel.send(
        { channelId: 'webchat', userId: 'u1' },
        { text: 'Reply!' },
      );

      expect(result.success).toBe(true);
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"message"'),
      );
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('Reply!'),
      );
    });

    it('should return error when no connection for user', async () => {
      await channel.start({});

      const result = await channel.send(
        { channelId: 'webchat', userId: 'unknown' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No WebSocket connection');
    });

    it('should send to multiple browser tabs', async () => {
      await channel.start({});

      const ws1 = createMockWs();
      const ws2 = createMockWs();

      channel.handleAuthenticatedConnection(ws1, 'u1');
      channel.handleAuthenticatedConnection(ws2, 'u1');

      await channel.send(
        { channelId: 'webchat', userId: 'u1' },
        { text: 'Broadcast!' },
      );

      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).toHaveBeenCalled();
    });
  });

  // ---- Edit message ----

  describe('editMessage', () => {
    it('should return error when not started', async () => {
      const result = await channel.editMessage(
        { channelId: 'webchat', userId: 'u1' },
        'msg-1',
        { text: 'Updated' },
      );
      expect(result.success).toBe(false);
    });

    it('should send edit payload to connected client', async () => {
      await channel.start({});

      const ws = createMockWs();
      channel.handleAuthenticatedConnection(ws, 'u1');

      const result = await channel.editMessage(
        { channelId: 'webchat', userId: 'u1' },
        'msg-1',
        { text: 'Updated text' },
      );

      expect(result.success).toBe(true);
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"edit"'),
      );
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"messageId":"msg-1"'),
      );
    });
  });

  // ---- onMessage ----

  describe('onMessage', () => {
    it('should replace previous handler', async () => {
      await channel.start({});

      const first: InboundMessage[] = [];
      const second: InboundMessage[] = [];

      channel.onMessage((msg) => first.push(msg));
      channel.onMessage((msg) => second.push(msg));

      const ws = createMockWs();
      channel.handleConnection(ws);

      const mockWs = ws as unknown as { _emit: (e: string, ...a: unknown[]) => void };
      mockWs._emit('message', JSON.stringify({ type: 'message', text: 'hi', userId: 'u1' }));

      expect(first).toHaveLength(0);
      expect(second).toHaveLength(1);
    });
  });
});
