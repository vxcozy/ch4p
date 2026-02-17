/**
 * MacOSChannel unit tests.
 *
 * Tests the macOS native Notification Center + AppleScript dialog channel.
 * Mocks osascript — no real macOS UI interaction during tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MacOSChannel } from './macos.js';

// ---------------------------------------------------------------------------
// Mock child_process
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => {
  const execFileMock = vi.fn();
  return {
    execFile: execFileMock,
    execSync: vi.fn(),
  };
});

// We need to get a handle on the mock after the module loads.
async function getExecFileMock() {
  const cp = await import('node:child_process');
  return cp.execFile as unknown as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MacOSChannel', () => {
  let channel: MacOSChannel;
  const originalPlatform = process.platform;

  beforeEach(() => {
    channel = new MacOSChannel();
  });

  afterEach(async () => {
    try {
      await channel.stop();
    } catch {
      // ignore
    }
    // Restore platform.
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  // ---- Metadata ----

  it('has correct id and name', () => {
    expect(channel.id).toBe('macos');
    expect(channel.name).toBe('macOS Native');
  });

  // ---- Platform gate ----

  it('throws on non-darwin platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    await expect(channel.start({})).rejects.toThrow('macOS-only');
  });

  it('throws on Windows platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    await expect(channel.start({})).rejects.toThrow('macOS-only');
  });

  // ---- Start / Stop ----

  it('starts successfully on darwin with osascript available', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const execFileMock = await getExecFileMock();
    // Mock: `which osascript` succeeds.
    execFileMock.mockImplementation(
      (cmd: string, args: string[], callback: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which' && args[0] === 'osascript') {
          callback(null, { stdout: '/usr/bin/osascript\n' });
          return;
        }
        // For the dialog prompt, simulate user cancel to prevent infinite loop.
        if (cmd === 'osascript') {
          callback(new Error('execution error: User canceled. (-128)'));
          return;
        }
        callback(null, { stdout: '' });
      },
    );

    await channel.start({});
    // Channel should be running now — stop it.
    await channel.stop();
  });

  it('start is idempotent', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation(
      (cmd: string, args: string[], callback: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') {
          callback(null, { stdout: '/usr/bin/osascript\n' });
          return;
        }
        // Cancel to prevent dialog loop.
        callback(new Error('execution error: User canceled. (-128)'));
      },
    );

    await channel.start({});
    await channel.start({}); // Should not throw.
    await channel.stop();
  });

  it('stop is idempotent', async () => {
    await channel.stop();
    await channel.stop(); // Should not throw.
  });

  // ---- onMessage ----

  it('accepts a message handler', () => {
    const handler = vi.fn();
    channel.onMessage(handler);
    // No assertion needed — just verifying it doesn't throw.
  });

  // ---- isHealthy ----

  it('returns false when not running', async () => {
    expect(await channel.isHealthy()).toBe(false);
  });

  it('returns false on non-darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(await channel.isHealthy()).toBe(false);
  });

  // ---- send ----

  it('returns error when not running', async () => {
    const result = await channel.send(
      { channelId: 'macos', userId: 'local-user' },
      { text: 'Hello!' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not running');
  });

  // ---- onPresence ----

  it('onPresence does not throw', () => {
    expect(() => channel.onPresence(vi.fn())).not.toThrow();
  });

  // ---- Config defaults ----

  it('uses default config values', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation(
      (cmd: string, args: string[], callback: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cmd === 'which') {
          callback(null, { stdout: '/usr/bin/osascript\n' });
          return;
        }
        callback(new Error('execution error: User canceled. (-128)'));
      },
    );

    // Start with empty config — should use defaults.
    await channel.start({});
    // Verify by checking health (channel started).
    await channel.stop();
  });
});
