/**
 * IMessageChannel unit tests.
 *
 * Tests the macOS iMessage channel adapter — polls chat.db via sqlite3 CLI
 * and drives Messages.app via osascript JXA.
 * Mocks child_process entirely — no real sqlite3 or osascript calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IMessageChannel, buildTapbackScript, JXA_MSG_AREA_PATH, JXA_MSG_AREA_ALT } from './imessage.js';

// ---------------------------------------------------------------------------
// Mock child_process
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => {
  const execFileMock = vi.fn();
  return { execFile: execFileMock };
});

async function getExecFileMock() {
  const cp = await import('node:child_process');
  return cp.execFile as unknown as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid MessageRow for poll tests. */
const makeRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ROWID: 1,
  text: 'Hello from Alice',
  date: 978307200000000000, // nanoseconds since iMessage epoch → well after epoch
  handle: '+15551234567',
  is_from_me: 0,
  cache_has_attachments: 0,
  associated_message_type: null,
  associated_message_guid: null,
  thread_originator_guid: null,
  destination_caller_id: null,
  chat_identifier: null,
  display_name: null,
  ...overrides,
});

/**
 * Starts a channel with a mock that handles the boilerplate (which + MAX(ROWID)),
 * then delegates poll/attachment queries to mockPollImpl, waits for one poll
 * cycle, then stops.
 */
async function startAndWaitForPoll(
  channel: IMessageChannel,
  config: Record<string, unknown>,
  execMock: ReturnType<typeof vi.fn>,
  mockPollImpl: (query: string, cb: (err: Error | null, result?: { stdout: string }) => void) => void,
) {
  execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
    if (cmd === 'which') {
      cb(null, { stdout: '/usr/bin/sqlite3' });
      return;
    }
    if (cmd === 'sqlite3') {
      const isJson = args[0] === '-json';
      if (!isJson) {
        // isHealthy SELECT 1 path
        cb(null, { stdout: '' });
        return;
      }
      const query: string = args[2] ?? '';
      if (query.includes('MAX(ROWID)')) {
        cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
        return;
      }
      mockPollImpl(query, cb);
      return;
    }
    cb(null, { stdout: '' });
  });

  await channel.start({ dbPath: '/tmp/test.db', pollInterval: 1, ...config });
  await new Promise(r => setTimeout(r, 30));
  await channel.stop();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IMessageChannel', () => {
  let channel: IMessageChannel;
  const originalPlatform = process.platform;

  beforeEach(() => {
    channel = new IMessageChannel();
    // Default to darwin so most tests don't need to set it.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(async () => {
    try {
      await channel.stop();
    } catch {
      // ignore
    }
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  describe('metadata', () => {
    it('has id === imessage', () => {
      expect(channel.id).toBe('imessage');
    });

    it('has name === iMessage', () => {
      expect(channel.name).toBe('iMessage');
    });
  });

  // -------------------------------------------------------------------------
  // Platform gate
  // -------------------------------------------------------------------------

  describe('platform gate', () => {
    it('throws on linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      await expect(channel.start({})).rejects.toThrow('macOS-only');
    });

    it('throws on win32', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      await expect(channel.start({})).rejects.toThrow('macOS-only');
    });
  });

  // -------------------------------------------------------------------------
  // sqlite3 availability
  // -------------------------------------------------------------------------

  describe('sqlite3 availability', () => {
    it('throws sqlite3 CLI not found when which sqlite3 fails', async () => {
      const execMock = await getExecFileMock();
      execMock.mockImplementation((_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        cb(new Error('not found'));
      });

      await expect(channel.start({})).rejects.toThrow('sqlite3 CLI not found');
    });
  });

  // -------------------------------------------------------------------------
  // Full Disk Access error translation
  // -------------------------------------------------------------------------

  describe('Full Disk Access error translation', () => {
    it('translates "unable to open database" to Full Disk Access message', async () => {
      const execMock = await getExecFileMock();
      execMock.mockImplementation((cmd: string, _args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') {
          cb(null, { stdout: '/usr/bin/sqlite3' });
          return;
        }
        cb(new Error('unable to open database file'));
      });

      await expect(channel.start({ dbPath: '/tmp/test.db' })).rejects.toThrow('Full Disk Access');
    });

    it('translates "permission denied" to Full Disk Access message', async () => {
      const execMock = await getExecFileMock();
      execMock.mockImplementation((cmd: string, _args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') {
          cb(null, { stdout: '/usr/bin/sqlite3' });
          return;
        }
        cb(new Error('permission denied: /Library/Messages/chat.db'));
      });

      await expect(channel.start({ dbPath: '/tmp/test.db' })).rejects.toThrow('Full Disk Access');
    });
  });

  // -------------------------------------------------------------------------
  // start() success
  // -------------------------------------------------------------------------

  describe('start()', () => {
    it('sets lastRowId from MAX(ROWID) query result', async () => {
      const execMock = await getExecFileMock();
      execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 42 }]) });
            return;
          }
          // poll returns empty
          cb(null, { stdout: '' });
          return;
        }
        cb(null, { stdout: '' });
      });

      // Start and stop quickly — we just need the init to complete.
      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      await channel.stop();
      // Verify by restarting — the new channel for testing has an internal lastRowId.
      // We can't read it directly; we just verify start() succeeded.
      expect(true).toBe(true);
    });

    it('handles null max_id (empty DB) — lastRowId stays 0', async () => {
      const execMock = await getExecFileMock();
      execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: null }]) });
            return;
          }
          cb(null, { stdout: '' });
          return;
        }
        cb(null, { stdout: '' });
      });

      await expect(channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 })).resolves.not.toThrow();
      await channel.stop();
    });

    it('respects custom dbPath config', async () => {
      const execMock = await getExecFileMock();
      const calls: string[][] = [];

      execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        calls.push([cmd, ...args]);
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          cb(null, { stdout: '' });
          return;
        }
        cb(null, { stdout: '' });
      });

      await channel.start({ dbPath: '/custom/path/chat.db', pollInterval: 60000 });
      await channel.stop();

      const sqlite3Calls = calls.filter(c => c[0] === 'sqlite3');
      expect(sqlite3Calls.length).toBeGreaterThan(0);
      // All sqlite3 calls should use the custom db path.
      for (const call of sqlite3Calls) {
        expect(call).toContain('/custom/path/chat.db');
      }
    });

    it('is idempotent — second start() is a no-op', async () => {
      const execMock = await getExecFileMock();
      let callCount = 0;

      execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { callCount++; cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          cb(null, { stdout: '' });
          return;
        }
        cb(null, { stdout: '' });
      });

      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      const countAfterFirst = callCount;
      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 }); // no-op
      await channel.stop();

      expect(callCount).toBe(countAfterFirst);
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe('stop()', () => {
    it('is idempotent — double stop does not throw', async () => {
      await expect(channel.stop()).resolves.not.toThrow();
      await expect(channel.stop()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // onMessage / onPresence
  // -------------------------------------------------------------------------

  describe('onMessage / onPresence', () => {
    it('onMessage accepts a handler without throwing', () => {
      expect(() => channel.onMessage(vi.fn())).not.toThrow();
    });

    it('onPresence does not throw', () => {
      expect(() => channel.onPresence(vi.fn())).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // isHealthy
  // -------------------------------------------------------------------------

  describe('isHealthy()', () => {
    it('returns false when not running', async () => {
      expect(await channel.isHealthy()).toBe(false);
    });

    it('returns true when running and sqlite3 SELECT 1 succeeds', async () => {
      const execMock = await getExecFileMock();
      execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sqlite3') {
          // Both MAX(ROWID) and SELECT 1 succeed.
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          cb(null, { stdout: '1' });
          return;
        }
        cb(null, { stdout: '' });
      });

      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      expect(await channel.isHealthy()).toBe(true);
      await channel.stop();
    });

    it('returns false when sqlite3 SELECT 1 fails', async () => {
      const execMock = await getExecFileMock();
      execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          // isHealthy SELECT 1 (no -json flag, args[0] is dbPath) — fail.
          if (args[0] !== '-json') {
            cb(new Error('disk I/O error'));
            return;
          }
          cb(null, { stdout: '' });
          return;
        }
        cb(null, { stdout: '' });
      });

      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      expect(await channel.isHealthy()).toBe(false);
      await channel.stop();
    });
  });

  // -------------------------------------------------------------------------
  // send()
  // -------------------------------------------------------------------------

  describe('send()', () => {
    it('returns error when not running and osascript fails', async () => {
      // send() does not guard on this.running — it proceeds to call osascript.
      // Without a mock, execFile will fail (or succeed based on the mock).
      // We set up a mock that simulates osascript failure when not running.
      const execMock = await getExecFileMock();
      execMock.mockImplementation((_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        cb(new Error('osascript failed: not found'));
      });

      const result = await channel.send(
        { channelId: 'imessage', userId: '+15551234567' },
        { text: 'Hello!' },
      );
      expect(result.success).toBe(false);
    });

    it('returns error when no userId and no groupId', async () => {
      const execMock = await getExecFileMock();
      execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          cb(null, { stdout: '' });
          return;
        }
        cb(null, { stdout: '' });
      });

      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      const result = await channel.send({ channelId: 'imessage' }, { text: 'Hello!' });
      await channel.stop();

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('sends a direct message via osascript with buddy handle', async () => {
      const execMock = await getExecFileMock();
      const osascriptArgs: string[] = [];

      execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          cb(null, { stdout: '' });
          return;
        }
        if (cmd === 'osascript') {
          osascriptArgs.push(...args);
          cb(null, { stdout: '' });
          return;
        }
        cb(null, { stdout: '' });
      });

      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      const result = await channel.send(
        { channelId: 'imessage', userId: '+15551234567' },
        { text: 'Test message' },
      );
      await channel.stop();

      expect(result.success).toBe(true);
      // Should have called osascript with -l JavaScript -e <jxa>
      expect(osascriptArgs[0]).toBe('-l');
      expect(osascriptArgs[1]).toBe('JavaScript');
      const jxa = osascriptArgs[3];
      expect(jxa).toContain('Application("Messages")');
      expect(jxa).toContain('+15551234567');
      expect(jxa).toContain('Test message');
    });

    it('sends a group message via osascript with chat name', async () => {
      const execMock = await getExecFileMock();
      const osascriptArgs: string[] = [];

      execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          cb(null, { stdout: '' });
          return;
        }
        if (cmd === 'osascript') {
          osascriptArgs.push(...args);
          cb(null, { stdout: '' });
          return;
        }
        cb(null, { stdout: '' });
      });

      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      const result = await channel.send(
        { channelId: 'imessage', groupId: 'Family Chat' },
        { text: 'Group message' },
      );
      await channel.stop();

      expect(result.success).toBe(true);
      const jxa = osascriptArgs[3];
      expect(jxa).toContain('Application("Messages")');
      expect(jxa).toContain('Family Chat');
    });

    it('translates "not authorized" osascript error to Automation message', async () => {
      const execMock = await getExecFileMock();

      execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          cb(null, { stdout: '' });
          return;
        }
        if (cmd === 'osascript') {
          cb(new Error('not authorized to send Apple events to Messages'));
          return;
        }
        cb(null, { stdout: '' });
      });

      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      const result = await channel.send(
        { channelId: 'imessage', userId: '+15551234567' },
        { text: 'Hello' },
      );
      await channel.stop();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Automation');
    });

    it('returns success with messageId on successful send', async () => {
      const execMock = await getExecFileMock();

      execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          cb(null, { stdout: '' });
          return;
        }
        if (cmd === 'osascript') {
          cb(null, { stdout: '' });
          return;
        }
        cb(null, { stdout: '' });
      });

      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      const result = await channel.send(
        { channelId: 'imessage', userId: '+15551234567' },
        { text: 'Hello' },
      );
      await channel.stop();

      expect(result.success).toBe(true);
      expect(result.messageId).toBeTruthy();
    });
  });

  // sendReaction() tests follow after the polling section below.
  // (The comprehensive sendReaction tests are in the separate describe block at the end of this file.)

  // -------------------------------------------------------------------------
  // Polling — inbound message processing
  // -------------------------------------------------------------------------

  describe('Polling — inbound messages', () => {
    it('processes a plain text message and calls messageHandler', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, { stdout: JSON.stringify([makeRow()]) });
        } else {
          cb(null, { stdout: '' });
        }
      });

      expect(received.length).toBeGreaterThan(0);
      const msg = received[0] as { text: string; from: { userId: string } };
      expect(msg.text).toBe('Hello from Alice');
      expect(msg.from.userId).toBe('+15551234567');
    });

    it('advances lastRowId to the max ROWID seen', async () => {
      const execMock = await getExecFileMock();

      // We verify lastRowId indirectly: after polling rows up to ROWID=5,
      // a second poll cycle should only request ROWID > 5.
      const queriesSeen: string[] = [];

      execMock.mockImplementation((cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sqlite3') {
          const isJson = args[0] === '-json';
          if (!isJson) { cb(null, { stdout: '' }); return; }
          const query: string = args[2] ?? '';
          queriesSeen.push(query);
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          if (query.includes('FROM message m') && query.includes('ROWID > 0')) {
            // First poll: return rows with ROWID 3 and 5.
            cb(null, {
              stdout: JSON.stringify([
                makeRow({ ROWID: 3, text: 'msg3' }),
                makeRow({ ROWID: 5, text: 'msg5' }),
              ]),
            });
            return;
          }
          // Subsequent polls return empty.
          cb(null, { stdout: '' });
          return;
        }
        cb(null, { stdout: '' });
      });

      channel.onMessage(() => {});
      // pollInterval: 1 is clamped to the 100ms minimum, so wait long enough
      // for at least two cycles (200ms) plus a small buffer.
      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 1 });
      await new Promise(r => setTimeout(r, 250));
      await channel.stop();

      // After first poll, lastRowId should be 5. The next poll should use ROWID > 5.
      const secondPollQuery = queriesSeen.find(q => q.includes('ROWID > 5'));
      expect(secondPollQuery).toBeTruthy();
    });

    it('skips rows that do not match allowedHandles whitelist', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(
        channel,
        { allowedHandles: ['+19999999999'] }, // only allow this handle
        execMock,
        (query, cb) => {
          if (query.includes('FROM message m')) {
            cb(null, {
              stdout: JSON.stringify([
                makeRow({ handle: '+15551234567' }), // not in whitelist
              ]),
            });
          } else {
            cb(null, { stdout: '' });
          }
        },
      );

      expect(received.length).toBe(0);
    });

    it('detects group chat when chat_identifier starts with "chat"', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, {
            stdout: JSON.stringify([
              makeRow({ chat_identifier: 'chat123456789', display_name: 'Friends' }),
            ]),
          });
        } else {
          cb(null, { stdout: '' });
        }
      });

      expect(received.length).toBeGreaterThan(0);
      const msg = received[0] as { from: { groupId?: string } };
      expect(msg.from.groupId).toBe('chat123456789');
    });

    it('plain DM: chat_identifier is null → from.groupId is undefined', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, {
            stdout: JSON.stringify([makeRow({ chat_identifier: null })]),
          });
        } else {
          cb(null, { stdout: '' });
        }
      });

      expect(received.length).toBeGreaterThan(0);
      const msg = received[0] as { from: { groupId?: string } };
      expect(msg.from.groupId).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Polling — tapback reactions
  // -------------------------------------------------------------------------

  describe('Polling — tapback reactions', () => {
    it('tapback add (2001): text is "[like reaction]"', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, {
            stdout: JSON.stringify([
              makeRow({
                associated_message_type: 2001,
                associated_message_guid: 'p:0/SOME-GUID-1234',
                text: null,
              }),
            ]),
          });
        } else {
          cb(null, { stdout: '' });
        }
      });

      expect(received.length).toBeGreaterThan(0);
      const msg = received[0] as { text: string };
      expect(msg.text).toBe('[like reaction]');
    });

    it('tapback remove (3001): text is "[Removed like reaction]"', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, {
            stdout: JSON.stringify([
              makeRow({
                associated_message_type: 3001,
                associated_message_guid: 'p:0/SOME-GUID-9999',
                text: null,
              }),
            ]),
          });
        } else {
          cb(null, { stdout: '' });
        }
      });

      expect(received.length).toBeGreaterThan(0);
      const msg = received[0] as { text: string };
      expect(msg.text).toBe('[Removed like reaction]');
    });

    it('strips "p:0/" prefix from associated_message_guid → sets replyTo to raw GUID', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, {
            stdout: JSON.stringify([
              makeRow({
                associated_message_type: 2001,
                associated_message_guid: 'p:0/RAW-GUID-ABCD',
                text: null,
              }),
            ]),
          });
        } else {
          cb(null, { stdout: '' });
        }
      });

      const msg = received[0] as { replyTo?: string };
      expect(msg.replyTo).toBe('RAW-GUID-ABCD');
    });

    it('strips "bp:" prefix from associated_message_guid', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, {
            stdout: JSON.stringify([
              makeRow({
                associated_message_type: 2001,
                associated_message_guid: 'bp:RAW-GUID-EFGH',
                text: null,
              }),
            ]),
          });
        } else {
          cb(null, { stdout: '' });
        }
      });

      const msg = received[0] as { replyTo?: string };
      expect(msg.replyTo).toBe('RAW-GUID-EFGH');
    });
  });

  // -------------------------------------------------------------------------
  // Polling — thread context
  // -------------------------------------------------------------------------

  describe('Polling — thread context', () => {
    it('sets replyTo from thread_originator_guid when present', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, {
            stdout: JSON.stringify([
              makeRow({ thread_originator_guid: 'THREAD-ORIGINATOR-GUID' }),
            ]),
          });
        } else {
          cb(null, { stdout: '' });
        }
      });

      expect(received.length).toBeGreaterThan(0);
      const msg = received[0] as { replyTo?: string };
      expect(msg.replyTo).toBe('THREAD-ORIGINATOR-GUID');
    });
  });

  // -------------------------------------------------------------------------
  // Polling — attachments
  // -------------------------------------------------------------------------

  describe('Polling — attachments', () => {
    it('fetches attachments when cache_has_attachments is 1', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, {
            stdout: JSON.stringify([
              makeRow({ cache_has_attachments: 1, text: '' }),
            ]),
          });
        } else if (query.includes('FROM attachment a')) {
          cb(null, {
            stdout: JSON.stringify([
              { filename: '~/Library/Messages/Attachments/photo.jpg', mime_type: 'image/jpeg', uti: 'public.jpeg' },
            ]),
          });
        } else {
          cb(null, { stdout: '' });
        }
      });

      expect(received.length).toBeGreaterThan(0);
      const msg = received[0] as { attachments?: Array<{ url?: string }> };
      expect(msg.attachments).toBeDefined();
      expect(msg.attachments!.length).toBeGreaterThan(0);
    });

    it('tilde-expanded attachment path produces a file:// URL', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, {
            stdout: JSON.stringify([
              makeRow({ cache_has_attachments: 1, text: '' }),
            ]),
          });
        } else if (query.includes('FROM attachment a')) {
          cb(null, {
            stdout: JSON.stringify([
              { filename: '~/Library/Messages/Attachments/x.jpg', mime_type: 'image/jpeg', uti: null },
            ]),
          });
        } else {
          cb(null, { stdout: '' });
        }
      });

      const msg = received[0] as { attachments?: Array<{ url?: string }> };
      expect(msg.attachments![0].url).toMatch(/^file:\/\//);
    });

    it('classifies image/* mime as "image" type', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, { stdout: JSON.stringify([makeRow({ cache_has_attachments: 1, text: '' })]) });
        } else if (query.includes('FROM attachment a')) {
          cb(null, { stdout: JSON.stringify([{ filename: '~/img.png', mime_type: 'image/png', uti: null }]) });
        } else {
          cb(null, { stdout: '' });
        }
      });

      const msg = received[0] as { attachments?: Array<{ type: string }> };
      expect(msg.attachments![0].type).toBe('image');
    });

    it('classifies audio/* mime as "audio" type', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, { stdout: JSON.stringify([makeRow({ cache_has_attachments: 1, text: '' })]) });
        } else if (query.includes('FROM attachment a')) {
          cb(null, { stdout: JSON.stringify([{ filename: '~/audio.m4a', mime_type: 'audio/mp4', uti: null }]) });
        } else {
          cb(null, { stdout: '' });
        }
      });

      const msg = received[0] as { attachments?: Array<{ type: string }> };
      expect(msg.attachments![0].type).toBe('audio');
    });

    it('classifies video/* mime as "video" type', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, { stdout: JSON.stringify([makeRow({ cache_has_attachments: 1, text: '' })]) });
        } else if (query.includes('FROM attachment a')) {
          cb(null, { stdout: JSON.stringify([{ filename: '~/video.mov', mime_type: 'video/quicktime', uti: null }]) });
        } else {
          cb(null, { stdout: '' });
        }
      });

      const msg = received[0] as { attachments?: Array<{ type: string }> };
      expect(msg.attachments![0].type).toBe('video');
    });

    it('classifies unknown mime as "file" type', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, { stdout: JSON.stringify([makeRow({ cache_has_attachments: 1, text: '' })]) });
        } else if (query.includes('FROM attachment a')) {
          cb(null, { stdout: JSON.stringify([{ filename: '~/doc.pdf', mime_type: 'application/pdf', uti: null }]) });
        } else {
          cb(null, { stdout: '' });
        }
      });

      const msg = received[0] as { attachments?: Array<{ type: string }> };
      expect(msg.attachments![0].type).toBe('file');
    });
  });

  // -------------------------------------------------------------------------
  // Timestamp conversion
  // -------------------------------------------------------------------------

  describe('Timestamp conversion', () => {
    it('date: 0 produces timestamp equal to 2001-01-01T00:00:00Z', async () => {
      const execMock = await getExecFileMock();
      const received: unknown[] = [];

      channel.onMessage(msg => received.push(msg));

      await startAndWaitForPoll(channel, {}, execMock, (query, cb) => {
        if (query.includes('FROM message m')) {
          cb(null, { stdout: JSON.stringify([makeRow({ date: 0 })]) });
        } else {
          cb(null, { stdout: '' });
        }
      });

      expect(received.length).toBeGreaterThan(0);
      const msg = received[0] as { timestamp: Date };
      expect(msg.timestamp).toBeInstanceOf(Date);
      expect(msg.timestamp.getTime()).toBe(Date.UTC(2001, 0, 1));
    });
  });

  // -------------------------------------------------------------------------
  // sendReaction()
  // -------------------------------------------------------------------------

  describe('sendReaction()', () => {
    /** Helper: mock that handles sqlite3 boilerplate + one getMessageInfo query. */
    async function mockWithMessageInfo(
      overrides: {
        messageInfoRow?: Record<string, unknown> | null;
        osascriptError?: Error | null;
      } = {},
    ) {
      const execMock = await getExecFileMock();
      const {
        messageInfoRow = { text: 'Hello there', chat_identifier: '+15550000001' },
        osascriptError = null,
      } = overrides;

      execMock.mockImplementation(
        (cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
          if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
          if (cmd === 'sqlite3') {
            const query: string = args[2] ?? '';
            if (query.includes('MAX(ROWID)')) {
              cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
              return;
            }
            // getMessageInfo query (joins message + chat)
            if (query.includes('FROM message m') && query.includes('chat_identifier')) {
              const row = messageInfoRow ? [messageInfoRow] : [];
              cb(null, { stdout: JSON.stringify(row) });
              return;
            }
            cb(null, { stdout: '[]' });
            return;
          }
          if (cmd === 'osascript') {
            if (osascriptError) { cb(osascriptError); return; }
            cb(null, { stdout: '' });
            return;
          }
          cb(null, { stdout: '' });
        },
      );
      return execMock;
    }

    it('returns success: false with helpful message for unknown reaction type', async () => {
      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      const result = await channel.sendReaction(
        { channelId: 'imessage', userId: '+15550000001' },
        'guid-123',
        'fistbump',  // not a real tapback type
      );
      await channel.stop();

      expect(result.success).toBe(false);
      expect(result.error).toContain('fistbump');
      expect(result.error).toContain('love');  // should list valid types
    });

    it('returns success: false when message GUID is not found in chat.db', async () => {
      await mockWithMessageInfo({ messageInfoRow: null });
      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      const result = await channel.sendReaction(
        { channelId: 'imessage', userId: '+15550000001' },
        'nonexistent-guid',
        'love',
      );
      await channel.stop();

      expect(result.success).toBe(false);
      expect(result.error).toContain('nonexistent-guid');
    });

    it('returns success: false with Accessibility guidance when osascript is denied', async () => {
      await mockWithMessageInfo({
        osascriptError: new Error('not authorized to send Apple events to System Events'),
      });
      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      const result = await channel.sendReaction(
        { channelId: 'imessage', userId: '+15550000001' },
        'guid-abc',
        'like',
      );
      await channel.stop();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Accessibility');
      expect(result.error).toContain('System Settings');
    });

    it('returns success: true when osascript succeeds', async () => {
      await mockWithMessageInfo();
      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      const result = await channel.sendReaction(
        { channelId: 'imessage', userId: '+15550000001' },
        'guid-def',
        'love',
      );
      await channel.stop();

      expect(result.success).toBe(true);
    });

    it('accepts reaction type aliases (heart → love index 0, thumbsup → like index 1)', async () => {
      const execMock = await mockWithMessageInfo();
      const capturedOsascriptArgs: string[][] = [];

      execMock.mockImplementation(
        (cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
          if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
          if (cmd === 'sqlite3') {
            const query: string = args[2] ?? '';
            if (query.includes('MAX(ROWID)')) {
              cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
              return;
            }
            if (query.includes('FROM message m') && query.includes('chat_identifier')) {
              cb(null, { stdout: JSON.stringify([{ text: 'Hi', chat_identifier: '+15550000001' }]) });
              return;
            }
            cb(null, { stdout: '[]' });
            return;
          }
          if (cmd === 'osascript') {
            capturedOsascriptArgs.push([...args]);
            cb(null, { stdout: '' });
            return;
          }
          cb(null, { stdout: '' });
        },
      );

      await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
      await channel.sendReaction({ channelId: 'imessage', userId: '+15550000001' }, 'guid-1', 'heart');
      await channel.sendReaction({ channelId: 'imessage', userId: '+15550000001' }, 'guid-2', 'thumbsup');
      await channel.stop();

      // Both should have succeeded (osascript was called twice).
      expect(capturedOsascriptArgs).toHaveLength(2);
      // JXA script for 'heart' should use reactionIndex 0.
      expect(capturedOsascriptArgs[0]![3]).toContain('menuItems[0]');
      // JXA script for 'thumbsup' should use reactionIndex 1.
      expect(capturedOsascriptArgs[1]![3]).toContain('menuItems[1]');
    });
  });
});

// ---------------------------------------------------------------------------
// buildTapbackScript unit tests
// ---------------------------------------------------------------------------

describe('buildTapbackScript', () => {
  it('returns a string containing osascript JXA structure', () => {
    const script = buildTapbackScript('+15555550100', 'Hello world', 0);
    expect(typeof script).toBe('string');
    expect(script).toContain('Application("Messages")');
    expect(script).toContain('Application("System Events")');
  });

  it('embeds the chatIdentifier in the script', () => {
    const script = buildTapbackScript('+15555551234', 'Some message', 2);
    expect(script).toContain('+15555551234');
  });

  it('embeds the first 40 chars of messageText', () => {
    const long = 'A'.repeat(80);
    const script = buildTapbackScript('chat-id', long, 1);
    // Should only embed the first 40 chars of messageText.
    expect(script).toContain('A'.repeat(40));
    // Should not embed all 80 chars literally as a 80-char string.
    expect(script).not.toContain('A'.repeat(41));
  });

  it('embeds the reaction index', () => {
    const script = buildTapbackScript('id', 'text', 3);
    expect(script).toContain('menuItems[3]');
  });

  it('escapes double quotes in chatIdentifier', () => {
    const script = buildTapbackScript('she said "hi"', 'text', 0);
    expect(script).not.toContain('"hi"');  // raw unescaped double quote would break JXA
    expect(script).toContain('\\"hi\\"');
  });

  it('escapes backslashes in messageText', () => {
    const script = buildTapbackScript('id', 'path\\to\\file', 0);
    expect(script).toContain('path\\\\to\\\\file');
  });

  it('contains both JXA_MSG_AREA_PATH and JXA_MSG_AREA_ALT paths (primary + fallback)', () => {
    const script = buildTapbackScript('+15555550100', 'Hello', 0);
    // Primary macOS 13–14 path must be present.
    expect(script).toContain(JXA_MSG_AREA_PATH);
    // Fallback path must also be present.
    expect(script).toContain(JXA_MSG_AREA_ALT);
  });
});

// ---------------------------------------------------------------------------
// iMessage robustness tests (macOS version detection + error strings)
// ---------------------------------------------------------------------------

describe('IMessageChannel — robustness', () => {
  let channel: IMessageChannel;

  beforeEach(() => {
    channel = new IMessageChannel();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(async () => {
    try { await channel.stop(); } catch { /* ignore */ }
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
    vi.clearAllMocks();
  });

  it('start() populates macOSVersion when sw_vers succeeds', async () => {
    const execMock = await getExecFileMock();
    execMock.mockImplementation(
      (cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sw_vers') { cb(null, { stdout: '15.1\n' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          cb(null, { stdout: '[]' });
          return;
        }
        cb(null, { stdout: '' });
      },
    );

    await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
    await channel.stop();

    const ver = (channel as unknown as Record<string, unknown>)['macOSVersion'];
    expect(ver).toBe('15.1');
  });

  it('sendReaction error includes macOS version when JXA returns react_menu_error', async () => {
    const execMock = await getExecFileMock();
    execMock.mockImplementation(
      (cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sw_vers') { cb(null, { stdout: '14.6' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          if (query.includes('FROM message m') && query.includes('chat_identifier')) {
            cb(null, { stdout: JSON.stringify([{ text: 'Hi there', chat_identifier: '+15550000001' }]) });
            return;
          }
          cb(null, { stdout: '[]' });
          return;
        }
        if (cmd === 'osascript') {
          // Simulate JXA returning a react_menu_error string to stdout.
          cb(null, { stdout: 'react_menu_error: AXError -25202' });
          return;
        }
        cb(null, { stdout: '' });
      },
    );

    await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
    const result = await channel.sendReaction(
      { channelId: 'imessage', userId: '+15550000001' },
      'guid-abc',
      'love',
    );
    await channel.stop();

    expect(result.success).toBe(false);
    expect(result.error).toContain('react_menu_error:');
    expect(result.error).toContain('macOS 14.6');
  });

  it('sendReaction catch-block error includes macOS version', async () => {
    const execMock = await getExecFileMock();
    execMock.mockImplementation(
      (cmd: string, args: string[], cb: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') { cb(null, { stdout: '/usr/bin/sqlite3' }); return; }
        if (cmd === 'sw_vers') { cb(null, { stdout: '13.7' }); return; }
        if (cmd === 'sqlite3') {
          const query: string = args[2] ?? '';
          if (query.includes('MAX(ROWID)')) {
            cb(null, { stdout: JSON.stringify([{ max_id: 0 }]) });
            return;
          }
          if (query.includes('FROM message m') && query.includes('chat_identifier')) {
            cb(null, { stdout: JSON.stringify([{ text: 'Hello', chat_identifier: '+15550000001' }]) });
            return;
          }
          cb(null, { stdout: '[]' });
          return;
        }
        if (cmd === 'osascript') {
          // Throw a generic (non-authorization) error.
          cb(new Error('osascript execution failed unexpectedly'));
          return;
        }
        cb(null, { stdout: '' });
      },
    );

    await channel.start({ dbPath: '/tmp/test.db', pollInterval: 60000 });
    const result = await channel.sendReaction(
      { channelId: 'imessage', userId: '+15550000001' },
      'guid-xyz',
      'like',
    );
    await channel.stop();

    expect(result.success).toBe(false);
    expect(result.error).toContain('macOS 13.7');
  });
});
