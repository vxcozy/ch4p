/**
 * Tests for BashTool -- validation, command execution, output capture,
 * exit codes, timeouts, abort signals, and security policy enforcement.
 */

import { vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolContext, ISecurityPolicy } from '@ch4p/core';
import { SecurityError } from '@ch4p/core';
import { BashTool } from './bash.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    cwd: '/tmp/ch4p-test',
    securityPolicy: {
      validatePath: vi.fn().mockReturnValue({ allowed: true, canonicalPath: undefined }),
      validateCommand: vi.fn().mockReturnValue({ allowed: true }),
      autonomyLevel: 'full' as const,
      requiresConfirmation: vi.fn().mockReturnValue(false),
      audit: vi.fn().mockReturnValue([]),
      sanitizeOutput: vi.fn().mockImplementation((text: string) => ({
        clean: text,
        redacted: false,
      })),
      validateInput: vi.fn().mockReturnValue({ safe: true, threats: [] }),
    } as unknown as ISecurityPolicy,
    abortSignal: new AbortController().signal,
    onProgress: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BashTool', () => {
  const tool = new BashTool();

  // -----------------------------------------------------------------------
  // Properties
  // -----------------------------------------------------------------------

  describe('properties', () => {
    it('has name "bash"', () => {
      expect(tool.name).toBe('bash');
    });

    it('has weight "heavyweight"', () => {
      expect(tool.weight).toBe('heavyweight');
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  describe('validate', () => {
    it('accepts valid args with command only', () => {
      const result = tool.validate({ command: 'echo hello' });
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('accepts valid args with command and timeout', () => {
      const result = tool.validate({ command: 'ls', timeout: 5000 });
      expect(result.valid).toBe(true);
    });

    it('rejects missing command', () => {
      const result = tool.validate({ timeout: 5000 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('command must be a non-empty string.');
    });

    it('rejects empty command', () => {
      const result = tool.validate({ command: '' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('command must be a non-empty string.');
    });

    it('rejects whitespace-only command', () => {
      const result = tool.validate({ command: '   ' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('command must be a non-empty string.');
    });

    it('rejects non-object args', () => {
      const result = tool.validate('not an object');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Arguments must be an object.');
    });

    it('rejects timeout less than 1', () => {
      const result = tool.validate({ command: 'echo hi', timeout: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('timeout must be a positive number.');
    });

    it('rejects timeout greater than 600000', () => {
      const result = tool.validate({ command: 'echo hi', timeout: 700000 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('timeout cannot exceed 600000ms (10 minutes).');
    });

    it('rejects cwd that is not a string', () => {
      const result = tool.validate({ command: 'echo hi', cwd: 42 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('cwd must be a string.');
    });
  });

  // -----------------------------------------------------------------------
  // Execute
  // -----------------------------------------------------------------------

  describe('execute', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = join('/tmp', `ch4p-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
      return createToolContext({
        cwd: tmpDir,
        ...overrides,
      });
    }

    it('executes simple commands and captures stdout', async () => {
      const ctx = makeContext();
      const result = await tool.execute({ command: 'echo hello' }, ctx);

      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe('hello');
    });

    it('captures stderr output', async () => {
      const ctx = makeContext();
      const result = await tool.execute(
        { command: 'echo error-message >&2' },
        ctx,
      );

      // The command succeeds (exit 0) but produces stderr
      expect(result.success).toBe(true);
      expect(result.output).toContain('error-message');
    });

    it('returns exit code in metadata', async () => {
      const ctx = makeContext();
      const result = await tool.execute({ command: 'echo ok' }, ctx);

      expect(result.metadata?.code).toBe(0);
    });

    it('returns success: false for non-zero exit codes', async () => {
      const ctx = makeContext();
      const result = await tool.execute({ command: 'exit 1' }, ctx);

      expect(result.success).toBe(false);
      expect(result.metadata?.code).toBe(1);
      expect(result.error).toContain('exited with code 1');
    });

    it('returns non-zero exit code in metadata', async () => {
      const ctx = makeContext();
      const result = await tool.execute({ command: 'exit 42' }, ctx);

      expect(result.success).toBe(false);
      expect(result.metadata?.code).toBe(42);
    });

    it('respects timeout and kills long-running commands', async () => {
      const ctx = makeContext();
      const result = await tool.execute(
        { command: 'sleep 60', timeout: 200 },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
      expect(result.metadata?.timedOut).toBe(true);
    }, 10_000);

    it('throws SecurityError when command is blocked', async () => {
      const ctx = makeContext({
        securityPolicy: {
          ...createToolContext().securityPolicy,
          validatePath: vi.fn().mockReturnValue({ allowed: true, canonicalPath: undefined }),
          validateCommand: vi.fn().mockReturnValue({
            allowed: false,
            reason: 'dangerous command',
          }),
        } as unknown as ISecurityPolicy,
      });

      await expect(
        tool.execute({ command: 'rm -rf /' }, ctx),
      ).rejects.toThrow(SecurityError);

      await expect(
        tool.execute({ command: 'rm -rf /' }, ctx),
      ).rejects.toThrow(/Command blocked/);
    });

    it('throws SecurityError when cwd is blocked', async () => {
      const ctx = makeContext({
        securityPolicy: {
          ...createToolContext().securityPolicy,
          validatePath: vi.fn().mockReturnValue({
            allowed: false,
            reason: 'directory not allowed',
          }),
          validateCommand: vi.fn().mockReturnValue({ allowed: true }),
        } as unknown as ISecurityPolicy,
      });

      await expect(
        tool.execute({ command: 'echo hello' }, ctx),
      ).rejects.toThrow(SecurityError);

      await expect(
        tool.execute({ command: 'echo hello' }, ctx),
      ).rejects.toThrow(/Working directory blocked/);
    });

    it('returns error when abort signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const ctx = makeContext({
        abortSignal: controller.signal,
      });

      const result = await tool.execute({ command: 'echo hello' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('aborted before execution');
    });

    it('validates command with bash -c pattern', async () => {
      const ctx = makeContext();
      await tool.execute({ command: 'echo test' }, ctx);

      expect(ctx.securityPolicy.validateCommand).toHaveBeenCalledWith(
        'bash',
        ['-c', 'echo test'],
      );
    });

    it('validates cwd path with read operation', async () => {
      const ctx = makeContext();
      await tool.execute({ command: 'echo test' }, ctx);

      expect(ctx.securityPolicy.validatePath).toHaveBeenCalledWith(
        tmpDir,
        'read',
      );
    });

    it('uses custom cwd when provided', async () => {
      const subDir = join(tmpDir, 'subdir');
      await mkdir(subDir, { recursive: true });

      const ctx = makeContext();
      const result = await tool.execute(
        { command: 'pwd', cwd: subDir },
        ctx,
      );

      expect(result.success).toBe(true);
      // On macOS /tmp resolves to /private/tmp, so just check the suffix
      expect(result.output.trim()).toMatch(/subdir$/);
    });

    it('captures both stdout and stderr in output', async () => {
      const ctx = makeContext();
      const result = await tool.execute(
        { command: 'echo out-msg && echo err-msg >&2' },
        ctx,
      );

      expect(result.output).toContain('out-msg');
      expect(result.output).toContain('err-msg');
    });

    it('kills the process and reports error when output exceeds 10 MiB', async () => {
      const ctx = makeContext();
      // Generate >10 MiB: yes outputs ~1 byte/line; `dd` is more predictable.
      // Write 11 MiB of zeros to stdout then exit.
      const result = await tool.execute(
        { command: 'dd if=/dev/zero bs=1048576 count=11 2>/dev/null | cat' },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/10MiB limit/);
      expect(result.metadata?.outputCapped).toBe(true);
    }, 15_000);
  });
});
