import { describe, it, expect } from 'vitest';
import { FormatVerifier } from './format-verifier.js';
import type { VerificationContext } from '@ch4p/core';
import type { FormatRule } from './format-verifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    taskDescription: 'Read the README and summarize it',
    finalAnswer: 'The README describes a personal AI assistant platform called ch4p.',
    messages: [],
    toolResults: [],
    stateSnapshots: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FormatVerifier — built-in rules
// ---------------------------------------------------------------------------

describe('FormatVerifier', () => {
  describe('non-empty-answer rule', () => {
    it('passes when answer is non-empty', async () => {
      const v = new FormatVerifier();
      const result = await v.checkFormat(makeContext());
      expect(result.passed).toBe(true);
    });

    it('fails when answer is empty', async () => {
      const v = new FormatVerifier();
      const result = await v.checkFormat(makeContext({ finalAnswer: '' }));
      expect(result.passed).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors![0]).toContain('non-empty-answer');
    });

    it('fails when answer is whitespace only', async () => {
      const v = new FormatVerifier();
      const result = await v.checkFormat(makeContext({ finalAnswer: '   \n  ' }));
      expect(result.passed).toBe(false);
    });

    it('respects custom minAnswerLength', async () => {
      const v = new FormatVerifier({ minAnswerLength: 50 });
      const result = await v.checkFormat(makeContext({ finalAnswer: 'Short.' }));
      expect(result.passed).toBe(false);
      expect(result.errors![0]).toContain('minimum 50 characters');
    });
  });

  describe('tool-success-ratio rule', () => {
    it('passes when all tools succeed', async () => {
      const v = new FormatVerifier();
      const result = await v.checkFormat(makeContext({
        toolResults: [
          { success: true, output: 'ok' },
          { success: true, output: 'ok' },
        ],
      }));
      expect(result.passed).toBe(true);
    });

    it('passes when no tools were called', async () => {
      const v = new FormatVerifier();
      const result = await v.checkFormat(makeContext({ toolResults: [] }));
      expect(result.passed).toBe(true);
    });

    it('passes when error ratio is below threshold', async () => {
      const v = new FormatVerifier({ maxToolErrorRatio: 0.5 });
      const result = await v.checkFormat(makeContext({
        toolResults: [
          { success: true, output: 'ok' },
          { success: true, output: 'ok' },
          { success: false, output: '', error: 'failed' },
        ],
      }));
      // 1/3 = 33% < 50% threshold
      expect(result.passed).toBe(true);
    });

    it('fails when error ratio exceeds threshold', async () => {
      const v = new FormatVerifier({ maxToolErrorRatio: 0.3 });
      const result = await v.checkFormat(makeContext({
        toolResults: [
          { success: true, output: 'ok' },
          { success: false, output: '', error: 'err1' },
          { success: false, output: '', error: 'err2' },
        ],
      }));
      // 2/3 = 67% > 30% threshold
      expect(result.passed).toBe(false);
      expect(result.errors![0]).toContain('tool-success-ratio');
    });

    it('fails when all tools error at default threshold', async () => {
      const v = new FormatVerifier();
      const result = await v.checkFormat(makeContext({
        toolResults: [
          { success: false, output: '', error: 'err1' },
          { success: false, output: '', error: 'err2' },
        ],
      }));
      // 2/2 = 100% > 50% default threshold
      expect(result.passed).toBe(false);
    });
  });

  describe('no-error-only-answer rule', () => {
    it('does not fail format check (is a warning)', async () => {
      const v = new FormatVerifier();
      const result = await v.checkFormat(makeContext({
        finalAnswer: 'Error: something went wrong and I could not complete the task.',
      }));
      // This is a warning, not an error — checkFormat only fails on errors.
      expect(result.passed).toBe(true);
    });

    it('appears as warning in verify()', async () => {
      const v = new FormatVerifier();
      const result = await v.verify(makeContext({
        finalAnswer: 'Error: something went wrong and I could not complete the task.',
      }));
      expect(result.outcome).toBe('partial'); // warnings → partial
      expect(result.issues?.some((i) => i.severity === 'warning' && i.message.includes('error message'))).toBe(true);
    });
  });

  describe('task-reference rule', () => {
    it('does not fail format check (is a warning)', async () => {
      const v = new FormatVerifier();
      const result = await v.checkFormat(makeContext({
        taskDescription: 'Analyze the database performance',
        finalAnswer: 'The sky is blue and the grass is green.',
      }));
      expect(result.passed).toBe(true); // warning, not error
    });

    it('passes when answer references task terms', async () => {
      const v = new FormatVerifier();
      const result = await v.verify(makeContext({
        taskDescription: 'Analyze the database performance metrics',
        finalAnswer: 'The database shows 95th percentile latency of 12ms with excellent performance.',
      }));
      // "database" and "performance" are both in the answer
      expect(result.issues?.some((i) => i.message.includes('task-reference'))).toBeFalsy();
    });

    it('warns when answer has zero overlap with task', async () => {
      const v = new FormatVerifier();
      const result = await v.verify(makeContext({
        taskDescription: 'Analyze the database performance metrics',
        finalAnswer: 'Hello! How can I help you today?',
      }));
      expect(result.issues?.some((i) => i.message.includes('task-reference'))).toBe(true);
    });
  });

  describe('state-consistency rule', () => {
    it('notes when state is unchanged (info severity)', async () => {
      const v = new FormatVerifier();
      const result = await v.verify(makeContext({
        stateSnapshots: [{
          tool: 'file-write',
          args: { path: '/tmp/test.txt' },
          before: { timestamp: new Date(), state: { exists: true, content: 'hello' } },
          after: { timestamp: new Date(), state: { exists: true, content: 'hello' } },
        }],
      }));
      const stateIssue = result.issues?.find((i) => i.message.includes('state-consistency'));
      if (stateIssue) {
        expect(stateIssue.severity).toBe('info');
      }
    });

    it('no issue when state changes', async () => {
      const v = new FormatVerifier();
      const result = await v.verify(makeContext({
        stateSnapshots: [{
          tool: 'file-write',
          args: { path: '/tmp/test.txt' },
          before: { timestamp: new Date(), state: { exists: false } },
          after: { timestamp: new Date(), state: { exists: true, content: 'new content' } },
        }],
      }));
      expect(result.issues?.some((i) => i.message.includes('state-consistency'))).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // Custom rules
  // -------------------------------------------------------------------------

  describe('custom rules', () => {
    it('runs custom rules alongside built-in rules', async () => {
      const customRule: FormatRule = {
        id: 'must-contain-json',
        description: 'Answer must contain valid JSON',
        check: (ctx) => {
          try {
            JSON.parse(ctx.finalAnswer);
            return null;
          } catch {
            return 'Answer is not valid JSON';
          }
        },
      };

      const v = new FormatVerifier({ customRules: [customRule] });
      const result = await v.checkFormat(makeContext({ finalAnswer: 'not json' }));
      expect(result.passed).toBe(false);
      expect(result.errors?.some((e) => e.includes('must-contain-json'))).toBe(true);
    });

    it('custom rule passes when condition is met', async () => {
      const customRule: FormatRule = {
        id: 'must-contain-json',
        description: 'Answer must contain valid JSON',
        check: (ctx) => {
          try {
            JSON.parse(ctx.finalAnswer);
            return null;
          } catch {
            return 'Answer is not valid JSON';
          }
        },
      };

      const v = new FormatVerifier({ customRules: [customRule] });
      const result = await v.checkFormat(makeContext({ finalAnswer: '{"status": "ok"}' }));
      expect(result.passed).toBe(true);
    });

    it('skipBuiltinRules only runs custom rules', async () => {
      const customRule: FormatRule = {
        id: 'always-pass',
        description: 'Always passes',
        check: () => null,
      };

      const v = new FormatVerifier({ skipBuiltinRules: true, customRules: [customRule] });
      // Empty answer would normally fail built-in rule, but builtins are skipped.
      const result = await v.checkFormat(makeContext({ finalAnswer: '' }));
      expect(result.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // verify() overall outcomes
  // -------------------------------------------------------------------------

  describe('verify()', () => {
    it('returns success when all checks pass', async () => {
      const v = new FormatVerifier();
      const result = await v.verify(makeContext());
      expect(result.outcome).toBe('success');
      expect(result.confidence).toBe(1);
    });

    it('returns failure when errors exist', async () => {
      const v = new FormatVerifier();
      const result = await v.verify(makeContext({ finalAnswer: '' }));
      expect(result.outcome).toBe('failure');
      expect(result.confidence).toBeLessThan(1);
      expect(result.formatCheck?.passed).toBe(false);
    });

    it('returns partial when only warnings exist', async () => {
      const v = new FormatVerifier();
      const result = await v.verify(makeContext({
        taskDescription: 'Analyze database performance',
        finalAnswer: 'Error: I was unable to complete the task due to a timeout.',
      }));
      // "no-error-only-answer" is a warning, "task-reference" may also be a warning
      expect(result.outcome).toBe('partial');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThan(1);
    });

    it('includes suggestions for failures', async () => {
      const v = new FormatVerifier();
      const result = await v.verify(makeContext({ finalAnswer: '' }));
      expect(result.suggestions).toBeDefined();
      expect(result.suggestions!.length).toBeGreaterThan(0);
    });

    it('reasoning describes check count', async () => {
      const v = new FormatVerifier();
      const result = await v.verify(makeContext());
      expect(result.reasoning).toContain('format checks passed');
    });
  });
});
