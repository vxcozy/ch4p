/**
 * Tests for FileReadTool -- validation, filesystem reads with line numbers,
 * offset/limit support, binary detection, and security policy enforcement.
 */

import { vi } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolContext, ISecurityPolicy } from '@ch4p/core';
import { SecurityError } from '@ch4p/core';
import { FileReadTool } from './file-read.js';

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

describe('FileReadTool', () => {
  const tool = new FileReadTool();

  // -----------------------------------------------------------------------
  // Properties
  // -----------------------------------------------------------------------

  describe('properties', () => {
    it('has name "file_read"', () => {
      expect(tool.name).toBe('file_read');
    });

    it('has weight "lightweight"', () => {
      expect(tool.weight).toBe('lightweight');
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  describe('validate', () => {
    it('accepts valid args with path only', () => {
      const result = tool.validate({ path: '/tmp/test.txt' });
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('accepts valid args with path, offset, and limit', () => {
      const result = tool.validate({ path: '/tmp/test.txt', offset: 5, limit: 100 });
      expect(result.valid).toBe(true);
    });

    it('rejects missing path', () => {
      const result = tool.validate({ offset: 1 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('path must be a non-empty string.');
    });

    it('rejects empty path', () => {
      const result = tool.validate({ path: '' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('path must be a non-empty string.');
    });

    it('rejects non-object args', () => {
      const result = tool.validate('not an object');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Arguments must be an object.');
    });

    it('rejects null args', () => {
      const result = tool.validate(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Arguments must be an object.');
    });

    it('rejects offset less than 1', () => {
      const result = tool.validate({ path: '/tmp/test.txt', offset: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('offset must be a positive integer (1-based).');
    });

    it('rejects non-integer offset', () => {
      const result = tool.validate({ path: '/tmp/test.txt', offset: 1.5 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('offset must be a positive integer (1-based).');
    });

    it('rejects limit less than 1', () => {
      const result = tool.validate({ path: '/tmp/test.txt', limit: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('limit must be a positive integer.');
    });

    it('rejects non-integer limit', () => {
      const result = tool.validate({ path: '/tmp/test.txt', limit: 2.5 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('limit must be a positive integer.');
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

    it('reads a text file successfully with line numbers', async () => {
      const filePath = join(tmpDir, 'hello.txt');
      await writeFile(filePath, 'line one\nline two\nline three\n');

      const ctx = makeContext();
      const result = await tool.execute({ path: filePath }, ctx);

      expect(result.success).toBe(true);
      expect(result.output).toContain('1\tline one');
      expect(result.output).toContain('2\tline two');
      expect(result.output).toContain('3\tline three');
    });

    it('respects offset parameter (1-based)', async () => {
      const filePath = join(tmpDir, 'offset.txt');
      await writeFile(filePath, 'a\nb\nc\nd\ne\n');

      const ctx = makeContext();
      const result = await tool.execute({ path: filePath, offset: 3 }, ctx);

      expect(result.success).toBe(true);
      // Lines 3-6 (c, d, e, empty trailing)
      expect(result.output).toContain('c');
      expect(result.output).toContain('d');
      expect(result.output).toContain('e');
      // Should not contain lines before offset
      expect(result.output).not.toMatch(/\t[ab]$/m);
    });

    it('respects limit parameter', async () => {
      const filePath = join(tmpDir, 'limit.txt');
      await writeFile(filePath, 'a\nb\nc\nd\ne\nf\ng\n');

      const ctx = makeContext();
      const result = await tool.execute({ path: filePath, limit: 2 }, ctx);

      expect(result.success).toBe(true);
      expect(result.output).toContain('a');
      expect(result.output).toContain('b');
      // c should not appear
      expect(result.output).not.toContain('\tc');
      expect(result.metadata?.truncated).toBe(true);
    });

    it('returns error for non-existent file', async () => {
      const filePath = join(tmpDir, 'does-not-exist.txt');
      const ctx = makeContext();
      const result = await tool.execute({ path: filePath }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });

    it('returns error for binary file extension (.png)', async () => {
      const filePath = join(tmpDir, 'image.png');
      await writeFile(filePath, 'fake binary content');

      const ctx = makeContext();
      const result = await tool.execute({ path: filePath }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot read binary file');
      expect(result.error).toContain('.png');
      expect(result.metadata?.binary).toBe(true);
    });

    it('returns "(empty file)" for empty files', async () => {
      const filePath = join(tmpDir, 'empty.txt');
      await writeFile(filePath, '');

      const ctx = makeContext();
      const result = await tool.execute({ path: filePath }, ctx);

      expect(result.success).toBe(true);
      expect(result.output).toBe('(empty file)');
      expect(result.metadata?.lines).toBe(0);
    });

    it('returns error for directory paths', async () => {
      const dirPath = join(tmpDir, 'a-directory');
      await mkdir(dirPath, { recursive: true });

      const ctx = makeContext();
      const result = await tool.execute({ path: dirPath }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Path is not a file');
    });

    it('throws SecurityError when path is blocked', async () => {
      const filePath = join(tmpDir, 'blocked.txt');
      await writeFile(filePath, 'secret');

      const ctx = makeContext({
        securityPolicy: {
          ...createToolContext().securityPolicy,
          validatePath: vi.fn().mockReturnValue({ allowed: false, reason: 'blocked by policy' }),
        } as unknown as ISecurityPolicy,
      });

      await expect(tool.execute({ path: filePath }, ctx)).rejects.toThrow(SecurityError);
      await expect(tool.execute({ path: filePath }, ctx)).rejects.toThrow(/Path blocked/);
    });

    it('truncates long lines (> 2000 chars)', async () => {
      const filePath = join(tmpDir, 'long-lines.txt');
      const longLine = 'x'.repeat(3000);
      await writeFile(filePath, longLine);

      const ctx = makeContext();
      const result = await tool.execute({ path: filePath }, ctx);

      expect(result.success).toBe(true);
      expect(result.output).toContain('...(truncated)');
      // The line in output should be shorter than the original
      // Line number + tab + 2000 chars + '...(truncated)'
      const outputLine = result.output.split('\n')[0]!;
      // Remove the line number prefix to get just the content
      const content = outputLine.split('\t').slice(1).join('\t');
      expect(content.length).toBeLessThan(3000);
    });

    it('uses canonicalPath from security policy when provided', async () => {
      const filePath = join(tmpDir, 'canonical.txt');
      await writeFile(filePath, 'canonical content');

      const ctx = makeContext({
        securityPolicy: {
          ...createToolContext().securityPolicy,
          validatePath: vi.fn().mockReturnValue({
            allowed: true,
            canonicalPath: filePath,
          }),
        } as unknown as ISecurityPolicy,
      });

      const result = await tool.execute({ path: filePath }, ctx);

      expect(result.success).toBe(true);
      expect(result.metadata?.path).toBe(filePath);
    });
  });
});
