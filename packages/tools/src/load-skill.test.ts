/**
 * Tests for LoadSkillTool — on-demand skill loading via progressive disclosure.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ToolContext, ISecurityPolicy } from '@ch4p/core';
import { LoadSkillTool } from './load-skill.js';
import type { SkillProvider } from './load-skill.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    cwd: '/tmp/ch4p-test',
    securityPolicy: {
      validatePath: vi.fn().mockReturnValue({ allowed: true }),
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

function createMockProvider(skills: Record<string, string>): SkillProvider {
  return {
    has: (name: string) => name in skills,
    names: () => Object.keys(skills),
    getSkillContext: (name: string) => skills[name],
  };
}

const ctx = createToolContext();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LoadSkillTool', () => {
  describe('metadata', () => {
    it('has the correct name', () => {
      const tool = new LoadSkillTool(createMockProvider({}));
      expect(tool.name).toBe('load_skill');
    });

    it('is lightweight', () => {
      const tool = new LoadSkillTool(createMockProvider({}));
      expect(tool.weight).toBe('lightweight');
    });

    it('has a description', () => {
      const tool = new LoadSkillTool(createMockProvider({}));
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
    });

    it('has valid parameter schema', () => {
      const tool = new LoadSkillTool(createMockProvider({}));
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.required).toContain('name');
    });
  });

  describe('validate', () => {
    const tool = new LoadSkillTool(createMockProvider({}));

    it('accepts valid args', () => {
      const result = tool.validate({ name: 'code-review' });
      expect(result.valid).toBe(true);
    });

    it('rejects non-object args', () => {
      const result = tool.validate('not-an-object');
      expect(result.valid).toBe(false);
    });

    it('rejects null args', () => {
      const result = tool.validate(null);
      expect(result.valid).toBe(false);
    });

    it('rejects empty name', () => {
      const result = tool.validate({ name: '' });
      expect(result.valid).toBe(false);
    });

    it('rejects missing name', () => {
      const result = tool.validate({});
      expect(result.valid).toBe(false);
    });

    it('rejects non-string name', () => {
      const result = tool.validate({ name: 42 });
      expect(result.valid).toBe(false);
    });
  });

  describe('execute — success', () => {
    const provider = createMockProvider({
      'code-review': '# Code Review\n\nCheck for bugs and style issues.',
      'test-runner': '# Test Runner\n\nRun tests and report results.',
    });
    const tool = new LoadSkillTool(provider);

    it('loads an existing skill and returns its body', async () => {
      const result = await tool.execute({ name: 'code-review' }, ctx);
      expect(result.success).toBe(true);
      expect(result.output).toContain('# Skill: code-review');
      expect(result.output).toContain('Check for bugs and style issues.');
    });

    it('includes metadata with skill name and body length', async () => {
      const result = await tool.execute({ name: 'test-runner' }, ctx);
      expect(result.success).toBe(true);
      expect(result.metadata?.skillName).toBe('test-runner');
      expect(result.metadata?.bodyLength).toBe('# Test Runner\n\nRun tests and report results.'.length);
    });

    it('trims whitespace from skill name', async () => {
      const result = await tool.execute({ name: '  code-review  ' }, ctx);
      expect(result.success).toBe(true);
      expect(result.output).toContain('code-review');
    });
  });

  describe('execute — failure', () => {
    const provider = createMockProvider({
      'code-review': '# Code Review\n\nInstructions here.',
    });
    const tool = new LoadSkillTool(provider);

    it('returns error for unknown skill', async () => {
      const result = await tool.execute({ name: 'nonexistent' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(result.error).toContain('nonexistent');
    });

    it('lists available skills in error message', async () => {
      const result = await tool.execute({ name: 'bad-skill' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('code-review');
    });

    it('handles empty provider gracefully', async () => {
      const emptyTool = new LoadSkillTool(createMockProvider({}));
      const result = await emptyTool.execute({ name: 'anything' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No skills are currently loaded');
    });

    it('handles skill with no body', async () => {
      const brokenProvider: SkillProvider = {
        has: () => true,
        names: () => ['broken'],
        getSkillContext: () => undefined,
      };
      const brokenTool = new LoadSkillTool(brokenProvider);
      const result = await brokenTool.execute({ name: 'broken' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('no content');
    });
  });
});
