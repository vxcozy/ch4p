/**
 * IrcChannel unit tests.
 *
 * Validates IRC protocol handling, auto-reconnect, message splitting,
 * access control, and lifecycle methods.
 * Uses mock sockets — no real TCP connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IrcChannel } from './irc.js';
import type { IrcConfig } from './irc.js';
import type { InboundMessage } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Mock socket
// ---------------------------------------------------------------------------

function createMockSocket() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const socket = {
    destroyed: false,
    setEncoding: vi.fn(),
    write: vi.fn(),
    destroy: vi.fn(() => { socket.destroyed = true; }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    // Test helper to emit events.
    _emit(event: string, ...args: unknown[]) {
      const handlers = listeners.get(event) ?? [];
      for (const h of handlers) h(...args);
    },
  };

  return socket;
}

// ---------------------------------------------------------------------------
// Mock net/tls modules
// ---------------------------------------------------------------------------

let mockSocket: ReturnType<typeof createMockSocket>;

vi.mock('node:tls', () => ({
  connect: vi.fn((_opts: unknown, callback: () => void) => {
    mockSocket = createMockSocket();
    // Schedule callback after mock setup.
    queueMicrotask(callback);
    return mockSocket;
  }),
}));

vi.mock('node:net', () => ({
  connect: vi.fn((_opts: unknown, callback: () => void) => {
    mockSocket = createMockSocket();
    queueMicrotask(callback);
    return mockSocket;
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig: IrcConfig = {
  server: 'irc.test.example',
  port: 6697,
  ssl: true,
  nick: 'testbot',
  channels: ['#general'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IrcChannel', () => {
  let channel: IrcChannel;

  beforeEach(() => {
    channel = new IrcChannel();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    try {
      await channel.stop();
    } catch {
      // ignore
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---- Lifecycle ----

  describe('lifecycle', () => {
    it('should have correct id and name', () => {
      expect(channel.id).toBe('irc');
      expect(channel.name).toBe('IRC');
    });

    it('should require server in config', async () => {
      await expect(
        channel.start({} as IrcConfig),
      ).rejects.toThrow('server');
    });

    it('should start and send registration commands', async () => {
      await channel.start(baseConfig);

      // Should have sent NICK and USER commands.
      const writeArgs = mockSocket.write.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writeArgs.some((w: string) => w.includes('NICK testbot'))).toBe(true);
      expect(writeArgs.some((w: string) => w.includes('USER testbot'))).toBe(true);
    });

    it('should send PASS when password is configured', async () => {
      await channel.start({ ...baseConfig, password: 'server-pass' });

      const writeArgs = mockSocket.write.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writeArgs.some((w: string) => w.includes('PASS server-pass'))).toBe(true);
    });

    it('should stop and send QUIT', async () => {
      await channel.start(baseConfig);
      await channel.stop();

      const writeArgs = mockSocket.write.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writeArgs.some((w: string) => w.includes('QUIT'))).toBe(true);
      expect(mockSocket.destroy).toHaveBeenCalled();
    });
  });

  // ---- IRC Protocol ----

  describe('protocol handling', () => {
    it('should respond to PING with PONG', async () => {
      await channel.start(baseConfig);

      mockSocket._emit('data', 'PING :irc.test.example\r\n');

      const writeArgs = mockSocket.write.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writeArgs.some((w: string) => w.includes('PONG :irc.test.example'))).toBe(true);
    });

    it('should join channels after RPL_WELCOME (001)', async () => {
      await channel.start(baseConfig);

      // Simulate receiving 001 (registration complete).
      mockSocket._emit('data', ':irc.test.example 001 testbot :Welcome\r\n');

      const writeArgs = mockSocket.write.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writeArgs.some((w: string) => w.includes('JOIN #general'))).toBe(true);
    });

    it('should process PRIVMSG and deliver to handler', async () => {
      await channel.start(baseConfig);

      // Register the channel.
      mockSocket._emit('data', ':irc.test.example 001 testbot :Welcome\r\n');

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // Simulate a PRIVMSG.
      mockSocket._emit('data', ':nick!user@host PRIVMSG #general :Hello everyone!\r\n');

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe('Hello everyone!');
      expect(received[0]!.from.userId).toBe('nick');
      expect(received[0]!.from.groupId).toBe('#general');
    });

    it('should handle DM (private message)', async () => {
      await channel.start(baseConfig);
      mockSocket._emit('data', ':irc.test.example 001 testbot :Welcome\r\n');

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // DM: target is the bot's nick.
      mockSocket._emit('data', ':sender!user@host PRIVMSG testbot :Private message\r\n');

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe('Private message');
      expect(received[0]!.from.userId).toBe('sender');
      expect(received[0]!.from.groupId).toBeUndefined();
    });

    it('should handle data arriving in chunks', async () => {
      await channel.start(baseConfig);
      mockSocket._emit('data', ':irc.test.example 001 testbot :Welcome\r\n');

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // Data arrives in two chunks.
      mockSocket._emit('data', ':nick!user@host PRIVMSG #gen');
      mockSocket._emit('data', 'eral :Chunked message\r\n');

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe('Chunked message');
    });

    it('should handle multiple lines in one data event', async () => {
      await channel.start(baseConfig);
      mockSocket._emit('data', ':irc.test.example 001 testbot :Welcome\r\n');

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      mockSocket._emit('data',
        ':nick!user@host PRIVMSG #general :First\r\n' +
        ':nick!user@host PRIVMSG #general :Second\r\n',
      );

      expect(received).toHaveLength(2);
      expect(received[0]!.text).toBe('First');
      expect(received[1]!.text).toBe('Second');
    });
  });

  // ---- Access control ----

  describe('access control', () => {
    it('should filter by allowedUsers', async () => {
      await channel.start({ ...baseConfig, allowedUsers: ['allowed-nick'] });
      mockSocket._emit('data', ':irc.test.example 001 testbot :Welcome\r\n');

      const received: InboundMessage[] = [];
      channel.onMessage((msg) => received.push(msg));

      // Not in allowed list.
      mockSocket._emit('data', ':blocked!user@host PRIVMSG #general :Hello\r\n');
      expect(received).toHaveLength(0);

      // In allowed list.
      mockSocket._emit('data', ':allowed-nick!user@host PRIVMSG #general :Hello\r\n');
      expect(received).toHaveLength(1);
    });
  });

  // ---- Send ----

  describe('send', () => {
    it('should return error when not connected', async () => {
      const result = await channel.send(
        { channelId: '#general' },
        { text: 'Hello' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('not connected');
    });

    it('should send PRIVMSG to target', async () => {
      await channel.start(baseConfig);
      mockSocket._emit('data', ':irc.test.example 001 testbot :Welcome\r\n');

      const result = await channel.send(
        { channelId: '#general', groupId: '#general' },
        { text: 'Hello channel!' },
      );

      expect(result.success).toBe(true);
      const writeArgs = mockSocket.write.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writeArgs.some((w: string) => w.includes('PRIVMSG #general :Hello channel!'))).toBe(true);
    });

    it('should split long messages', async () => {
      await channel.start(baseConfig);
      mockSocket._emit('data', ':irc.test.example 001 testbot :Welcome\r\n');

      // Create a message longer than 400 chars.
      const longText = 'A'.repeat(800);
      await channel.send(
        { channelId: '#general' },
        { text: longText },
      );

      // Should have sent at least 2 PRIVMSG lines.
      const privmsgCalls = mockSocket.write.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .filter((w: string) => w.includes('PRIVMSG'));
      expect(privmsgCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('should return error when no target specified', async () => {
      await channel.start(baseConfig);
      mockSocket._emit('data', ':irc.test.example 001 testbot :Welcome\r\n');

      const result = await channel.send(
        { channelId: '' },
        { text: 'Hello' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No target');
    });
  });

  // ---- Health check ----

  describe('isHealthy', () => {
    it('should return false when not started', async () => {
      expect(await channel.isHealthy()).toBe(false);
    });

    it('should return true when registered', async () => {
      await channel.start(baseConfig);
      mockSocket._emit('data', ':irc.test.example 001 testbot :Welcome\r\n');

      expect(await channel.isHealthy()).toBe(true);
    });

    it('should return false before registration', async () => {
      await channel.start(baseConfig);
      // Not yet registered (no 001 received).
      expect(await channel.isHealthy()).toBe(false);
    });
  });

  // ---- Auto-reconnect ----

  describe('auto-reconnect', () => {
    it('should schedule reconnect on disconnect', async () => {
      await channel.start(baseConfig);
      mockSocket._emit('data', ':irc.test.example 001 testbot :Welcome\r\n');

      // Simulate disconnect.
      mockSocket._emit('close');

      expect(await channel.isHealthy()).toBe(false);
    });

    it('should not reconnect after stop', async () => {
      await channel.start(baseConfig);
      await channel.stop();

      // Simulate disconnect after stop.
      if (mockSocket) {
        mockSocket._emit('close');
      }

      // No reconnect timer should fire.
      vi.advanceTimersByTime(10_000);
    });
  });

  // ---- onMessage ----

  describe('onMessage', () => {
    it('should replace previous handler', async () => {
      await channel.start(baseConfig);
      mockSocket._emit('data', ':irc.test.example 001 testbot :Welcome\r\n');

      const first: InboundMessage[] = [];
      const second: InboundMessage[] = [];

      channel.onMessage((msg) => first.push(msg));
      channel.onMessage((msg) => second.push(msg));

      mockSocket._emit('data', ':nick!user@host PRIVMSG #general :Test\r\n');

      expect(first).toHaveLength(0);
      expect(second).toHaveLength(1);
    });
  });
});
