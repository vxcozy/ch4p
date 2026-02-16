/**
 * Channel adapter tests.
 *
 * Tests for CliChannel, TelegramChannel, DiscordChannel, SlackChannel,
 * and ChannelRegistry. Network-dependent channels are tested via mock
 * fetch() to avoid requiring real API tokens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CliChannel } from './cli.js';
import { TelegramChannel } from './telegram.js';
import { DiscordChannel, DiscordIntents } from './discord.js';
import { SlackChannel } from './slack.js';
import { MatrixChannel } from './matrix.js';
import { WhatsAppChannel } from './whatsapp.js';
import { SignalChannel } from './signal.js';
import { IMessageChannel } from './imessage.js';
import { ChannelRegistry } from './index.js';
import type {
  IChannel,
  InboundMessage,
  OutboundMessage,
  Recipient,
  PresenceEvent,
} from '@ch4p/core';

// ---------------------------------------------------------------------------
// Module mocks (hoisted by vitest)
// ---------------------------------------------------------------------------

/**
 * vi.hoisted values are available inside vi.mock factory functions and in tests.
 * This is the vitest-approved pattern for sharing state between mock factories
 * and test code in ESM.
 */
const {
  matrixMockClient,
  matrixAutoJoinSetup,
  mockExecFileCb,
} = vi.hoisted(() => {
  const matrixMockClient = {
    getUserId: vi.fn(async () => '@bot:matrix.org'),
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    sendMessage: vi.fn(async () => '$event_1'),
    on: vi.fn(),
  };
  const matrixAutoJoinSetup = vi.fn();
  const mockExecFileCb = vi.fn(
    (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, '[]', '');
    },
  );
  // Attach the Node.js custom promisify symbol so that `promisify(mockExecFileCb)`
  // returns `{ stdout, stderr }` just like the real `child_process.execFile`.
  // Without this, promisify's generic fallback resolves with only the first
  // callback arg (a plain string), which breaks `const { stdout } = await ...`.
  const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');
  (mockExecFileCb as any)[PROMISIFY_CUSTOM] = (...args: unknown[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mockExecFileCb(
        ...(args as [string, string[]]),
        (err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        },
      );
    });
  return { matrixMockClient, matrixAutoJoinSetup, mockExecFileCb };
});

/** Mock matrix-bot-sdk so MatrixChannel can be tested without a real homeserver. */
vi.mock('matrix-bot-sdk', () => ({
  MatrixClient: vi.fn(() => matrixMockClient),
  AutojoinRoomsMixin: { setupOnClient: matrixAutoJoinSetup },
}));

/** Mock node:net Socket for SignalChannel. */
vi.mock('node:net', () => {
  class MockSocket {
    destroyed = false;
    private _handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

    on(event: string, fn: (...args: unknown[]) => void) {
      if (!this._handlers[event]) this._handlers[event] = [];
      this._handlers[event]!.push(fn);
      return this;
    }

    connect(_port: number, _host: string) {
      // Fire 'connect' on the next microtask so the promise handler is registered.
      queueMicrotask(() => this._emit('connect'));
    }

    write(data: string, _enc?: string, cb?: (err?: Error) => void) {
      // Parse the JSON-RPC request and auto-respond so rpcCall resolves.
      try {
        const req = JSON.parse(data.trim());
        if (req.id !== undefined) {
          queueMicrotask(() => {
            const response = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\n';
            this._emit('data', Buffer.from(response));
          });
        }
      } catch {
        // Ignore parse errors on non-JSON writes.
      }
      if (cb) cb();
      return true;
    }

    destroy() {
      this.destroyed = true;
      this._emit('close');
    }

    _emit(event: string, ...args: unknown[]) {
      for (const fn of this._handlers[event] ?? []) {
        fn(...args);
      }
    }
  }
  return { Socket: vi.fn(() => new MockSocket()) };
});

/** Mock node:child_process execFile for IMessageChannel. */
vi.mock('node:child_process', () => ({
  execFile: mockExecFileCb,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock fetch that returns configurable responses. */
function createMockFetch(responses: Array<{ ok: boolean; data: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex % responses.length]!;
    callIndex++;
    return {
      ok: resp.ok,
      status: resp.ok ? 200 : 400,
      json: async () => resp.data,
      text: async () => JSON.stringify(resp.data),
    };
  });
}

// ===========================================================================
// CliChannel
// ===========================================================================

describe('CliChannel', () => {
  it('has correct id and name', () => {
    const ch = new CliChannel();
    expect(ch.id).toBe('cli');
    expect(ch.name).toBe('CLI');
  });

  it('is unhealthy before start', async () => {
    const ch = new CliChannel();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('starts and becomes healthy', async () => {
    const ch = new CliChannel();
    await ch.start({});
    expect(await ch.isHealthy()).toBe(true);
    await ch.stop();
  });

  it('stops and becomes unhealthy', async () => {
    const ch = new CliChannel();
    await ch.start({});
    await ch.stop();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('sends text messages to stdout', async () => {
    const ch = new CliChannel();
    await ch.start({});

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const result = await ch.send(
      { channelId: 'cli', userId: 'user1' },
      { text: 'Hello, world!' },
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(writeSpy).toHaveBeenCalledWith('Hello, world!\n');

    writeSpy.mockRestore();
    await ch.stop();
  });

  it('formats markdown output for terminal', async () => {
    const ch = new CliChannel();
    await ch.start({});

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await ch.send(
      { channelId: 'cli' },
      { text: '# Hello\n**bold** text', format: 'markdown' },
    );

    const output = writeSpy.mock.calls[0]![0] as string;
    expect(output).toContain('HELLO');
    expect(output).toContain('bold text');
    expect(output).not.toContain('**');

    writeSpy.mockRestore();
    await ch.stop();
  });

  it('strips HTML output', async () => {
    const ch = new CliChannel();
    await ch.start({});

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await ch.send(
      { channelId: 'cli' },
      { text: '<b>Bold</b> <i>italic</i>', format: 'html' },
    );

    const output = writeSpy.mock.calls[0]![0] as string;
    expect(output).toContain('Bold italic');
    expect(output).not.toContain('<b>');

    writeSpy.mockRestore();
    await ch.stop();
  });

  it('registers message handler', () => {
    const ch = new CliChannel();
    const handler = vi.fn();
    ch.onMessage(handler);
    // Handler registration doesn't throw.
  });

  it('onPresence is a no-op', () => {
    const ch = new CliChannel();
    // Should not throw.
    ch.onPresence(vi.fn());
  });

  it('handles start when already running', async () => {
    const ch = new CliChannel();
    await ch.start({});
    await ch.start({}); // Second start should be a no-op.
    expect(await ch.isHealthy()).toBe(true);
    await ch.stop();
  });

  it('handles send failure gracefully', async () => {
    const ch = new CliChannel();
    await ch.start({});

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('Write failed');
    });

    const result = await ch.send(
      { channelId: 'cli' },
      { text: 'test' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Write failed');

    writeSpy.mockRestore();
    await ch.stop();
  });
});

// ===========================================================================
// TelegramChannel
// ===========================================================================

describe('TelegramChannel', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has correct id and name', () => {
    const ch = new TelegramChannel();
    expect(ch.id).toBe('telegram');
    expect(ch.name).toBe('Telegram');
  });

  it('is unhealthy before start', async () => {
    const ch = new TelegramChannel();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('throws if no token provided', async () => {
    const ch = new TelegramChannel();
    await expect(ch.start({})).rejects.toThrow('requires a "token"');
  });

  it('starts successfully with valid token', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123, username: 'test_bot' } } }, // getMe
      { ok: true, data: { ok: true, result: true } }, // deleteWebhook
      { ok: true, data: { ok: true, result: [] } }, // first getUpdates poll
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    await ch.start({ token: 'test-token-123' });

    expect(await ch.isHealthy()).toBe(true);
    // At least getMe + deleteWebhook should have been called.
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);

    await ch.stop();
  });

  it('throws if getMe fails', async () => {
    globalThis.fetch = createMockFetch([
      { ok: true, data: { ok: false, description: 'Unauthorized' } },
    ]) as unknown as typeof fetch;

    const ch = new TelegramChannel();
    await expect(ch.start({ token: 'bad-token' })).rejects.toThrow('Telegram API error');
  });

  it('sends text messages', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } }, // getMe
      { ok: true, data: { ok: true, result: true } }, // deleteWebhook
      { ok: true, data: { ok: true, result: { message_id: 42 } } }, // sendMessage
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    await ch.start({ token: 'test-token' });

    const result = await ch.send(
      { channelId: 'telegram', userId: '12345' },
      { text: 'Hello Telegram!' },
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('42');

    await ch.stop();
  });

  it('returns error when no userId in recipient', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    await ch.start({ token: 'test-token' });

    const result = await ch.send(
      { channelId: 'telegram' },
      { text: 'No recipient' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('userId or groupId');

    await ch.stop();
  });

  it('processes webhook updates', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ token: 'test-token' });

    ch.handleWebhookUpdate({
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 999, first_name: 'Test', username: 'tester' },
        chat: { id: 999, type: 'private' },
        text: 'Hello from Telegram',
        date: Math.floor(Date.now() / 1000),
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('Hello from Telegram');
    expect(received[0]!.from.userId).toBe('999');
    expect(received[0]!.id).toBe('100');

    await ch.stop();
  });

  it('filters messages by allowedUsers', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ token: 'test-token', allowedUsers: ['111'] });

    // Allowed user.
    ch.handleWebhookUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 111 },
        chat: { id: 111, type: 'private' },
        text: 'Allowed',
        date: Math.floor(Date.now() / 1000),
      },
    });

    // Blocked user.
    ch.handleWebhookUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 222 },
        chat: { id: 222, type: 'private' },
        text: 'Blocked',
        date: Math.floor(Date.now() / 1000),
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('Allowed');

    await ch.stop();
  });

  it('handles photo attachments', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ token: 'test-token' });

    ch.handleWebhookUpdate({
      update_id: 1,
      message: {
        message_id: 50,
        from: { id: 111 },
        chat: { id: 111, type: 'private' },
        text: 'Look at this',
        date: Math.floor(Date.now() / 1000),
        photo: [
          { file_id: 'small_id', file_size: 1000 },
          { file_id: 'large_id', file_size: 5000 },
        ],
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.attachments).toHaveLength(1);
    expect(received[0]!.attachments![0]!.url).toBe('large_id'); // Uses largest.
    expect(received[0]!.attachments![0]!.type).toBe('image');

    await ch.stop();
  });

  it('handles group messages with groupId', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ token: 'test-token' });

    ch.handleWebhookUpdate({
      update_id: 1,
      message: {
        message_id: 60,
        from: { id: 111 },
        chat: { id: -100123, type: 'supergroup' },
        text: 'Group msg',
        date: Math.floor(Date.now() / 1000),
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.from.groupId).toBe('-100123');

    await ch.stop();
  });

  it('stops cleanly', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    await ch.start({ token: 'test-token' });
    await ch.stop();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('requires webhookUrl in webhook mode', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    await expect(ch.start({ token: 'test-token', mode: 'webhook' }))
      .rejects.toThrow('webhookUrl');
  });

  // -----------------------------------------------------------------------
  // Webhook secret verification
  // -----------------------------------------------------------------------

  it('accepts webhook update with correct secret', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ token: 'test-token', webhookSecret: 'my-secret-123' });

    ch.handleWebhookUpdate(
      {
        update_id: 1,
        message: {
          message_id: 200,
          from: { id: 999 },
          chat: { id: 999, type: 'private' },
          text: 'Valid secret',
          date: Math.floor(Date.now() / 1000),
        },
      },
      'my-secret-123', // Correct secret header.
    );

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('Valid secret');

    await ch.stop();
  });

  it('silently rejects webhook update with wrong secret', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ token: 'test-token', webhookSecret: 'my-secret-123' });

    ch.handleWebhookUpdate(
      {
        update_id: 1,
        message: {
          message_id: 201,
          from: { id: 999 },
          chat: { id: 999, type: 'private' },
          text: 'Wrong secret',
          date: Math.floor(Date.now() / 1000),
        },
      },
      'wrong-secret', // Wrong secret header.
    );

    expect(received).toHaveLength(0); // Silently rejected.

    await ch.stop();
  });

  it('silently rejects webhook update with missing secret header', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ token: 'test-token', webhookSecret: 'my-secret-123' });

    ch.handleWebhookUpdate(
      {
        update_id: 1,
        message: {
          message_id: 202,
          from: { id: 999 },
          chat: { id: 999, type: 'private' },
          text: 'No secret header',
          date: Math.floor(Date.now() / 1000),
        },
      },
      // No secret header.
    );

    expect(received).toHaveLength(0);

    await ch.stop();
  });

  it('skips webhook secret verification when no secret configured', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ token: 'test-token' }); // No webhookSecret.

    ch.handleWebhookUpdate(
      {
        update_id: 1,
        message: {
          message_id: 203,
          from: { id: 999 },
          chat: { id: 999, type: 'private' },
          text: 'No secret configured',
          date: Math.floor(Date.now() / 1000),
        },
      },
      // Any or no header is fine.
    );

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('No secret configured');

    await ch.stop();
  });

  // -----------------------------------------------------------------------
  // Numeric sender ID validation
  // -----------------------------------------------------------------------

  it('warns about non-numeric allowedUsers entries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    await ch.start({ token: 'test-token', allowedUsers: ['123456', 'john_doe', '789'] });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('john_doe'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a numeric'));

    warnSpy.mockRestore();
    await ch.stop();
  });

  // -----------------------------------------------------------------------
  // Stream mode
  // -----------------------------------------------------------------------

  it('exposes stream mode configuration', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    await ch.start({ token: 'test-token', streamMode: 'edit' });

    expect(ch.getStreamMode()).toBe('edit');

    await ch.stop();
  });

  it('defaults stream mode to off', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    await ch.start({ token: 'test-token' });

    expect(ch.getStreamMode()).toBe('off');

    await ch.stop();
  });

  // -----------------------------------------------------------------------
  // Telegram editMessage
  // -----------------------------------------------------------------------

  it('editMessage calls editMessageText API', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } }, // getMe
      { ok: true, data: { ok: true, result: true } },         // deleteWebhook
      { ok: true, data: { ok: true, result: { message_id: 42 } } }, // editMessageText
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    await ch.start({ token: 'test-token' });

    const result = await ch.editMessage(
      { channelId: 'telegram', userId: '12345' },
      '42',
      { text: 'Updated text' },
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('42');

    // Verify editMessageText was called.
    const editCall = mockFetch.mock.calls.find(
      (c) => (c[0] as string).includes('editMessageText'),
    );
    expect(editCall).toBeDefined();

    await ch.stop();
  });

  it('editMessage returns error without recipient', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, result: { id: 123 } } },
      { ok: true, data: { ok: true, result: true } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new TelegramChannel();
    await ch.start({ token: 'test-token' });

    const result = await ch.editMessage(
      { channelId: 'telegram' },
      '42',
      { text: 'No recipient' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('userId or groupId');

    await ch.stop();
  });

  // -----------------------------------------------------------------------
  // WEBHOOK_TIMEOUT_MS static getter
  // -----------------------------------------------------------------------

  it('exposes WEBHOOK_TIMEOUT_MS static getter', () => {
    expect(TelegramChannel.WEBHOOK_TIMEOUT_MS).toBe(8_000);
  });
});

// ===========================================================================
// DiscordChannel
// ===========================================================================

describe('DiscordChannel', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has correct id and name', () => {
    const ch = new DiscordChannel();
    expect(ch.id).toBe('discord');
    expect(ch.name).toBe('Discord');
  });

  it('is unhealthy before start', async () => {
    const ch = new DiscordChannel();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('throws if no token provided', async () => {
    const ch = new DiscordChannel();
    await expect(ch.start({})).rejects.toThrow('requires a "token"');
  });

  it('exports intent constants', () => {
    expect(DiscordIntents.GUILDS).toBe(1 << 0);
    expect(DiscordIntents.GUILD_MESSAGES).toBe(1 << 9);
    expect(DiscordIntents.MESSAGE_CONTENT).toBe(1 << 15);
    expect(DiscordIntents.DIRECT_MESSAGES).toBe(1 << 12);
  });

  it('registers message and presence handlers', () => {
    const ch = new DiscordChannel();
    const msgHandler = vi.fn();
    const presHandler = vi.fn();
    ch.onMessage(msgHandler);
    ch.onPresence(presHandler);
    // No throw.
  });

  it('send returns error without proper recipient', async () => {
    const ch = new DiscordChannel();
    // Try to send without a channel ID.
    const result = await ch.send(
      { channelId: 'discord' },
      { text: 'test' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('groupId');
  });

  // -----------------------------------------------------------------------
  // Discord stream mode
  // -----------------------------------------------------------------------

  it('exposes stream mode configuration', () => {
    const ch = new DiscordChannel();
    // Before start, streamMode defaults to 'off'.
    expect(ch.getStreamMode()).toBe('off');
  });

  // -----------------------------------------------------------------------
  // Discord editMessage
  // -----------------------------------------------------------------------

  it('editMessage returns error without recipient', async () => {
    const ch = new DiscordChannel();
    const result = await ch.editMessage(
      { channelId: 'discord' },
      'msg-1',
      { text: 'Edited text' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('groupId');
  });
});

// ===========================================================================
// SlackChannel
// ===========================================================================

describe('SlackChannel', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has correct id and name', () => {
    const ch = new SlackChannel();
    expect(ch.id).toBe('slack');
    expect(ch.name).toBe('Slack');
  });

  it('is unhealthy before start', async () => {
    const ch = new SlackChannel();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('throws if no botToken provided', async () => {
    const ch = new SlackChannel();
    await expect(ch.start({})).rejects.toThrow('requires a "botToken"');
  });

  it('starts in events mode without appToken', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, user_id: 'U123', team_id: 'T456' } }, // auth.test
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new SlackChannel();
    await ch.start({ botToken: 'xoxb-test-token' });

    expect(await ch.isHealthy()).toBe(true);
    await ch.stop();
  });

  it('sends messages via chat.postMessage', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, user_id: 'U123' } }, // auth.test
      { ok: true, data: { ok: true, ts: '1234567890.123456', channel: 'C01' } }, // chat.postMessage
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new SlackChannel();
    await ch.start({ botToken: 'xoxb-test-token' });

    const result = await ch.send(
      { channelId: 'slack', groupId: 'C01' },
      { text: 'Hello Slack!' },
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('1234567890.123456');
    await ch.stop();
  });

  it('sends threaded replies', async () => {
    const mockFetch = vi.fn(async (url: string, opts?: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if ((url as string).includes('auth.test')) {
        return { ok: true, json: async () => ({ ok: true, user_id: 'U123' }) };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ts: '1234567890.999',
          channel: body.channel,
        }),
      };
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new SlackChannel();
    await ch.start({ botToken: 'xoxb-test-token' });

    const result = await ch.send(
      { channelId: 'slack', groupId: 'C01' },
      { text: 'Thread reply', replyTo: '1234567890.123456' },
    );

    expect(result.success).toBe(true);

    // Verify thread_ts was sent.
    const postCall = mockFetch.mock.calls.find(
      (c) => (c[0] as string).includes('chat.postMessage'),
    );
    expect(postCall).toBeDefined();
    const sentBody = JSON.parse(postCall![1]!.body as string);
    expect(sentBody.thread_ts).toBe('1234567890.123456');

    await ch.stop();
  });

  it('returns error without proper recipient', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, user_id: 'U123' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new SlackChannel();
    await ch.start({ botToken: 'xoxb-test-token' });

    const result = await ch.send(
      { channelId: 'slack' },
      { text: 'No target' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('groupId');
    await ch.stop();
  });

  it('handles Events API url_verification', () => {
    const ch = new SlackChannel();
    const response = ch.handleEventsPayload({
      type: 'url_verification',
      challenge: 'test-challenge-123',
    });

    expect(response.status).toBe(200);
    expect(response.body.challenge).toBe('test-challenge-123');
  });

  it('handles Events API message callback', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, user_id: 'U_BOT' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new SlackChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ botToken: 'xoxb-test-token' });

    const response = ch.handleEventsPayload({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C01',
        user: 'U_USER1',
        text: 'Hello from Slack!',
        ts: '1234567890.123456',
      },
    });

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('Hello from Slack!');
    expect(received[0]!.from.userId).toBe('U_USER1');
    expect(received[0]!.from.groupId).toBe('C01');

    await ch.stop();
  });

  it('ignores bot messages', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, user_id: 'U_BOT' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new SlackChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ botToken: 'xoxb-test-token' });

    ch.handleEventsPayload({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C01',
        user: 'U_BOT', // Same as bot user.
        text: 'My own message',
        ts: '1234567890.100',
      },
    });

    ch.handleEventsPayload({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C01',
        bot_id: 'B_OTHER',
        text: 'Another bot message',
        ts: '1234567890.200',
      },
    });

    expect(received).toHaveLength(0);
    await ch.stop();
  });

  it('filters by allowedChannels', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, user_id: 'U_BOT' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new SlackChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ botToken: 'xoxb-test-token', allowedChannels: ['C_ALLOWED'] });

    ch.handleEventsPayload({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C_ALLOWED',
        user: 'U1',
        text: 'Allowed channel',
        ts: '1.1',
      },
    });

    ch.handleEventsPayload({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C_BLOCKED',
        user: 'U1',
        text: 'Blocked channel',
        ts: '1.2',
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('Allowed channel');
    await ch.stop();
  });

  it('filters by allowedUsers', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, user_id: 'U_BOT' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new SlackChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ botToken: 'xoxb-test-token', allowedUsers: ['U_GOOD'] });

    ch.handleEventsPayload({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C01',
        user: 'U_GOOD',
        text: 'Allowed user',
        ts: '1.1',
      },
    });

    ch.handleEventsPayload({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C01',
        user: 'U_BAD',
        text: 'Blocked user',
        ts: '1.2',
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('Allowed user');
    await ch.stop();
  });

  it('handles file attachments in messages', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, user_id: 'U_BOT' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new SlackChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ botToken: 'xoxb-test-token' });

    ch.handleEventsPayload({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C01',
        user: 'U1',
        text: 'Here is a file',
        ts: '1.1',
        files: [
          {
            id: 'F01',
            name: 'report.pdf',
            mimetype: 'application/pdf',
            url_private: 'https://files.slack.com/files-pri/F01/report.pdf',
            size: 1024,
          },
          {
            id: 'F02',
            name: 'photo.png',
            mimetype: 'image/png',
            url_private: 'https://files.slack.com/files-pri/F02/photo.png',
            size: 2048,
          },
        ],
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.attachments).toHaveLength(2);
    expect(received[0]!.attachments![0]!.type).toBe('file');
    expect(received[0]!.attachments![0]!.filename).toBe('report.pdf');
    expect(received[0]!.attachments![1]!.type).toBe('image');
    expect(received[0]!.attachments![1]!.filename).toBe('photo.png');

    await ch.stop();
  });

  it('verifies Slack request signatures', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, user_id: 'U_BOT' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new SlackChannel();
    await ch.start({ botToken: 'xoxb-test-token', signingSecret: 'test-secret' });

    // With signing secret configured, an invalid signature should fail.
    const valid = await ch.verifySignature('body', '12345', 'v0=invalid');
    expect(valid).toBe(false);

    // Without signing secret, verification is skipped.
    const ch2 = new SlackChannel();
    await ch2.start({ botToken: 'xoxb-test-token' });
    const skipped = await ch2.verifySignature('body', '12345', 'anything');
    expect(skipped).toBe(true);

    await ch.stop();
    await ch2.stop();
  });

  it('requires appToken for socket mode', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, user_id: 'U_BOT' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new SlackChannel();
    await expect(ch.start({ botToken: 'xoxb-test', mode: 'socket' }))
      .rejects.toThrow('appToken');
  });

  it('handles message subtypes by ignoring them', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { ok: true, user_id: 'U_BOT' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new SlackChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ botToken: 'xoxb-test-token' });

    // Messages with subtypes (channel_join, etc.) should be ignored.
    ch.handleEventsPayload({
      type: 'event_callback',
      event: {
        type: 'message',
        subtype: 'channel_join',
        channel: 'C01',
        user: 'U1',
        text: 'joined the channel',
        ts: '1.1',
      },
    });

    expect(received).toHaveLength(0);
    await ch.stop();
  });
});

// ===========================================================================
// ChannelRegistry
// ===========================================================================

describe('ChannelRegistry', () => {
  it('registers and retrieves channels', () => {
    const reg = new ChannelRegistry();
    const ch = new CliChannel();
    reg.register(ch);

    expect(reg.has('cli')).toBe(true);
    expect(reg.get('cli')).toBe(ch);
  });

  it('lists all registered channels', () => {
    const reg = new ChannelRegistry();
    reg.register(new CliChannel());

    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('cli');
  });

  it('returns undefined for unregistered channel', () => {
    const reg = new ChannelRegistry();
    expect(reg.get('nonexistent')).toBeUndefined();
    expect(reg.has('nonexistent')).toBe(false);
  });

  it('overwrites existing channel with same id', () => {
    const reg = new ChannelRegistry();
    const ch1 = new CliChannel();
    const ch2 = new CliChannel();

    reg.register(ch1);
    reg.register(ch2);

    expect(reg.get('cli')).toBe(ch2);
    expect(reg.list()).toHaveLength(1);
  });

  it('clears all channels', () => {
    const reg = new ChannelRegistry();
    reg.register(new CliChannel());
    reg.register(new TelegramChannel());

    reg.clear();
    expect(reg.list()).toHaveLength(0);
  });

  it('createFromConfig starts a channel', async () => {
    const reg = new ChannelRegistry();
    const ch = new CliChannel();
    reg.register(ch);

    const started = await reg.createFromConfig('cli', {});
    expect(started).toBe(ch);
    expect(await ch.isHealthy()).toBe(true);
    await ch.stop();
  });

  it('createFromConfig throws for unregistered channel', async () => {
    const reg = new ChannelRegistry();
    await expect(reg.createFromConfig('missing', {}))
      .rejects.toThrow('not registered');
  });

  it('registers multiple different channel types', () => {
    const reg = new ChannelRegistry();
    reg.register(new CliChannel());
    reg.register(new TelegramChannel());
    reg.register(new DiscordChannel());
    reg.register(new SlackChannel());

    expect(reg.list()).toHaveLength(4);
    expect(reg.has('cli')).toBe(true);
    expect(reg.has('telegram')).toBe(true);
    expect(reg.has('discord')).toBe(true);
    expect(reg.has('slack')).toBe(true);
  });
});

// ===========================================================================
// MatrixChannel
// ===========================================================================

describe('MatrixChannel', () => {
  beforeEach(() => {
    // Reset all mock functions between tests.
    matrixMockClient.getUserId.mockClear();
    matrixMockClient.start.mockClear();
    matrixMockClient.stop.mockClear();
    matrixMockClient.sendMessage.mockClear();
    matrixMockClient.on.mockClear();
    matrixAutoJoinSetup.mockClear();

    // Restore default implementations.
    matrixMockClient.getUserId.mockImplementation(async () => '@bot:matrix.org');
    matrixMockClient.start.mockImplementation(async () => {});
    matrixMockClient.sendMessage.mockImplementation(async () => '$event_1');
  });

  it('has correct id and name', () => {
    const ch = new MatrixChannel();
    expect(ch.id).toBe('matrix');
    expect(ch.name).toBe('Matrix');
  });

  it('is unhealthy before start', async () => {
    const ch = new MatrixChannel();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('throws if homeserverUrl is missing', async () => {
    const ch = new MatrixChannel();
    await expect(ch.start({ accessToken: 'tok' })).rejects.toThrow('homeserverUrl');
  });

  it('throws if accessToken is missing', async () => {
    const ch = new MatrixChannel();
    await expect(ch.start({ homeserverUrl: 'https://matrix.org' })).rejects.toThrow('accessToken');
  });

  it('starts successfully with valid config', async () => {
    const ch = new MatrixChannel();
    await ch.start({ homeserverUrl: 'https://matrix.org', accessToken: 'test-tok' });

    expect(matrixMockClient.start).toHaveBeenCalled();
    expect(matrixMockClient.getUserId).toHaveBeenCalled();

    await ch.stop();
  });

  it('is healthy after start', async () => {
    const ch = new MatrixChannel();
    await ch.start({ homeserverUrl: 'https://matrix.org', accessToken: 'test-tok' });
    expect(await ch.isHealthy()).toBe(true);
    await ch.stop();
  });

  it('becomes unhealthy after stop', async () => {
    const ch = new MatrixChannel();
    await ch.start({ homeserverUrl: 'https://matrix.org', accessToken: 'test-tok' });
    await ch.stop();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('sends text messages', async () => {
    const ch = new MatrixChannel();
    await ch.start({ homeserverUrl: 'https://matrix.org', accessToken: 'test-tok' });

    const result = await ch.send(
      { channelId: 'matrix', groupId: '!room1:matrix.org' },
      { text: 'Hello Matrix!' },
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();

    expect(matrixMockClient.sendMessage).toHaveBeenCalledWith(
      '!room1:matrix.org',
      expect.objectContaining({ msgtype: 'm.text', body: 'Hello Matrix!' }),
    );

    await ch.stop();
  });

  it('returns error when no recipient provided', async () => {
    const ch = new MatrixChannel();
    await ch.start({ homeserverUrl: 'https://matrix.org', accessToken: 'test-tok' });

    const result = await ch.send(
      { channelId: 'matrix' },
      { text: 'No target' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('groupId');

    await ch.stop();
  });

  it('returns error when client is not running', async () => {
    const ch = new MatrixChannel();
    // Don't start -- client is null.
    const result = await ch.send(
      { channelId: 'matrix', groupId: '!room:matrix.org' },
      { text: 'test' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not running');
  });

  it('registers message handler without throwing', () => {
    const ch = new MatrixChannel();
    ch.onMessage(vi.fn());
  });

  it('registers presence handler without throwing', () => {
    const ch = new MatrixChannel();
    ch.onPresence(vi.fn());
  });

  it('sets up auto-join by default', async () => {
    matrixAutoJoinSetup.mockClear();

    const ch = new MatrixChannel();
    await ch.start({ homeserverUrl: 'https://matrix.org', accessToken: 'test-tok' });

    expect(matrixAutoJoinSetup).toHaveBeenCalled();
    await ch.stop();
  });

  it('skips auto-join when autoJoin is false', async () => {
    matrixAutoJoinSetup.mockClear();

    const ch = new MatrixChannel();
    await ch.start({
      homeserverUrl: 'https://matrix.org',
      accessToken: 'test-tok',
      autoJoin: false,
    });

    expect(matrixAutoJoinSetup).not.toHaveBeenCalled();
    await ch.stop();
  });

  it('handles second start as no-op', async () => {
    const ch = new MatrixChannel();
    await ch.start({ homeserverUrl: 'https://matrix.org', accessToken: 'test-tok' });
    await ch.start({ homeserverUrl: 'https://matrix.org', accessToken: 'test-tok' });
    expect(await ch.isHealthy()).toBe(true);
    await ch.stop();
  });
});

// ===========================================================================
// WhatsAppChannel
// ===========================================================================

describe('WhatsAppChannel', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has correct id and name', () => {
    const ch = new WhatsAppChannel();
    expect(ch.id).toBe('whatsapp');
    expect(ch.name).toBe('WhatsApp');
  });

  it('is unhealthy before start', async () => {
    const ch = new WhatsAppChannel();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('throws if accessToken is missing', async () => {
    const ch = new WhatsAppChannel();
    await expect(ch.start({ phoneNumberId: 'pn1', verifyToken: 'vt' }))
      .rejects.toThrow('accessToken');
  });

  it('throws if phoneNumberId is missing', async () => {
    const ch = new WhatsAppChannel();
    await expect(ch.start({ accessToken: 'tok', verifyToken: 'vt' }))
      .rejects.toThrow('phoneNumberId');
  });

  it('throws if verifyToken is missing', async () => {
    const ch = new WhatsAppChannel();
    await expect(ch.start({ accessToken: 'tok', phoneNumberId: 'pn1' }))
      .rejects.toThrow('verifyToken');
  });

  it('starts successfully with valid config', async () => {
    const ch = new WhatsAppChannel();
    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'vt' });
    // WhatsApp is webhook-only, so running = true immediately.
    expect(await ch.isHealthy()).toBe(false); // isHealthy calls Graph API, not mocked here.
    await ch.stop();
  });

  it('health check calls Graph API', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { id: 'pn1' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new WhatsAppChannel();
    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'vt' });

    expect(await ch.isHealthy()).toBe(true);
    expect(mockFetch).toHaveBeenCalled();

    await ch.stop();
  });

  it('stops and becomes unhealthy', async () => {
    const ch = new WhatsAppChannel();
    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'vt' });
    await ch.stop();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('handles webhook verification with correct token', async () => {
    const ch = new WhatsAppChannel();
    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'my-verify' });

    const result = ch.handleWebhookVerification({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'my-verify',
      'hub.challenge': 'challenge-abc',
    });

    expect(result).toBe('challenge-abc');
    await ch.stop();
  });

  it('rejects webhook verification with wrong token', async () => {
    const ch = new WhatsAppChannel();
    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'my-verify' });

    const result = ch.handleWebhookVerification({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge-abc',
    });

    expect(result).toBeNull();
    await ch.stop();
  });

  it('rejects webhook verification with wrong mode', async () => {
    const ch = new WhatsAppChannel();
    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'my-verify' });

    const result = ch.handleWebhookVerification({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': 'my-verify',
      'hub.challenge': 'challenge-abc',
    });

    expect(result).toBeNull();
    await ch.stop();
  });

  it('processes webhook payload with text message', async () => {
    const ch = new WhatsAppChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'vt' });

    ch.handleWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'entry1',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            contacts: [{ wa_id: '15551234567', profile: { name: 'Alice' } }],
            messages: [{
              from: '15551234567',
              id: 'wamid.123',
              timestamp: '1700000000',
              type: 'text',
              text: { body: 'Hello from WhatsApp!' },
            }],
          },
          field: 'messages',
        }],
      }],
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('Hello from WhatsApp!');
    expect(received[0]!.from.userId).toBe('15551234567');
    expect(received[0]!.id).toBe('wamid.123');
    expect(received[0]!.channelId).toBe('whatsapp');

    await ch.stop();
  });

  it('ignores payloads that are not whatsapp_business_account', async () => {
    const ch = new WhatsAppChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'vt' });

    ch.handleWebhookPayload({
      object: 'instagram',
      entry: [{
        id: 'entry1',
        changes: [{
          value: {
            messages: [{
              from: '15551234567',
              id: 'msg1',
              timestamp: '1700000000',
              type: 'text',
              text: { body: 'Should be ignored' },
            }],
          },
        }],
      }],
    });

    expect(received).toHaveLength(0);
    await ch.stop();
  });

  it('filters messages by allowedNumbers', async () => {
    const ch = new WhatsAppChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({
      accessToken: 'tok',
      phoneNumberId: 'pn1',
      verifyToken: 'vt',
      allowedNumbers: ['15551111111'],
    });

    // Allowed number.
    ch.handleWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'e1',
        changes: [{
          value: {
            messages: [{
              from: '15551111111',
              id: 'msg-ok',
              timestamp: '1700000001',
              type: 'text',
              text: { body: 'Allowed' },
            }],
          },
        }],
      }],
    });

    // Blocked number.
    ch.handleWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'e2',
        changes: [{
          value: {
            messages: [{
              from: '15559999999',
              id: 'msg-blocked',
              timestamp: '1700000002',
              type: 'text',
              text: { body: 'Blocked' },
            }],
          },
        }],
      }],
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('Allowed');

    await ch.stop();
  });

  it('extracts image attachments from webhook payload', async () => {
    const ch = new WhatsAppChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'vt' });

    ch.handleWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'e1',
        changes: [{
          value: {
            messages: [{
              from: '15551234567',
              id: 'wamid.img',
              timestamp: '1700000003',
              type: 'image',
              image: { id: 'media-id-123', mime_type: 'image/jpeg', caption: 'My photo' },
            }],
          },
        }],
      }],
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('My photo');
    expect(received[0]!.attachments).toHaveLength(1);
    expect(received[0]!.attachments![0]!.type).toBe('image');
    expect(received[0]!.attachments![0]!.url).toBe('media-id-123');
    expect(received[0]!.attachments![0]!.mimeType).toBe('image/jpeg');

    await ch.stop();
  });

  it('extracts document attachments', async () => {
    const ch = new WhatsAppChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'vt' });

    ch.handleWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'e1',
        changes: [{
          value: {
            messages: [{
              from: '15551234567',
              id: 'wamid.doc',
              timestamp: '1700000004',
              type: 'document',
              document: {
                id: 'media-doc-456',
                mime_type: 'application/pdf',
                filename: 'report.pdf',
                caption: 'Here is the report',
              },
            }],
          },
        }],
      }],
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.attachments).toHaveLength(1);
    expect(received[0]!.attachments![0]!.type).toBe('file');
    expect(received[0]!.attachments![0]!.filename).toBe('report.pdf');

    await ch.stop();
  });

  it('handles reply context (replyTo)', async () => {
    const ch = new WhatsAppChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'vt' });

    ch.handleWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'e1',
        changes: [{
          value: {
            messages: [{
              from: '15551234567',
              id: 'wamid.reply',
              timestamp: '1700000005',
              type: 'text',
              text: { body: 'Reply msg' },
              context: { message_id: 'wamid.original' },
            }],
          },
        }],
      }],
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.replyTo).toBe('wamid.original');

    await ch.stop();
  });

  it('sends text messages via Graph API', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { messages: [{ id: 'wamid.sent.1' }] } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const ch = new WhatsAppChannel();
    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'vt' });

    const result = await ch.send(
      { channelId: 'whatsapp', userId: '15551234567' },
      { text: 'Hello WhatsApp!' },
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('wamid.sent.1');

    // Verify fetch was called with the correct URL.
    const fetchUrl = mockFetch.mock.calls[0]![0] as string;
    expect(fetchUrl).toContain('graph.facebook.com');
    expect(fetchUrl).toContain('pn1/messages');

    await ch.stop();
  });

  it('returns error when no userId in recipient', async () => {
    const ch = new WhatsAppChannel();
    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'vt' });

    const result = await ch.send(
      { channelId: 'whatsapp' },
      { text: 'No target' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('userId');

    await ch.stop();
  });

  it('handles second start as no-op', async () => {
    const ch = new WhatsAppChannel();
    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'vt' });
    await ch.start({ accessToken: 'tok', phoneNumberId: 'pn1', verifyToken: 'vt' });
    // No throw -- second start is a no-op.
    await ch.stop();
  });

  it('registers message handler without throwing', () => {
    const ch = new WhatsAppChannel();
    ch.onMessage(vi.fn());
  });

  it('onPresence is a no-op', () => {
    const ch = new WhatsAppChannel();
    ch.onPresence(vi.fn());
  });
});

// ===========================================================================
// SignalChannel
// ===========================================================================

describe('SignalChannel', () => {
  it('has correct id and name', () => {
    const ch = new SignalChannel();
    expect(ch.id).toBe('signal');
    expect(ch.name).toBe('Signal');
  });

  it('is unhealthy before start', async () => {
    const ch = new SignalChannel();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('throws if account is missing', async () => {
    const ch = new SignalChannel();
    await expect(ch.start({})).rejects.toThrow('account');
  });

  it('starts successfully with valid config', async () => {
    const ch = new SignalChannel();
    await ch.start({ account: '+15551234567' });
    // The mock Socket emits 'connect' asynchronously.
    // After start resolves, running should be true.
    await ch.stop();
  });

  it('stops cleanly', async () => {
    const ch = new SignalChannel();
    await ch.start({ account: '+15551234567' });
    await ch.stop();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('registers message handler without throwing', () => {
    const ch = new SignalChannel();
    ch.onMessage(vi.fn());
  });

  it('onPresence is a no-op', () => {
    const ch = new SignalChannel();
    ch.onPresence(vi.fn());
  });

  it('returns error when no recipient provided', async () => {
    const ch = new SignalChannel();
    await ch.start({ account: '+15551234567' });

    const result = await ch.send(
      { channelId: 'signal' },
      { text: 'No target' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('userId');

    await ch.stop();
  });

  it('handles second start as no-op', async () => {
    const ch = new SignalChannel();
    await ch.start({ account: '+15551234567' });
    await ch.start({ account: '+15551234567' });
    await ch.stop();
  });
});

// ===========================================================================
// IMessageChannel
// ===========================================================================

describe('IMessageChannel', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    // Ensure tests run as if on macOS.
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

    // Reset the execFile mock to return valid defaults.
    mockExecFileCb.mockImplementation(
      (cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (cmd === 'which') {
          // "which sqlite3" succeeds.
          cb(null, '/usr/bin/sqlite3', '');
          return;
        }
        if (cmd === 'sqlite3') {
          // Default: return empty result for any sqlite3 query.
          if (args.some((a: string) => a.includes('MAX(ROWID)'))) {
            cb(null, JSON.stringify([{ max_id: 100 }]), '');
          } else if (args.some((a: string) => a.includes('SELECT 1'))) {
            cb(null, '1', '');
          } else {
            cb(null, '[]', '');
          }
          return;
        }
        cb(null, '', '');
      },
    );
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('has correct id and name', () => {
    const ch = new IMessageChannel();
    expect(ch.id).toBe('imessage');
    expect(ch.name).toBe('iMessage');
  });

  it('is unhealthy before start', async () => {
    const ch = new IMessageChannel();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('throws on non-macOS platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    const ch = new IMessageChannel();
    await expect(ch.start({})).rejects.toThrow('macOS-only');
  });

  it('throws when sqlite3 is not found', async () => {
    mockExecFileCb.mockImplementation(
      (cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (cmd === 'which') {
          cb(new Error('not found'), '', 'sqlite3 not found');
          return;
        }
        cb(null, '', '');
      },
    );

    const ch = new IMessageChannel();
    await expect(ch.start({})).rejects.toThrow('sqlite3 CLI not found');
  });

  it('starts successfully with valid config', async () => {
    const ch = new IMessageChannel();
    await ch.start({ dbPath: '/tmp/test-chat.db' });
    expect(await ch.isHealthy()).toBe(true);
    await ch.stop();
  });

  it('stops and becomes unhealthy', async () => {
    const ch = new IMessageChannel();
    await ch.start({ dbPath: '/tmp/test-chat.db' });
    await ch.stop();
    expect(await ch.isHealthy()).toBe(false);
  });

  it('registers message handler without throwing', () => {
    const ch = new IMessageChannel();
    ch.onMessage(vi.fn());
  });

  it('onPresence is a no-op', () => {
    const ch = new IMessageChannel();
    ch.onPresence(vi.fn());
  });

  it('returns error when no recipient provided', async () => {
    const ch = new IMessageChannel();
    await ch.start({ dbPath: '/tmp/test-chat.db' });

    const result = await ch.send(
      { channelId: 'imessage' },
      { text: 'No target' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('userId');

    await ch.stop();
  });

  it('handles second start as no-op', async () => {
    const ch = new IMessageChannel();
    await ch.start({ dbPath: '/tmp/test-chat.db' });
    await ch.start({ dbPath: '/tmp/test-chat.db' });
    expect(await ch.isHealthy()).toBe(true);
    await ch.stop();
  });

  it('throws when database cannot be opened', async () => {
    mockExecFileCb.mockImplementation(
      (cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (cmd === 'which') {
          cb(null, '/usr/bin/sqlite3', '');
          return;
        }
        if (cmd === 'sqlite3' && args.some((a: string) => a.includes('MAX(ROWID)'))) {
          cb(new Error('unable to open database file'), '', '');
          return;
        }
        cb(null, '', '');
      },
    );

    const ch = new IMessageChannel();
    await expect(ch.start({ dbPath: '/nonexistent/chat.db' }))
      .rejects.toThrow('Cannot read iMessage database');
  });

  // -----------------------------------------------------------------------
  // Tapback reaction detection
  // -----------------------------------------------------------------------

  it('detects tapback love reaction from polled messages', async () => {
    // Set up the mock. Use queueMicrotask for the poll callback to ensure
    // the promisified execFile resolves properly.
    let pollCallCount = 0;
    mockExecFileCb.mockImplementation(
      (cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (cmd === 'which') {
          queueMicrotask(() => cb(null, '/usr/bin/sqlite3', ''));
          return;
        }
        if (cmd === 'sqlite3') {
          const fullArgs = args.join(' ');
          if (fullArgs.includes('MAX(ROWID)')) {
            queueMicrotask(() => cb(null, JSON.stringify([{ max_id: 100 }]), ''));
            return;
          }
          if (fullArgs.includes('SELECT 1')) {
            queueMicrotask(() => cb(null, '1', ''));
            return;
          }
          if (fullArgs.includes('ROWID >')) {
            pollCallCount++;
            if (pollCallCount === 1) {
              const reactionRow = {
                ROWID: 101,
                text: '',
                date: 694000000000000000,
                handle: '+15551234567',
                is_from_me: 0,
                cache_has_attachments: 0,
                associated_message_type: 2000,
                associated_message_guid: 'p:0/AABB-CCDD-EEFF',
                thread_originator_guid: null,
                destination_caller_id: null,
                chat_identifier: 'chat123456',
                display_name: 'Family Group',
              };
              queueMicrotask(() => cb(null, JSON.stringify([reactionRow]), ''));
            } else {
              queueMicrotask(() => cb(null, '[]', ''));
            }
            return;
          }
          queueMicrotask(() => cb(null, '[]', ''));
          return;
        }
        queueMicrotask(() => cb(null, '', ''));
      },
    );

    const ch = new IMessageChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ dbPath: '/tmp/test-chat.db', pollInterval: 50 });

    // Wait for poll cycles to fire.
    for (let i = 0; i < 40 && received.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(pollCallCount).toBeGreaterThan(0);
    expect(received.length).toBeGreaterThanOrEqual(1);
    const reaction = received[0]!;
    expect(reaction.text).toContain('love reaction');
    expect(reaction.raw).toBeDefined();
    expect((reaction.raw as Record<string, unknown>).reaction).toBe(true);
    expect((reaction.raw as Record<string, unknown>).reactionType).toBe('love');
    expect(reaction.replyTo).toBe('AABB-CCDD-EEFF'); // GUID with p:0/ prefix stripped.

    await ch.stop();
  });

  // -----------------------------------------------------------------------
  // Group ID from chat_identifier
  // -----------------------------------------------------------------------

  it('sets groupId from chat_identifier for group chats', async () => {
    let pollCallCount = 0;
    mockExecFileCb.mockImplementation(
      (cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (cmd === 'which') {
          queueMicrotask(() => cb(null, '/usr/bin/sqlite3', ''));
          return;
        }
        if (cmd === 'sqlite3') {
          const fullArgs = args.join(' ');
          if (fullArgs.includes('MAX(ROWID)')) {
            queueMicrotask(() => cb(null, JSON.stringify([{ max_id: 100 }]), ''));
            return;
          }
          if (fullArgs.includes('SELECT 1')) {
            queueMicrotask(() => cb(null, '1', ''));
            return;
          }
          if (fullArgs.includes('ROWID >')) {
            pollCallCount++;
            if (pollCallCount === 1) {
              const row = {
                ROWID: 101,
                text: 'Hello group!',
                date: 694000000000000000,
                handle: '+15551234567',
                is_from_me: 0,
                cache_has_attachments: 0,
                associated_message_type: 0,
                associated_message_guid: null,
                thread_originator_guid: null,
                destination_caller_id: '+15559876543',
                chat_identifier: 'chat999888777',
                display_name: 'Work Chat',
              };
              queueMicrotask(() => cb(null, JSON.stringify([row]), ''));
            } else {
              queueMicrotask(() => cb(null, '[]', ''));
            }
            return;
          }
          queueMicrotask(() => cb(null, '[]', ''));
          return;
        }
        queueMicrotask(() => cb(null, '', ''));
      },
    );

    const ch = new IMessageChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ dbPath: '/tmp/test-chat.db', pollInterval: 50 });

    for (let i = 0; i < 40 && received.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(received.length).toBeGreaterThanOrEqual(1);
    const msg = received[0]!;
    expect(msg.from.groupId).toBe('chat999888777');
    expect(msg.text).toBe('Hello group!');

    await ch.stop();
  });

  // -----------------------------------------------------------------------
  // Thread context from thread_originator_guid
  // -----------------------------------------------------------------------

  it('sets replyTo from thread_originator_guid', async () => {
    let pollCallCount = 0;
    mockExecFileCb.mockImplementation(
      (cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (cmd === 'which') {
          queueMicrotask(() => cb(null, '/usr/bin/sqlite3', ''));
          return;
        }
        if (cmd === 'sqlite3') {
          const fullArgs = args.join(' ');
          if (fullArgs.includes('MAX(ROWID)')) {
            queueMicrotask(() => cb(null, JSON.stringify([{ max_id: 100 }]), ''));
            return;
          }
          if (fullArgs.includes('SELECT 1')) {
            queueMicrotask(() => cb(null, '1', ''));
            return;
          }
          if (fullArgs.includes('ROWID >')) {
            pollCallCount++;
            if (pollCallCount === 1) {
              const row = {
                ROWID: 101,
                text: 'Thread reply',
                date: 694000000000000000,
                handle: '+15551234567',
                is_from_me: 0,
                cache_has_attachments: 0,
                associated_message_type: 0,
                associated_message_guid: null,
                thread_originator_guid: 'ORIG-GUID-12345',
                destination_caller_id: null,
                chat_identifier: '+15559999999',
                display_name: null,
              };
              queueMicrotask(() => cb(null, JSON.stringify([row]), ''));
            } else {
              queueMicrotask(() => cb(null, '[]', ''));
            }
            return;
          }
          queueMicrotask(() => cb(null, '[]', ''));
          return;
        }
        queueMicrotask(() => cb(null, '', ''));
      },
    );

    const ch = new IMessageChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ dbPath: '/tmp/test-chat.db', pollInterval: 50 });

    for (let i = 0; i < 40 && received.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(received.length).toBeGreaterThanOrEqual(1);
    const msg = received[0]!;
    expect(msg.replyTo).toBe('ORIG-GUID-12345');
    expect(msg.text).toBe('Thread reply');
    expect(msg.from.groupId).toBeUndefined();

    await ch.stop();
  });

  // -----------------------------------------------------------------------
  // Destination caller ID and display name in raw metadata
  // -----------------------------------------------------------------------

  it('includes destination_caller_id and display_name in raw metadata', async () => {
    let pollCallCount = 0;
    mockExecFileCb.mockImplementation(
      (cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (cmd === 'which') {
          queueMicrotask(() => cb(null, '/usr/bin/sqlite3', ''));
          return;
        }
        if (cmd === 'sqlite3') {
          const fullArgs = args.join(' ');
          if (fullArgs.includes('MAX(ROWID)')) {
            queueMicrotask(() => cb(null, JSON.stringify([{ max_id: 100 }]), ''));
            return;
          }
          if (fullArgs.includes('SELECT 1')) {
            queueMicrotask(() => cb(null, '1', ''));
            return;
          }
          if (fullArgs.includes('ROWID >')) {
            pollCallCount++;
            if (pollCallCount === 1) {
              const row = {
                ROWID: 101,
                text: 'Metadata test',
                date: 694000000000000000,
                handle: '+15551234567',
                is_from_me: 0,
                cache_has_attachments: 0,
                associated_message_type: 0,
                associated_message_guid: null,
                thread_originator_guid: null,
                destination_caller_id: '+15559876543',
                chat_identifier: 'chat555444333',
                display_name: 'Best Friends',
              };
              queueMicrotask(() => cb(null, JSON.stringify([row]), ''));
            } else {
              queueMicrotask(() => cb(null, '[]', ''));
            }
            return;
          }
          queueMicrotask(() => cb(null, '[]', ''));
          return;
        }
        queueMicrotask(() => cb(null, '', ''));
      },
    );

    const ch = new IMessageChannel();
    const received: InboundMessage[] = [];
    ch.onMessage((msg) => received.push(msg));

    await ch.start({ dbPath: '/tmp/test-chat.db', pollInterval: 50 });

    for (let i = 0; i < 40 && received.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(received.length).toBeGreaterThanOrEqual(1);
    const msg = received[0]!;
    const raw = msg.raw as Record<string, unknown>;
    expect(raw.destination_caller_id).toBe('+15559876543');
    expect(raw.display_name).toBe('Best Friends');

    await ch.stop();
  });

  // -----------------------------------------------------------------------
  // sendReaction stub
  // -----------------------------------------------------------------------

  it('sendReaction returns not-yet-supported error', async () => {
    const ch = new IMessageChannel();
    await ch.start({ dbPath: '/tmp/test-chat.db' });

    const result = await ch.sendReaction(
      { channelId: 'imessage', userId: '+15551234567' },
      'GUID-123',
      'love',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not yet supported');

    await ch.stop();
  });
});
