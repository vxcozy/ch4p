/**
 * Tests for FileWriteTool -- validation, file creation, directory creation,
 * overwriting, metadata reporting, and security policy enforcement.
 */

import { vi } from 'vitest';
import { readFile, mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolContext, ISecurityPolicy } from '@ch4p/core';
import { SecurityError } from '@ch4p/core';
import { FileWriteTool } from './file-write.js';

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

describe('FileWriteTool', () => {
  const tool = new FileWriteTool();

  // -----------------------------------------------------------------------
  // Properties
  // -----------------------------------------------------------------------

  describe('properties', () => {
    it('has name "file_write"', () => {
      expect(tool.name).toBe('file_write');
    });

    it('has weight "lightweight"', () => {
      expect(tool.weight).toBe('lightweight');
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  describe('validate', () => {
    it('accepts valid args with path and content', () => {
      const result = tool.validate({ path: 'test.txt', content: 'hello' });
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('rejects missing path', () => {
      const result = tool.validate({ content: 'hello' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('path must be a non-empty string.');
    });

    it('rejects missing content', () => {
      const result = tool.validate({ path: 'test.txt' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('content must be a string.');
    });

    it('rejects content that is not a string', () => {
      const result = tool.validate({ path: 'test.txt', content: 42 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('content must be a string.');
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

    it('writes a file successfully', async () => {
      const filePath = join(tmpDir, 'output.txt');
      const ctx = makeContext();

      const result = await tool.execute(
        { path: filePath, content: 'hello world' },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('File written successfully');

      const written = await readFile(filePath, 'utf-8');
      expect(written).toBe('hello world');
    });

    it('creates parent directories automatically', async () => {
      const filePath = join(tmpDir, 'deep', 'nested', 'dir', 'file.txt');
      const ctx = makeContext();

      const result = await tool.execute(
        { path: filePath, content: 'nested content' },
        ctx,
      );

      expect(result.success).toBe(true);

      const written = await readFile(filePath, 'utf-8');
      expect(written).toBe('nested content');
    });

    it('returns correct line count and byte count in metadata', async () => {
      const filePath = join(tmpDir, 'meta.txt');
      const content = 'line one\nline two\nline three';
      const ctx = makeContext();

      const result = await tool.execute({ path: filePath, content }, ctx);

      expect(result.success).toBe(true);
      expect(result.metadata?.lines).toBe(3);
      expect(result.metadata?.bytes).toBe(Buffer.byteLength(content, 'utf-8'));
    });

    it('reports correct byte count for multi-byte characters', async () => {
      const filePath = join(tmpDir, 'unicode.txt');
      const content = 'hello \u{1F600}'; // emoji is multi-byte in UTF-8
      const ctx = makeContext();

      const result = await tool.execute({ path: filePath, content }, ctx);

      expect(result.success).toBe(true);
      expect(result.metadata?.bytes).toBe(Buffer.byteLength(content, 'utf-8'));
      // emoji is 4 bytes in UTF-8, so total > string length
      expect(result.metadata?.bytes).toBeGreaterThan(content.length);
    });

    it('overwrites existing file', async () => {
      const filePath = join(tmpDir, 'overwrite.txt');
      await fsWriteFile(filePath, 'original content');

      const ctx = makeContext();
      const result = await tool.execute(
        { path: filePath, content: 'new content' },
        ctx,
      );

      expect(result.success).toBe(true);

      const written = await readFile(filePath, 'utf-8');
      expect(written).toBe('new content');
    });

    it('throws SecurityError when path is blocked for writing', async () => {
      const filePath = join(tmpDir, 'blocked.txt');
      const ctx = makeContext({
        securityPolicy: {
          ...createToolContext().securityPolicy,
          validatePath: vi.fn().mockReturnValue({
            allowed: false,
            reason: 'write access denied',
          }),
        } as unknown as ISecurityPolicy,
      });

      await expect(
        tool.execute({ path: filePath, content: 'secret' }, ctx),
      ).rejects.toThrow(SecurityError);

      await expect(
        tool.execute({ path: filePath, content: 'secret' }, ctx),
      ).rejects.toThrow(/Path blocked for writing/);
    });

    it('validates path with "write" operation', async () => {
      const filePath = join(tmpDir, 'check-op.txt');
      const ctx = makeContext();

      await tool.execute({ path: filePath, content: 'test' }, ctx);

      expect(ctx.securityPolicy.validatePath).toHaveBeenCalledWith(
        expect.any(String),
        'write',
      );
    });
  });

  // -----------------------------------------------------------------------
  // getStateSnapshot
  // -----------------------------------------------------------------------

  describe('getStateSnapshot', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = join('/tmp', `ch4p-snap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
      return createToolContext({ cwd: tmpDir, ...overrides });
    }

    it('captures non-existent file as exists: false', async () => {
      const filePath = join(tmpDir, 'new.txt');
      const ctx = makeContext();

      const snapshot = await tool.getStateSnapshot({ path: filePath, content: '' }, ctx);

      expect(snapshot.state.exists).toBe(false);
      expect(snapshot.timestamp).toBeDefined();
    });

    it('captures existing file with size and hash', async () => {
      const filePath = join(tmpDir, 'existing.txt');
      await fsWriteFile(filePath, 'original content', 'utf-8');
      const ctx = makeContext();

      const snapshot = await tool.getStateSnapshot({ path: filePath, content: '' }, ctx);

      expect(snapshot.state.exists).toBe(true);
      expect(snapshot.state.isFile).toBe(true);
      expect(snapshot.state.size).toBe(16); // 'original content' = 16 bytes
      expect(snapshot.state.contentHash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('shows before/after state diff across a write', async () => {
      const filePath = join(tmpDir, 'diff.txt');
      const ctx = makeContext();

      const before = await tool.getStateSnapshot({ path: filePath, content: '' }, ctx);
      expect(before.state.exists).toBe(false);

      await tool.execute({ path: filePath, content: 'new content' }, ctx);

      const after = await tool.getStateSnapshot({ path: filePath, content: '' }, ctx);
      expect(after.state.exists).toBe(true);
      expect(after.state.size).toBeGreaterThan(0);
    });

    it('handles missing path argument gracefully', async () => {
      const ctx = makeContext();
      const snapshot = await tool.getStateSnapshot({}, ctx);
      expect(snapshot.state.error).toContain('No path');
    });
  });
});
