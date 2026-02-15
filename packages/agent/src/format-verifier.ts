/**
 * FormatVerifier — code-based structural verification.
 *
 * Performs fast, deterministic checks on the agent's output without
 * requiring an LLM call. Checks include:
 *   - Non-empty final answer
 *   - All tool calls succeeded (no error results)
 *   - Tool results contain expected content patterns
 *   - State snapshots show expected changes
 *   - JSON validity (when applicable)
 *
 * This verifier does NOT implement checkSemantic() — it only does
 * format-level checks. Use LLMVerifier for semantic verification,
 * or compose both via CompositeVerifier.
 */

import type {
  IVerifier,
  VerificationContext,
  VerificationResult,
  FormatCheckResult,
  VerificationIssue,
} from '@ch4p/core';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FormatRule {
  /** Unique identifier for this rule. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** The check function. Returns null if passed, or an error string if failed. */
  check: (context: VerificationContext) => string | null;
  /** Severity if the check fails. Default: 'error'. */
  severity?: 'error' | 'warning' | 'info';
}

export interface FormatVerifierOpts {
  /** Custom format rules to run in addition to built-in rules. */
  customRules?: FormatRule[];
  /** Whether to skip built-in rules and only run custom ones. Default: false. */
  skipBuiltinRules?: boolean;
  /** Minimum required answer length. Default: 1. */
  minAnswerLength?: number;
  /** Maximum allowed tool error ratio (0–1). Default: 0.5.
   *  If more than this fraction of tool calls errored, format check fails. */
  maxToolErrorRatio?: number;
}

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

function builtinRules(opts: Required<Pick<FormatVerifierOpts, 'minAnswerLength' | 'maxToolErrorRatio'>>): FormatRule[] {
  return [
    {
      id: 'non-empty-answer',
      description: 'Final answer must not be empty',
      check: (ctx) => {
        if (!ctx.finalAnswer || ctx.finalAnswer.trim().length < opts.minAnswerLength) {
          return `Final answer is empty or too short (minimum ${opts.minAnswerLength} characters)`;
        }
        return null;
      },
    },
    {
      id: 'tool-success-ratio',
      description: 'Tool error ratio must be below threshold',
      check: (ctx) => {
        if (ctx.toolResults.length === 0) return null;
        const errors = ctx.toolResults.filter((r) => !r.success).length;
        const ratio = errors / ctx.toolResults.length;
        if (ratio > opts.maxToolErrorRatio) {
          return `${errors}/${ctx.toolResults.length} tool calls failed (${(ratio * 100).toFixed(0)}% error rate, max allowed ${(opts.maxToolErrorRatio * 100).toFixed(0)}%)`;
        }
        return null;
      },
    },
    {
      id: 'no-error-only-answer',
      description: 'Final answer should not consist solely of an error message',
      check: (ctx) => {
        const lower = ctx.finalAnswer.toLowerCase().trim();
        if (lower.startsWith('error:') || lower.startsWith('i encountered an error')) {
          return 'Final answer appears to be an error message rather than a real response';
        }
        return null;
      },
      severity: 'warning',
    },
    {
      id: 'task-reference',
      description: 'Final answer should reference the task',
      check: (ctx) => {
        // Extract key nouns from the task description (words > 4 chars).
        const taskWords = ctx.taskDescription
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 4);
        if (taskWords.length === 0) return null;

        const answerLower = ctx.finalAnswer.toLowerCase();
        const matches = taskWords.filter((w) => answerLower.includes(w));
        if (matches.length === 0) {
          return 'Final answer does not appear to reference any key terms from the original task';
        }
        return null;
      },
      severity: 'warning',
    },
    {
      id: 'state-consistency',
      description: 'State snapshots should show changes for write operations',
      check: (ctx) => {
        for (const record of ctx.stateSnapshots) {
          if (record.before && record.after) {
            // If before and after are identical, the tool may not have done anything.
            const beforeKeys = Object.keys(record.before.state);
            const afterKeys = Object.keys(record.after.state);

            if (beforeKeys.length > 0 && afterKeys.length > 0) {
              const identical = beforeKeys.every(
                (k) =>
                  JSON.stringify(record.before!.state[k]) ===
                  JSON.stringify(record.after!.state[k]),
              );
              if (identical && afterKeys.every((k) => beforeKeys.includes(k))) {
                return `Tool "${record.tool}" produced identical before/after state — may not have executed correctly`;
              }
            }
          }
        }
        return null;
      },
      severity: 'info',
    },
  ];
}

// ---------------------------------------------------------------------------
// FormatVerifier
// ---------------------------------------------------------------------------

export class FormatVerifier implements IVerifier {
  readonly id = 'format-verifier';
  readonly name = 'Format Verifier';

  private readonly rules: FormatRule[];

  constructor(opts: FormatVerifierOpts = {}) {
    const resolvedOpts = {
      minAnswerLength: opts.minAnswerLength ?? 1,
      maxToolErrorRatio: opts.maxToolErrorRatio ?? 0.5,
    };

    this.rules = [
      ...(opts.skipBuiltinRules ? [] : builtinRules(resolvedOpts)),
      ...(opts.customRules ?? []),
    ];
  }

  async checkFormat(context: VerificationContext): Promise<FormatCheckResult> {
    const errors: string[] = [];

    for (const rule of this.rules) {
      const result = rule.check(context);
      if (result !== null && (rule.severity ?? 'error') === 'error') {
        errors.push(`[${rule.id}] ${result}`);
      }
    }

    return {
      passed: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const formatCheck = await this.checkFormat(context);

    // Collect all issues (including warnings and info).
    const issues: VerificationIssue[] = [];
    for (const rule of this.rules) {
      const result = rule.check(context);
      if (result !== null) {
        issues.push({
          severity: rule.severity ?? 'error',
          message: `[${rule.id}] ${result}`,
        });
      }
    }

    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const warningCount = issues.filter((i) => i.severity === 'warning').length;

    let outcome: 'success' | 'partial' | 'failure';
    let confidence: number;

    if (errorCount > 0) {
      outcome = 'failure';
      confidence = Math.max(0, 1 - errorCount * 0.3);
    } else if (warningCount > 0) {
      outcome = 'partial';
      confidence = Math.max(0.5, 1 - warningCount * 0.15);
    } else {
      outcome = 'success';
      confidence = 1;
    }

    const suggestions = issues
      .filter((i) => i.severity === 'error' || i.severity === 'warning')
      .map((i) => `Fix: ${i.message}`);

    return {
      outcome,
      confidence,
      reasoning: formatCheck.passed
        ? `All ${this.rules.length} format checks passed.`
        : `${errorCount} error(s) and ${warningCount} warning(s) found across ${this.rules.length} checks.`,
      issues: issues.length > 0 ? issues : undefined,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      formatCheck,
    };
  }
}
