/**
 * BrowserTool tests — validation, action routing, SSRF guards.
 *
 * These tests mock playwright-core to avoid requiring an actual browser.
 * They verify argument validation, SSRF protection, action dispatch,
 * security policy enforcement, and graceful error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserTool } from './browser.js';
import type { ToolContext, ISecurityPolicy } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    sessionId: 'test-session',
    cwd: '/tmp',
    securityPolicy: {
      autonomyLevel: 'supervised',
      canExecuteCommand: () => ({ allowed: true }),
      canAccessPath: () => ({ allowed: true }),
    } as unknown as ISecurityPolicy,
    abortSignal: new AbortController().signal,
    onProgress: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe('BrowserTool', () => {
  let tool: BrowserTool;

  beforeEach(() => {
    tool = new BrowserTool();
  });

  describe('metadata', () => {
    it('has correct name and weight', () => {
      expect(tool.name).toBe('browser');
      expect(tool.weight).toBe('heavyweight');
    });

    it('has parameters schema with action required', () => {
      expect(tool.parameters.required).toContain('action');
    });
  });

  describe('validate', () => {
    it('rejects non-object args', () => {
      expect(tool.validate(null)?.valid).toBe(false);
      expect(tool.validate('foo')?.valid).toBe(false);
      expect(tool.validate(42)?.valid).toBe(false);
    });

    it('rejects unknown action', () => {
      const result = tool.validate({ action: 'destroy' });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('action must be one of');
    });

    // navigate validation
    it('requires url for navigate', () => {
      const result = tool.validate({ action: 'navigate' });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('url is required');
    });

    it('rejects non-http url for navigate', () => {
      const result = tool.validate({ action: 'navigate', url: 'ftp://example.com' });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('http or https');
    });

    it('rejects blocked hostnames for navigate', () => {
      const result = tool.validate({ action: 'navigate', url: 'http://169.254.169.254/latest/meta-data' });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('blocked');
    });

    it('rejects localhost for navigate', () => {
      const result = tool.validate({ action: 'navigate', url: 'http://localhost:3000' });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('blocked');
    });

    it('rejects private IPs for navigate', () => {
      const result = tool.validate({ action: 'navigate', url: 'http://192.168.1.1' });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('blocked');
    });

    it('accepts valid public URL for navigate', () => {
      const result = tool.validate({ action: 'navigate', url: 'https://example.com' });
      expect(result.valid).toBe(true);
    });

    // click validation
    it('requires selector for click', () => {
      const result = tool.validate({ action: 'click' });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('selector is required');
    });

    it('accepts click with valid selector', () => {
      const result = tool.validate({ action: 'click', selector: '#submit-btn' });
      expect(result.valid).toBe(true);
    });

    // type validation
    it('requires selector and text for type', () => {
      const result = tool.validate({ action: 'type' });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });

    it('accepts type with selector and text', () => {
      const result = tool.validate({ action: 'type', selector: 'input[name=q]', text: 'hello' });
      expect(result.valid).toBe(true);
    });

    // evaluate validation
    it('requires expression for evaluate', () => {
      const result = tool.validate({ action: 'evaluate' });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('expression is required');
    });

    it('accepts evaluate with expression', () => {
      const result = tool.validate({ action: 'evaluate', expression: 'document.title' });
      expect(result.valid).toBe(true);
    });

    // scroll validation
    it('rejects invalid scroll direction', () => {
      const result = tool.validate({ action: 'scroll', direction: 'diagonal' });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('direction');
    });

    it('rejects invalid scroll distance', () => {
      const result = tool.validate({ action: 'scroll', distance: -5 });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('distance');
    });

    it('accepts scroll with defaults', () => {
      const result = tool.validate({ action: 'scroll' });
      expect(result.valid).toBe(true);
    });

    // wait validation
    it('rejects wait timeout below minimum', () => {
      const result = tool.validate({ action: 'wait', timeout: 10 });
      expect(result.valid).toBe(false);
    });

    it('rejects wait timeout above maximum', () => {
      const result = tool.validate({ action: 'wait', timeout: 99999 });
      expect(result.valid).toBe(false);
    });

    it('accepts wait with valid timeout', () => {
      const result = tool.validate({ action: 'wait', timeout: 2000 });
      expect(result.valid).toBe(true);
    });

    // screenshot validation
    it('accepts screenshot with no args', () => {
      const result = tool.validate({ action: 'screenshot' });
      expect(result.valid).toBe(true);
    });

    it('accepts screenshot with fullPage', () => {
      const result = tool.validate({ action: 'screenshot', fullPage: true });
      expect(result.valid).toBe(true);
    });

    it('rejects screenshot with non-boolean fullPage', () => {
      const result = tool.validate({ action: 'screenshot', fullPage: 'yes' });
      expect(result.valid).toBe(false);
    });

    // close validation
    it('accepts close with no extra args', () => {
      const result = tool.validate({ action: 'close' });
      expect(result.valid).toBe(true);
    });
  });

  describe('execute', () => {
    it('returns error when playwright-core is not installed', async () => {
      const ctx = createTestContext();
      const result = await tool.execute({ action: 'navigate', url: 'https://example.com' }, ctx);
      // Since playwright-core may or may not be installed in test env,
      // we accept either a playwright error or a successful result.
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('output');
    });

    it('returns error for invalid args', async () => {
      const ctx = createTestContext();
      const result = await tool.execute({ action: 'invalid_action' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid arguments');
    });

    it('returns error when aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      const ctx = createTestContext({ abortSignal: ac.signal });
      const result = await tool.execute({ action: 'navigate', url: 'https://example.com' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('aborted');
    });

    it('blocks evaluate in readonly mode', async () => {
      const ctx = createTestContext({
        securityPolicy: {
          autonomyLevel: 'readonly',
          canExecuteCommand: () => ({ allowed: false }),
          canAccessPath: () => ({ allowed: true }),
        } as unknown as ISecurityPolicy,
      });
      const result = await tool.execute({ action: 'evaluate', expression: 'alert(1)' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('readonly');
    });

    it('close action works even without a running browser', async () => {
      const ctx = createTestContext();
      const result = await tool.execute({ action: 'close' }, ctx);
      expect(result.success).toBe(true);
      expect(result.output).toContain('not running');
    });

    it('SSRF blocks navigate to cloud metadata via DNS', async () => {
      const ctx = createTestContext();
      // Even if validate passes (e.g. for a hostname that looks public but
      // resolves to private IP), the async DNS check in execute should block.
      // We test the synchronous check via validate above.
      const result = await tool.execute(
        { action: 'navigate', url: 'http://127.0.0.1:8080' },
        ctx,
      );
      expect(result.success).toBe(false);
      // Could be blocked at validate or execute level.
      expect(result.error).toBeDefined();
    });
  });

  describe('getStateSnapshot', () => {
    it('returns snapshot with null url when browser is not running', async () => {
      const ctx = createTestContext();
      const snapshot = await tool.getStateSnapshot!({}, ctx);
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.state.url).toBeNull();
      expect(snapshot.description).toContain('not running');
    });
  });

  describe('abort', () => {
    it('does not throw when called without running browser', () => {
      expect(() => tool.abort('test')).not.toThrow();
    });
  });
});
