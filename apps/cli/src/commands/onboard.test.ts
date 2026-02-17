/**
 * Tests for onboard engine detection helpers and new wizard utilities.
 *
 * The interactive wizard itself is hard to unit test (readline + TTY),
 * but we can test the exported detection functions and pure helpers
 * in isolation.
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
const { detectBinary, detectEngines, parseYesNo, parseMultiSelect, CHANNEL_DEFS } = await import('./onboard.js');

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

// ---------------------------------------------------------------------------
// parseYesNo
// ---------------------------------------------------------------------------

describe('parseYesNo', () => {
  it('returns defaultYes when answer is empty', () => {
    expect(parseYesNo('', true)).toBe(true);
    expect(parseYesNo('', false)).toBe(false);
    expect(parseYesNo('  ', true)).toBe(true);
    expect(parseYesNo('  ', false)).toBe(false);
  });

  it('returns true for "y" and "yes"', () => {
    expect(parseYesNo('y', false)).toBe(true);
    expect(parseYesNo('Y', false)).toBe(true);
    expect(parseYesNo('yes', false)).toBe(true);
    expect(parseYesNo('YES', false)).toBe(true);
    expect(parseYesNo('Yes', false)).toBe(true);
  });

  it('returns false for "n" and "no"', () => {
    expect(parseYesNo('n', true)).toBe(false);
    expect(parseYesNo('N', true)).toBe(false);
    expect(parseYesNo('no', true)).toBe(false);
    expect(parseYesNo('NO', true)).toBe(false);
  });

  it('returns false for unrecognized input', () => {
    expect(parseYesNo('maybe', false)).toBe(false);
    expect(parseYesNo('sure', true)).toBe(false);
    expect(parseYesNo('x', false)).toBe(false);
  });

  it('trims whitespace', () => {
    expect(parseYesNo('  y  ', false)).toBe(true);
    expect(parseYesNo('  n  ', true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseMultiSelect
// ---------------------------------------------------------------------------

describe('parseMultiSelect', () => {
  it('returns empty array for empty input', () => {
    expect(parseMultiSelect('', 10)).toEqual([]);
    expect(parseMultiSelect('  ', 10)).toEqual([]);
  });

  it('parses comma-separated numbers to 0-based indices', () => {
    expect(parseMultiSelect('1,3,5', 10)).toEqual([0, 2, 4]);
  });

  it('handles single number', () => {
    expect(parseMultiSelect('2', 10)).toEqual([1]);
  });

  it('ignores out-of-range numbers', () => {
    expect(parseMultiSelect('0,1,15', 10)).toEqual([0]); // 0 becomes -1 (invalid), 1 is valid, 15 > maxIndex
  });

  it('ignores negative numbers', () => {
    expect(parseMultiSelect('-1,2', 5)).toEqual([1]); // -1 becomes -2 (invalid)
  });

  it('ignores non-numeric entries', () => {
    expect(parseMultiSelect('a,2,b', 5)).toEqual([1]);
  });

  it('handles spaces around numbers', () => {
    expect(parseMultiSelect('1 , 3 , 5', 10)).toEqual([0, 2, 4]);
  });

  it('respects maxIndex boundary', () => {
    expect(parseMultiSelect('1,2,3,4,5', 3)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// CHANNEL_DEFS
// ---------------------------------------------------------------------------

describe('CHANNEL_DEFS', () => {
  it('has 15 channel definitions', () => {
    expect(CHANNEL_DEFS).toHaveLength(15);
  });

  it('all entries have required fields', () => {
    for (const def of CHANNEL_DEFS) {
      expect(typeof def.id).toBe('string');
      expect(def.id.length).toBeGreaterThan(0);
      expect(typeof def.label).toBe('string');
      expect(def.label.length).toBeGreaterThan(0);
      expect(Array.isArray(def.fields)).toBe(true);
    }
  });

  it('includes all expected channels', () => {
    const ids = CHANNEL_DEFS.map((d: { id: string }) => d.id);
    expect(ids).toContain('telegram');
    expect(ids).toContain('discord');
    expect(ids).toContain('slack');
    expect(ids).toContain('matrix');
    expect(ids).toContain('teams');
    expect(ids).toContain('whatsapp');
    expect(ids).toContain('signal');
    expect(ids).toContain('imessage');
    expect(ids).toContain('irc');
    expect(ids).toContain('zalo-oa');
    expect(ids).toContain('bluebubbles');
    expect(ids).toContain('google-chat');
    expect(ids).toContain('webchat');
    expect(ids).toContain('zalo-personal');
  });

  it('iMessage has zero config fields', () => {
    const imessage = CHANNEL_DEFS.find((d: { id: string }) => d.id === 'imessage');
    expect(imessage).toBeDefined();
    expect(imessage!.fields).toHaveLength(0);
    expect(imessage!.notes).toContain('macOS');
  });

  it('Slack has bot and app token fields', () => {
    const slack = CHANNEL_DEFS.find((d: { id: string }) => d.id === 'slack');
    expect(slack).toBeDefined();
    expect(slack!.fields).toHaveLength(2);
    expect(slack!.fields[0]!.key).toBe('botToken');
    expect(slack!.fields[1]!.key).toBe('appToken');
  });

  it('Zalo Personal has TOS warning note', () => {
    const zp = CHANNEL_DEFS.find((d: { id: string }) => d.id === 'zalo-personal');
    expect(zp).toBeDefined();
    expect(zp!.notes).toContain('TOS');
  });

  it('channel fields with secret flag are marked correctly', () => {
    const telegram = CHANNEL_DEFS.find((d: { id: string }) => d.id === 'telegram');
    expect(telegram!.fields[0]!.secret).toBe(true);
  });

  it('channel fields with defaults have defaultValue', () => {
    const irc = CHANNEL_DEFS.find((d: { id: string }) => d.id === 'irc');
    const portField = irc!.fields.find((f: { key: string }) => f.key === 'port');
    expect(portField!.defaultValue).toBe('6697');
  });
});
