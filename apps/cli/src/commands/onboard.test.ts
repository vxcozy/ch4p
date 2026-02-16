/**
 * Tests for onboard engine detection helpers.
 *
 * The interactive wizard itself is hard to unit test (readline + TTY),
 * but we can test the exported detection functions in isolation.
 *
 * Uses vi.mock() for node:child_process since ESM module namespaces
 * are not configurable (vi.spyOn won't work).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing the module under test.
const mockExecSync = vi.fn();
vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Import after mock setup.
const { detectBinary, detectEngines } = await import('./onboard.js');

// ---------------------------------------------------------------------------
// detectBinary
// ---------------------------------------------------------------------------

describe('detectBinary', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns true when the binary is found', () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/claude'));
    expect(detectBinary('claude')).toBe(true);
  });

  it('returns false when the binary is not found', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(detectBinary('nonexistent')).toBe(false);
  });

  it('uses "which" on non-Windows platforms', () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/claude'));
    detectBinary('claude');

    // On the current test platform (macOS/Linux), should use 'which'.
    if (process.platform !== 'win32') {
      expect(mockExecSync).toHaveBeenCalledWith('which claude', { stdio: 'ignore' });
    }
  });

  it('does not throw on errors', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('permission denied');
    });
    expect(() => detectBinary('anything')).not.toThrow();
    expect(detectBinary('anything')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectEngines
// ---------------------------------------------------------------------------

describe('detectEngines', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns claude-cli when claude binary is on PATH', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('claude')) {
        return Buffer.from('/usr/local/bin/claude');
      }
      throw new Error('not found');
    });

    const engines = detectEngines();
    expect(engines).toHaveLength(1);
    expect(engines[0]!.id).toBe('claude-cli');
    expect(engines[0]!.label).toContain('Claude');
  });

  it('returns codex-cli when codex binary is on PATH', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('codex')) {
        return Buffer.from('/usr/local/bin/codex');
      }
      throw new Error('not found');
    });

    const engines = detectEngines();
    expect(engines).toHaveLength(1);
    expect(engines[0]!.id).toBe('codex-cli');
    expect(engines[0]!.label).toContain('Codex');
  });

  it('returns ollama when ollama binary is on PATH', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('ollama')) {
        return Buffer.from('/usr/local/bin/ollama');
      }
      throw new Error('not found');
    });

    const engines = detectEngines();
    expect(engines).toHaveLength(1);
    expect(engines[0]!.id).toBe('ollama');
    expect(engines[0]!.label).toContain('Ollama');
  });

  it('returns empty array when nothing is detected', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const engines = detectEngines();
    expect(engines).toHaveLength(0);
  });

  it('returns multiple engines when multiple CLIs are found', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && (cmd.includes('claude') || cmd.includes('ollama'))) {
        return Buffer.from('/usr/local/bin/found');
      }
      throw new Error('not found');
    });

    const engines = detectEngines();
    expect(engines).toHaveLength(2);
    expect(engines.map((e: { id: string }) => e.id)).toEqual(['claude-cli', 'ollama']);
  });

  it('returns all three engines when all are found', () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/found'));

    const engines = detectEngines();
    expect(engines).toHaveLength(3);
    expect(engines.map((e: { id: string }) => e.id)).toEqual(['claude-cli', 'codex-cli', 'ollama']);
  });
});
