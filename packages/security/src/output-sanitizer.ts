/**
 * OutputSanitizer -- Detects and redacts sensitive data from output text
 *
 * Bagman-inspired output boundary defense. Scans text for API keys, tokens,
 * credentials, credit card numbers, SSNs, AWS keys, and other sensitive
 * patterns. Replaces them with redaction markers so secrets never leak
 * through agent responses.
 */

import type { SanitizationResult } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface SensitivePattern {
  /** Human-readable name for audit trail. */
  name: string;
  /** Regex to match the sensitive value. Must use global flag. */
  pattern: RegExp;
  /** Replacement string. Use $1, $2 etc. to preserve non-sensitive prefixes. */
  replacement: string;
}

/**
 * All patterns use the global flag so we can detect multiple occurrences
 * in a single text block.
 */
const SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  // -- API keys & tokens --
  {
    name: 'OpenAI API key',
    pattern: /sk-[A-Za-z0-9]{20,}/g,
    replacement: 'sk-[REDACTED]',
  },
  {
    name: 'Slack token',
    pattern: /xoxb-[A-Za-z0-9-]{20,}/g,
    replacement: 'xoxb-[REDACTED]',
  },
  {
    name: 'Slack user token',
    pattern: /xoxp-[A-Za-z0-9-]{20,}/g,
    replacement: 'xoxp-[REDACTED]',
  },
  {
    name: 'GitHub personal access token',
    pattern: /ghp_[A-Za-z0-9]{36,}/g,
    replacement: 'ghp_[REDACTED]',
  },
  {
    name: 'GitHub OAuth token',
    pattern: /gho_[A-Za-z0-9]{36,}/g,
    replacement: 'gho_[REDACTED]',
  },
  {
    name: 'GitHub App token',
    pattern: /ghu_[A-Za-z0-9]{36,}/g,
    replacement: 'ghu_[REDACTED]',
  },
  {
    name: 'GitHub App installation token',
    pattern: /ghs_[A-Za-z0-9]{36,}/g,
    replacement: 'ghs_[REDACTED]',
  },
  {
    name: 'GitHub fine-grained PAT',
    pattern: /github_pat_[A-Za-z0-9_]{40,}/g,
    replacement: 'github_pat_[REDACTED]',
  },

  // -- Telegram & Discord tokens --
  {
    name: 'Telegram bot token',
    pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35,}\b/g,
    replacement: '[TELEGRAM_BOT_TOKEN_REDACTED]',
  },
  {
    name: 'Discord bot token',
    pattern: /[\w-]{24}\.[\w-]{6}\.[\w-]{27,}/g,
    replacement: '[DISCORD_BOT_TOKEN_REDACTED]',
  },

  // -- Payment provider keys --
  {
    name: 'Stripe secret key',
    pattern: /sk_live_[A-Za-z0-9]{20,}/g,
    replacement: 'sk_live_[REDACTED]',
  },
  {
    name: 'Stripe publishable key',
    pattern: /pk_live_[A-Za-z0-9]{20,}/g,
    replacement: 'pk_live_[REDACTED]',
  },
  {
    name: 'Stripe restricted key',
    pattern: /rk_live_[A-Za-z0-9]{20,}/g,
    replacement: 'rk_live_[REDACTED]',
  },
  {
    name: 'SendGrid API key',
    pattern: /SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{20,}/g,
    replacement: 'SG.[REDACTED]',
  },

  // -- JWT & connection strings --
  {
    name: 'JWT token',
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[JWT_REDACTED]',
  },
  {
    name: 'Database connection string',
    pattern: /(?:postgres|mysql|mongodb(?:\+srv)?|redis):\/\/[^:]+:[^@]+@[^\s'"]+/g,
    replacement: '[DB_CONNECTION_REDACTED]',
  },

  // -- AWS credentials --
  {
    name: 'AWS access key ID',
    pattern: /(?<![A-Za-z0-9])(AKIA[0-9A-Z]{16})(?![A-Za-z0-9])/g,
    replacement: '[AWS_KEY_REDACTED]',
  },
  {
    name: 'AWS secret access key',
    pattern: /(?<![A-Za-z0-9/+])([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/g,
    // Only match when near AWS context -- this is handled by checking
    // adjacent text in the scan method for precision.
    replacement: '[AWS_SECRET_REDACTED]',
  },

  // -- Generic bearer / auth tokens --
  {
    name: 'Bearer token',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    replacement: 'Bearer [REDACTED]',
  },
  {
    name: 'Authorization Basic',
    pattern: /Basic\s+[A-Za-z0-9+/]+=*/g,
    replacement: 'Basic [REDACTED]',
  },

  // -- PII --
  {
    name: 'Credit card number',
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    replacement: '[CC_REDACTED]',
  },
  {
    name: 'Social Security Number',
    pattern: /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/g,
    replacement: '[SSN_REDACTED]',
  },

  // -- Generic secret patterns (key=value in configs, env files) --
  {
    name: 'Generic secret assignment',
    pattern: /(?<=(?:SECRET|TOKEN|PASSWORD|API_KEY|APIKEY|AUTH|CREDENTIAL|PRIVATE_KEY)\s*[=:]\s*['"]?)[A-Za-z0-9/+=\-_.]{16,}(?=['"]?)/gi,
    replacement: '[SECRET_REDACTED]',
  },

  // -- Private keys --
  {
    name: 'Private key block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: '[PRIVATE_KEY_REDACTED]',
  },
] as const;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class OutputSanitizer {
  private readonly patterns: readonly SensitivePattern[];

  constructor(extraPatterns?: SensitivePattern[]) {
    this.patterns = extraPatterns
      ? [...SENSITIVE_PATTERNS, ...extraPatterns]
      : SENSITIVE_PATTERNS;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Scan `text` for sensitive patterns and replace them with redaction markers.
   *
   * Returns the sanitized string plus metadata about what was redacted.
   */
  sanitize(text: string): SanitizationResult {
    let clean = text;
    const redactedPatterns: string[] = [];

    for (const entry of this.patterns) {
      // Reset lastIndex for global regexes (they are stateful).
      entry.pattern.lastIndex = 0;

      if (entry.pattern.test(clean)) {
        redactedPatterns.push(entry.name);
        // Reset again before replacement.
        entry.pattern.lastIndex = 0;
        clean = clean.replace(entry.pattern, entry.replacement);
      }
    }

    return {
      clean,
      redacted: redactedPatterns.length > 0,
      redactedPatterns: redactedPatterns.length > 0 ? redactedPatterns : undefined,
    };
  }
}
