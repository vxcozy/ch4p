/**
 * LLMVerifier — LLM-as-a-judge semantic verification.
 *
 * Uses a separate LLM call to evaluate whether the agent's output
 * actually satisfies the user's intent. This is the "semantic check"
 * phase of AWM's verification pipeline.
 *
 * The verifier constructs a judge prompt containing:
 *   - The original task description
 *   - The agent's final answer
 *   - A summary of tool calls and their results
 *   - State snapshot diffs (if available)
 *
 * The judge LLM returns a structured assessment that is parsed into
 * a SemanticCheckResult.
 *
 * This verifier also runs format checks via a FormatVerifier internally,
 * producing a full VerificationResult with both format and semantic phases.
 */

import type {
  IVerifier,
  IProvider,
  VerificationContext,
  VerificationResult,
  FormatCheckResult,
  SemanticCheckResult,
  VerificationIssue,
  Message,
} from '@ch4p/core';

import { FormatVerifier } from './format-verifier.js';
import type { FormatVerifierOpts } from './format-verifier.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LLMVerifierOpts {
  /** The LLM provider to use for semantic checks. */
  provider: IProvider;
  /** Model ID for the judge LLM. */
  model: string;
  /** Options for the internal format verifier. */
  formatOpts?: FormatVerifierOpts;
  /** Maximum tokens for the judge response. Default: 1024. */
  maxJudgeTokens?: number;
  /** Temperature for the judge LLM. Default: 0 (deterministic). */
  temperature?: number;
  /** Whether to skip semantic check if format check fails. Default: true. */
  skipSemanticOnFormatFailure?: boolean;
  /** Maximum number of tool results to include in the judge prompt.
   *  Default: 20. Prevents excessive context usage. */
  maxToolResultsInPrompt?: number;
}

// ---------------------------------------------------------------------------
// Judge prompt construction
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are a task verification judge. Your job is to assess whether an AI agent correctly completed a user's task.

You will receive:
1. The original task the user requested
2. The agent's final answer
3. A summary of tool calls the agent made

Evaluate the following criteria:
- **Completeness**: Did the agent fully address the task?
- **Correctness**: Is the agent's answer accurate and appropriate?
- **Quality**: Is the answer well-structured and useful?

Respond in EXACTLY this JSON format (no markdown, no code fences):
{"score": <number 0-100>, "passed": <boolean>, "reasoning": "<brief explanation>", "issues": [{"severity": "<error|warning|info>", "message": "<issue description>"}]}

Score guide: 0-30 = failure, 31-70 = partial, 71-100 = success.
Set "passed" to true only if score >= 71.`;

function buildJudgePrompt(context: VerificationContext, maxToolResults: number): string {
  const parts: string[] = [];

  parts.push(`## Original Task\n${context.taskDescription}`);
  parts.push(`\n## Agent's Final Answer\n${context.finalAnswer}`);

  if (context.toolResults.length > 0) {
    const results = context.toolResults.slice(0, maxToolResults);
    const toolSummary = results.map((r, i) => {
      const status = r.success ? '✓' : '✗';
      const output = r.output
        ? r.output.length > 200
          ? r.output.slice(0, 200) + '...'
          : r.output
        : '(no output)';
      const error = r.error ? ` | Error: ${r.error}` : '';
      return `${i + 1}. ${status} ${output}${error}`;
    });
    parts.push(`\n## Tool Call Results (${context.toolResults.length} total)\n${toolSummary.join('\n')}`);

    if (context.toolResults.length > maxToolResults) {
      parts.push(`\n(${context.toolResults.length - maxToolResults} additional tool results omitted)`);
    }
  }

  if (context.stateSnapshots.length > 0) {
    const diffs = context.stateSnapshots
      .filter((s) => s.before || s.after)
      .slice(0, 5)
      .map((s) => {
        const before = s.before ? JSON.stringify(s.before.state) : '(none)';
        const after = s.after ? JSON.stringify(s.after.state) : '(none)';
        return `- ${s.tool}: before=${before.slice(0, 100)}, after=${after.slice(0, 100)}`;
      });
    if (diffs.length > 0) {
      parts.push(`\n## State Changes\n${diffs.join('\n')}`);
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface JudgeResponse {
  score: number;
  passed: boolean;
  reasoning: string;
  issues?: Array<{ severity: string; message: string }>;
}

function parseJudgeResponse(text: string): JudgeResponse {
  // Try to extract JSON from the response (handle markdown fences if present).
  let jsonStr = text.trim();

  // Strip markdown code fences if the LLM wrapped it.
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  try {
    const parsed = JSON.parse(jsonStr) as JudgeResponse;

    // Validate and clamp fields.
    return {
      score: Math.max(0, Math.min(100, typeof parsed.score === 'number' ? parsed.score : 0)),
      passed: typeof parsed.passed === 'boolean' ? parsed.passed : parsed.score >= 71,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'No reasoning provided.',
      issues: Array.isArray(parsed.issues) ? parsed.issues : undefined,
    };
  } catch {
    // If parsing fails, try to extract score from the text heuristically.
    const scoreMatch = text.match(/score["\s:]+(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]!, 10) : 50;

    return {
      score,
      passed: score >= 71,
      reasoning: `Failed to parse structured judge response. Raw text: ${text.slice(0, 200)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// LLMVerifier
// ---------------------------------------------------------------------------

export class LLMVerifier implements IVerifier {
  readonly id = 'llm-verifier';
  readonly name = 'LLM Verifier';

  private readonly provider: IProvider;
  private readonly model: string;
  private readonly formatVerifier: FormatVerifier;
  private readonly maxJudgeTokens: number;
  private readonly temperature: number;
  private readonly skipSemanticOnFormatFailure: boolean;
  private readonly maxToolResultsInPrompt: number;

  constructor(opts: LLMVerifierOpts) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.formatVerifier = new FormatVerifier(opts.formatOpts);
    this.maxJudgeTokens = opts.maxJudgeTokens ?? 1024;
    this.temperature = opts.temperature ?? 0;
    this.skipSemanticOnFormatFailure = opts.skipSemanticOnFormatFailure ?? true;
    this.maxToolResultsInPrompt = opts.maxToolResultsInPrompt ?? 20;
  }

  async checkFormat(context: VerificationContext): Promise<FormatCheckResult> {
    return this.formatVerifier.checkFormat(context);
  }

  async checkSemantic(context: VerificationContext): Promise<SemanticCheckResult> {
    const judgePrompt = buildJudgePrompt(context, this.maxToolResultsInPrompt);

    const messages: Message[] = [
      { role: 'user', content: judgePrompt },
    ];

    const result = await this.provider.complete(this.model, messages, {
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      maxTokens: this.maxJudgeTokens,
      temperature: this.temperature,
    });

    const responseText = typeof result.message.content === 'string'
      ? result.message.content
      : '';

    const judge = parseJudgeResponse(responseText);

    return {
      passed: judge.passed,
      score: judge.score / 100, // Normalize to 0–1.
      reasoning: judge.reasoning,
    };
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    // Phase 1: Format check.
    const formatCheck = await this.checkFormat(context);

    // Phase 2: Semantic check (unless format failed and we're configured to skip).
    let semanticCheck: SemanticCheckResult | undefined;
    if (!this.skipSemanticOnFormatFailure || formatCheck.passed) {
      try {
        semanticCheck = await this.checkSemantic(context);
      } catch (err) {
        // Semantic check failure is non-fatal — degrade gracefully.
        semanticCheck = {
          passed: false,
          score: 0,
          reasoning: `Semantic check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Combine results.
    const issues: VerificationIssue[] = [];

    if (!formatCheck.passed && formatCheck.errors) {
      for (const error of formatCheck.errors) {
        issues.push({ severity: 'error', message: error });
      }
    }

    if (semanticCheck && !semanticCheck.passed) {
      issues.push({
        severity: 'error',
        message: `Semantic check: ${semanticCheck.reasoning}`,
      });
    }

    // Determine outcome.
    let outcome: 'success' | 'partial' | 'failure';
    let confidence: number;

    if (!formatCheck.passed) {
      outcome = 'failure';
      confidence = 0.2;
    } else if (semanticCheck) {
      if (semanticCheck.score >= 0.71) {
        outcome = 'success';
        confidence = semanticCheck.score;
      } else if (semanticCheck.score >= 0.31) {
        outcome = 'partial';
        confidence = semanticCheck.score;
      } else {
        outcome = 'failure';
        confidence = semanticCheck.score;
      }
    } else {
      // No semantic check ran (skipped due to format failure or not available).
      outcome = formatCheck.passed ? 'success' : 'failure';
      confidence = formatCheck.passed ? 0.7 : 0.2;
    }

    const suggestions: string[] = [];
    if (!formatCheck.passed) {
      suggestions.push('Fix format issues before attempting semantic verification.');
    }
    if (semanticCheck && !semanticCheck.passed) {
      suggestions.push(`Semantic assessment: ${semanticCheck.reasoning}`);
    }

    return {
      outcome,
      confidence,
      reasoning: semanticCheck
        ? `Format: ${formatCheck.passed ? 'PASS' : 'FAIL'} | Semantic: ${semanticCheck.passed ? 'PASS' : 'FAIL'} (score: ${(semanticCheck.score * 100).toFixed(0)}%)`
        : `Format: ${formatCheck.passed ? 'PASS' : 'FAIL'} | Semantic: SKIPPED`,
      issues: issues.length > 0 ? issues : undefined,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      formatCheck,
      semanticCheck,
    };
  }
}
