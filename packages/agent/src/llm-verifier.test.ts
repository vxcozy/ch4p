import { describe, it, expect, vi } from 'vitest';
import { LLMVerifier } from './llm-verifier.js';
import type { IProvider, VerificationContext, CompletionResult, Message, TokenUsage } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

function makeMockProvider(responseText: string): IProvider {
  const completionResult: CompletionResult = {
    message: { role: 'assistant', content: responseText },
    usage: { inputTokens: 100, outputTokens: 50 },
    finishReason: 'stop',
  };

  return {
    id: 'mock',
    name: 'Mock Provider',
    listModels: vi.fn().mockResolvedValue([]),
    stream: vi.fn(),
    complete: vi.fn().mockResolvedValue(completionResult),
    countTokens: vi.fn().mockResolvedValue(100),
    supportsTools: vi.fn().mockReturnValue(false),
  };
}

function makeContext(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    taskDescription: 'Read the README and summarize it',
    finalAnswer: 'The README describes a personal AI assistant platform called ch4p with 10 trait interfaces.',
    messages: [],
    toolResults: [],
    stateSnapshots: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// LLMVerifier — checkSemantic
// ---------------------------------------------------------------------------

describe('LLMVerifier', () => {
  describe('checkSemantic()', () => {
    it('parses a valid judge response', async () => {
      const provider = makeMockProvider(
        '{"score": 85, "passed": true, "reasoning": "The answer accurately summarizes the README."}',
      );
      const v = new LLMVerifier({ provider, model: 'test-model' });
      const result = await v.checkSemantic(makeContext());

      expect(result.passed).toBe(true);
      expect(result.score).toBeCloseTo(0.85);
      expect(result.reasoning).toContain('accurately summarizes');
    });

    it('parses a failing judge response', async () => {
      const provider = makeMockProvider(
        '{"score": 20, "passed": false, "reasoning": "The answer is completely off-topic.", "issues": [{"severity": "error", "message": "Does not address the task"}]}',
      );
      const v = new LLMVerifier({ provider, model: 'test-model' });
      const result = await v.checkSemantic(makeContext());

      expect(result.passed).toBe(false);
      expect(result.score).toBeCloseTo(0.2);
      expect(result.reasoning).toContain('off-topic');
    });

    it('handles markdown-fenced JSON in response', async () => {
      const provider = makeMockProvider(
        '```json\n{"score": 90, "passed": true, "reasoning": "Excellent summary."}\n```',
      );
      const v = new LLMVerifier({ provider, model: 'test-model' });
      const result = await v.checkSemantic(makeContext());

      expect(result.passed).toBe(true);
      expect(result.score).toBeCloseTo(0.9);
    });

    it('handles malformed JSON gracefully', async () => {
      const provider = makeMockProvider(
        'This is not JSON at all. score: 60 overall.',
      );
      const v = new LLMVerifier({ provider, model: 'test-model' });
      const result = await v.checkSemantic(makeContext());

      // Should extract score heuristically via regex /score["\s:]+(\d+)/i.
      expect(result.score).toBeCloseTo(0.6);
      expect(result.reasoning).toContain('Failed to parse');
    });

    it('handles completely unstructured response', async () => {
      const provider = makeMockProvider(
        'The agent did a great job. Everything looks good.',
      );
      const v = new LLMVerifier({ provider, model: 'test-model' });
      const result = await v.checkSemantic(makeContext());

      // No score extractable → defaults to 50.
      expect(result.score).toBeCloseTo(0.5);
    });

    it('clamps score to 0-100 range', async () => {
      const provider = makeMockProvider(
        '{"score": 150, "passed": true, "reasoning": "Over-enthusiastic."}',
      );
      const v = new LLMVerifier({ provider, model: 'test-model' });
      const result = await v.checkSemantic(makeContext());

      expect(result.score).toBeLessThanOrEqual(1.0);
    });

    it('calls provider.complete with correct parameters', async () => {
      const provider = makeMockProvider(
        '{"score": 80, "passed": true, "reasoning": "Good."}',
      );
      const v = new LLMVerifier({ provider, model: 'judge-v1', temperature: 0.1, maxJudgeTokens: 512 });
      await v.checkSemantic(makeContext());

      expect(provider.complete).toHaveBeenCalledWith(
        'judge-v1',
        expect.arrayContaining([
          expect.objectContaining({ role: 'user' }),
        ]),
        expect.objectContaining({
          temperature: 0.1,
          maxTokens: 512,
          systemPrompt: expect.stringContaining('task verification judge'),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // checkFormat (delegates to FormatVerifier)
  // -------------------------------------------------------------------------

  describe('checkFormat()', () => {
    it('delegates to internal FormatVerifier', async () => {
      const provider = makeMockProvider('{}');
      const v = new LLMVerifier({ provider, model: 'test' });

      const result = await v.checkFormat(makeContext());
      expect(result.passed).toBe(true);
    });

    it('fails on empty answer via FormatVerifier', async () => {
      const provider = makeMockProvider('{}');
      const v = new LLMVerifier({ provider, model: 'test' });

      const result = await v.checkFormat(makeContext({ finalAnswer: '' }));
      expect(result.passed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // verify() — full pipeline
  // -------------------------------------------------------------------------

  describe('verify()', () => {
    it('returns success when both format and semantic pass', async () => {
      const provider = makeMockProvider(
        '{"score": 85, "passed": true, "reasoning": "Good summary."}',
      );
      const v = new LLMVerifier({ provider, model: 'test' });
      const result = await v.verify(makeContext());

      expect(result.outcome).toBe('success');
      expect(result.confidence).toBeGreaterThan(0.7);
      expect(result.formatCheck?.passed).toBe(true);
      expect(result.semanticCheck?.passed).toBe(true);
      expect(result.reasoning).toContain('Format: PASS');
      expect(result.reasoning).toContain('Semantic: PASS');
    });

    it('returns failure when format fails and skips semantic', async () => {
      const provider = makeMockProvider('{}');
      const v = new LLMVerifier({ provider, model: 'test', skipSemanticOnFormatFailure: true });
      const result = await v.verify(makeContext({ finalAnswer: '' }));

      expect(result.outcome).toBe('failure');
      expect(result.formatCheck?.passed).toBe(false);
      expect(result.semanticCheck).toBeUndefined();
      expect(result.reasoning).toContain('Semantic: SKIPPED');
      // Provider should NOT have been called.
      expect(provider.complete).not.toHaveBeenCalled();
    });

    it('runs semantic even on format failure when configured', async () => {
      const provider = makeMockProvider(
        '{"score": 10, "passed": false, "reasoning": "Empty answer."}',
      );
      const v = new LLMVerifier({ provider, model: 'test', skipSemanticOnFormatFailure: false });
      const result = await v.verify(makeContext({ finalAnswer: '' }));

      expect(result.outcome).toBe('failure');
      expect(result.semanticCheck).toBeDefined();
      // Provider SHOULD have been called.
      expect(provider.complete).toHaveBeenCalled();
    });

    it('returns partial for mid-range semantic scores', async () => {
      const provider = makeMockProvider(
        '{"score": 55, "passed": false, "reasoning": "Partially correct but incomplete."}',
      );
      const v = new LLMVerifier({ provider, model: 'test' });
      const result = await v.verify(makeContext());

      expect(result.outcome).toBe('partial');
      expect(result.confidence).toBeGreaterThan(0.3);
      expect(result.confidence).toBeLessThan(0.71);
    });

    it('returns failure for low semantic scores', async () => {
      const provider = makeMockProvider(
        '{"score": 15, "passed": false, "reasoning": "Completely wrong."}',
      );
      const v = new LLMVerifier({ provider, model: 'test' });
      const result = await v.verify(makeContext());

      expect(result.outcome).toBe('failure');
      expect(result.confidence).toBeLessThan(0.31);
    });

    it('handles provider error gracefully', async () => {
      const provider = makeMockProvider('');
      (provider.complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API rate limited'));

      const v = new LLMVerifier({ provider, model: 'test' });
      const result = await v.verify(makeContext());

      // Semantic failure is non-fatal — should degrade to failure outcome.
      expect(result.outcome).toBe('failure');
      expect(result.semanticCheck).toBeDefined();
      expect(result.semanticCheck?.reasoning).toContain('API rate limited');
    });

    it('includes tool results in judge prompt', async () => {
      const provider = makeMockProvider(
        '{"score": 90, "passed": true, "reasoning": "Good."}',
      );
      const v = new LLMVerifier({ provider, model: 'test' });
      await v.verify(makeContext({
        toolResults: [
          { success: true, output: 'file content here' },
          { success: false, output: '', error: 'permission denied' },
        ],
      }));

      const callArgs = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const messages = callArgs[1] as Message[];
      const userMessage = messages[0]!.content as string;
      expect(userMessage).toContain('Tool Call Results');
      expect(userMessage).toContain('file content here');
      expect(userMessage).toContain('permission denied');
    });

    it('includes state snapshots in judge prompt', async () => {
      const provider = makeMockProvider(
        '{"score": 90, "passed": true, "reasoning": "Good."}',
      );
      const v = new LLMVerifier({ provider, model: 'test' });
      await v.verify(makeContext({
        stateSnapshots: [{
          tool: 'file-write',
          args: {},
          before: { timestamp: new Date(), state: { exists: false } },
          after: { timestamp: new Date(), state: { exists: true } },
        }],
      }));

      const callArgs = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const messages = callArgs[1] as Message[];
      const userMessage = messages[0]!.content as string;
      expect(userMessage).toContain('State Changes');
      expect(userMessage).toContain('file-write');
    });

    it('respects maxToolResultsInPrompt', async () => {
      const provider = makeMockProvider(
        '{"score": 90, "passed": true, "reasoning": "Good."}',
      );
      const v = new LLMVerifier({ provider, model: 'test', maxToolResultsInPrompt: 2 });
      await v.verify(makeContext({
        toolResults: Array.from({ length: 10 }, (_, i) => ({
          success: true,
          output: `result-${i}`,
        })),
      }));

      const callArgs = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const messages = callArgs[1] as Message[];
      const userMessage = messages[0]!.content as string;
      expect(userMessage).toContain('result-0');
      expect(userMessage).toContain('result-1');
      expect(userMessage).not.toContain('result-5');
      expect(userMessage).toContain('8 additional tool results omitted');
    });

    it('produces suggestions on failure', async () => {
      const provider = makeMockProvider(
        '{"score": 20, "passed": false, "reasoning": "The answer ignores the task entirely."}',
      );
      const v = new LLMVerifier({ provider, model: 'test' });
      const result = await v.verify(makeContext());

      expect(result.suggestions).toBeDefined();
      expect(result.suggestions!.length).toBeGreaterThan(0);
    });
  });
});
