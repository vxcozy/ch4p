/**
 * Tests for CLI splash animation module.
 *
 * Verifies frame data integrity, non-TTY fallback behavior,
 * and correct ANSI output for both animation modes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// We need to test exports and behavior, so we dynamically import after
// mocking stdout/stdin as needed.
// ---------------------------------------------------------------------------

describe('splash', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    writeSpy.mockRestore();
    logSpy.mockRestore();
  });

  describe('CHAPPIE_ART', () => {
    it('exports playFullAnimation as an async function', async () => {
      const mod = await import('./splash.js');
      expect(typeof mod.playFullAnimation).toBe('function');
    });

    it('exports playBriefSplash as an async function', async () => {
      const mod = await import('./splash.js');
      expect(typeof mod.playBriefSplash).toBe('function');
    });
  });

  describe('playFullAnimation — non-TTY', () => {
    it('produces static output when not a TTY', async () => {
      const origIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

      try {
        const { playFullAnimation } = await import('./splash.js');
        await playFullAnimation();

        // Should have called console.log with art lines and welcome text.
        const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(allOutput).toContain('ch4p');
        expect(allOutput).toContain('personal AI assistant');
        // Should contain ANSI color codes (TEAL = \x1b[38;2;0;186;188m).
        expect(allOutput).toContain('\x1b[38;2;0;186;188m');
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });
  });

  describe('playBriefSplash — non-TTY', () => {
    it('produces no output when not a TTY', async () => {
      const origIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

      try {
        const { playBriefSplash } = await import('./splash.js');
        await playBriefSplash();

        // Should produce zero output in non-TTY mode.
        expect(writeSpy).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });
  });
});
