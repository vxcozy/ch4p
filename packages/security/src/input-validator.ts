/**
 * InputValidator -- Prompt injection & adversarial input detection
 *
 * Bagman-inspired input boundary defense. Detects prompt injection,
 * jailbreak attempts, role manipulation, data exfiltration patterns,
 * and Unicode-based obfuscation (homoglyphs, invisible characters).
 *
 * Supports multi-turn tracking via ConversationContext to detect
 * escalating attack patterns across a conversation.
 */

import type {
  InputValidationResult,
  ThreatDetection,
  ConversationContext,
} from '@ch4p/core';

// ---------------------------------------------------------------------------
// Threat pattern definitions
// ---------------------------------------------------------------------------

interface ThreatPattern {
  type: ThreatDetection['type'];
  pattern: RegExp;
  severity: ThreatDetection['severity'];
  description: string;
}

// -- Prompt injection patterns --

const INJECTION_PATTERNS: readonly ThreatPattern[] = [
  {
    type: 'injection',
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts|rules|directions)/i,
    severity: 'critical',
    description: 'Attempt to override system instructions via "ignore previous" pattern',
  },
  {
    type: 'injection',
    pattern: /(?:new|updated|revised)\s+(?:system\s+)?(?:instructions|prompt|rules)\s*:/i,
    severity: 'high',
    description: 'Attempt to inject new system instructions',
  },
  {
    type: 'injection',
    pattern: /system\s*(?:prompt|message|instruction)\s*:/i,
    severity: 'critical',
    description: 'Direct system prompt injection attempt',
  },
  {
    type: 'injection',
    pattern: /\[INST\]|\[\/INST\]|<\|(?:im_start|im_end|system|user|assistant)\|>/i,
    severity: 'critical',
    description: 'Chat template delimiter injection (model-specific control tokens)',
  },
  {
    type: 'injection',
    pattern: /(?:forget|disregard|override|bypass|skip)\s+(?:your|all|the|any)\s+(?:rules|instructions|guidelines|constraints|safety|guardrails)/i,
    severity: 'critical',
    description: 'Attempt to bypass safety constraints',
  },
  {
    type: 'injection',
    pattern: /(?:you\s+(?:must|should|will|have\s+to)\s+)?(?:always|now)\s+(?:respond|answer|reply)\s+(?:with|as|in)/i,
    severity: 'medium',
    description: 'Attempt to force specific response behavior',
  },
] as const;

// -- Jailbreak patterns --

const JAILBREAK_PATTERNS: readonly ThreatPattern[] = [
  {
    type: 'jailbreak',
    pattern: /\bD\.?A\.?N\.?\b/i,
    severity: 'critical',
    description: 'DAN (Do Anything Now) jailbreak attempt',
  },
  {
    type: 'jailbreak',
    pattern: /developer\s+mode\s+(?:enabled|on|activated|active)/i,
    severity: 'critical',
    description: 'Developer mode activation jailbreak',
  },
  {
    type: 'jailbreak',
    pattern: /(?:enable|activate|enter|switch\s+to)\s+(?:unrestricted|unfiltered|uncensored|god)\s+mode/i,
    severity: 'critical',
    description: 'Unrestricted mode activation attempt',
  },
  {
    type: 'jailbreak',
    pattern: /(?:pretend|imagine|suppose|hypothetically)\s+(?:you\s+)?(?:have\s+)?(?:no|zero|without)\s+(?:restrictions|limitations|rules|filters|guardrails)/i,
    severity: 'high',
    description: 'Hypothetical scenario to remove restrictions',
  },
  {
    type: 'jailbreak',
    pattern: /(?:in\s+)?(?:this\s+)?(?:fictional|hypothetical|imaginary|roleplay)\s+(?:scenario|world|universe|context)/i,
    severity: 'medium',
    description: 'Fictional framing to bypass restrictions',
  },
] as const;

// -- Role manipulation patterns --

const ROLE_MANIPULATION_PATTERNS: readonly ThreatPattern[] = [
  {
    type: 'role_manipulation',
    pattern: /you\s+are\s+now\s+(?:a|an|the|my)\b/i,
    severity: 'high',
    description: 'Identity reassignment attempt',
  },
  {
    type: 'role_manipulation',
    pattern: /(?:act|behave|respond|function)\s+as\s+(?:a|an|the|if)\b/i,
    severity: 'medium',
    description: 'Role assumption directive',
  },
  {
    type: 'role_manipulation',
    pattern: /(?:your|the)\s+(?:new|real|true|actual)\s+(?:role|identity|purpose|name)\s+is/i,
    severity: 'high',
    description: 'Identity override attempt',
  },
  {
    type: 'role_manipulation',
    pattern: /(?:from\s+now\s+on|henceforth|going\s+forward)\s+(?:you\s+(?:are|will\s+be)|act\s+as)/i,
    severity: 'high',
    description: 'Persistent role change attempt',
  },
] as const;

// -- Extraction / exfiltration patterns --

const EXTRACTION_PATTERNS: readonly ThreatPattern[] = [
  {
    type: 'extraction',
    pattern: /(?:show|reveal|display|print|output|repeat|echo|tell\s+me)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions|rules|guidelines|context)/i,
    severity: 'high',
    description: 'System prompt extraction attempt',
  },
  {
    type: 'extraction',
    pattern: /(?:what|how)\s+(?:are|were)\s+(?:your|the)\s+(?:initial|original|system|hidden)\s+(?:instructions|prompt|rules)/i,
    severity: 'high',
    description: 'Inquiry about hidden instructions',
  },
] as const;

const EXFILTRATION_PATTERNS: readonly ThreatPattern[] = [
  {
    type: 'exfiltration',
    pattern: /curl\s+.*\|\s*/i,
    severity: 'high',
    description: 'Piped curl command (potential data exfiltration)',
  },
  {
    type: 'exfiltration',
    pattern: /(?:wget|curl|fetch|nc|ncat|netcat)\s+(?:https?:\/\/|ftp:\/\/)/i,
    severity: 'medium',
    description: 'External URL data transfer command',
  },
  {
    type: 'exfiltration',
    pattern: /(?:send|post|upload|transmit|exfil)\s+(?:to|data|the|this)\b.*(?:https?:\/\/|webhook|endpoint|server)/i,
    severity: 'high',
    description: 'Data exfiltration directive',
  },
  {
    type: 'exfiltration',
    pattern: /base64\s+(?:-[de]\s+)?.*\|\s*(?:curl|wget|nc)/i,
    severity: 'critical',
    description: 'Encoded data exfiltration via pipe',
  },
] as const;

// -- All patterns combined --

const ALL_THREAT_PATTERNS: readonly ThreatPattern[] = [
  ...INJECTION_PATTERNS,
  ...JAILBREAK_PATTERNS,
  ...ROLE_MANIPULATION_PATTERNS,
  ...EXTRACTION_PATTERNS,
  ...EXFILTRATION_PATTERNS,
] as const;

// ---------------------------------------------------------------------------
// Unicode / homoglyph detection
// ---------------------------------------------------------------------------

/**
 * Common Cyrillic/Greek/other homoglyphs that look like Latin characters.
 * Maps confusable codepoints to the Latin character they mimic.
 */
const HOMOGLYPH_MAP: ReadonlyMap<string, string> = new Map([
  // Cyrillic lookalikes
  ['\u0410', 'A'], // А
  ['\u0412', 'B'], // В
  ['\u0421', 'C'], // С
  ['\u0415', 'E'], // Е
  ['\u041D', 'H'], // Н
  ['\u041A', 'K'], // К
  ['\u041C', 'M'], // М
  ['\u041E', 'O'], // О
  ['\u0420', 'P'], // Р
  ['\u0422', 'T'], // Т
  ['\u0425', 'X'], // Х
  ['\u0430', 'a'], // а
  ['\u0435', 'e'], // е
  ['\u043E', 'o'], // о
  ['\u0440', 'p'], // р
  ['\u0441', 'c'], // с
  ['\u0443', 'y'], // у
  ['\u0445', 'x'], // х
  // Greek lookalikes
  ['\u0391', 'A'], // Α
  ['\u0392', 'B'], // Β
  ['\u0395', 'E'], // Ε
  ['\u0397', 'H'], // Η
  ['\u0399', 'I'], // Ι
  ['\u039A', 'K'], // Κ
  ['\u039C', 'M'], // Μ
  ['\u039D', 'N'], // Ν
  ['\u039F', 'O'], // Ο
  ['\u03A1', 'P'], // Ρ
  ['\u03A4', 'T'], // Τ
  ['\u03A5', 'Y'], // Υ
  ['\u03A7', 'X'], // Χ
  ['\u03BF', 'o'], // ο
]);

/**
 * Zero-width and invisible Unicode characters used for obfuscation.
 * Intentional combined/joined character sequences for security filtering.
 */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_CHARS: RegExp = /[\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\u2064\uFEFF\u00AD\u034F\u17B4\u17B5\u180E]/g;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class InputValidator {
  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Validate input text for adversarial patterns.
   *
   * Checks:
   * 1. Unicode normalization & homoglyph detection
   * 2. Invisible character detection
   * 3. Pattern-based threat scanning
   * 4. Multi-turn escalation tracking (if context provided)
   */
  validate(text: string, ctx?: ConversationContext): InputValidationResult {
    const threats: ThreatDetection[] = [];

    // ---- 1. Unicode / homoglyph analysis ----
    const homoglyphResult = this.detectHomoglyphs(text);
    if (homoglyphResult) {
      threats.push(homoglyphResult);
    }

    // ---- 2. Invisible character detection ----
    const invisibleResult = this.detectInvisibleChars(text);
    if (invisibleResult) {
      threats.push(invisibleResult);
    }

    // ---- 3. Normalize text, then scan patterns ----
    const normalized = this.normalizeText(text);

    for (const tp of ALL_THREAT_PATTERNS) {
      // Reset stateful regexes.
      tp.pattern.lastIndex = 0;
      if (tp.pattern.test(normalized)) {
        threats.push({
          type: tp.type,
          pattern: tp.pattern.source,
          severity: tp.severity,
          description: tp.description,
        });
      }
    }

    // ---- 4. Multi-turn context analysis ----
    if (ctx) {
      const contextThreats = this.analyzeConversationContext(normalized, ctx);
      threats.push(...contextThreats);
    }

    return {
      safe: threats.length === 0,
      threats,
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Normalize text for consistent pattern matching.
   * Strips invisible characters and normalizes Unicode to NFC.
   */
  private normalizeText(text: string): string {
    // Remove zero-width / invisible characters.
    let normalized = text.replace(INVISIBLE_CHARS, '');

    // Replace homoglyphs with their Latin equivalents.
    for (const [confusable, latin] of HOMOGLYPH_MAP) {
      // Using split/join instead of replaceAll for broader compatibility.
      normalized = normalized.split(confusable).join(latin);
    }

    // Unicode NFC normalization.
    normalized = normalized.normalize('NFC');

    return normalized;
  }

  /**
   * Detect the presence of homoglyph characters in the text.
   * Returns a ThreatDetection if confusables are found, otherwise null.
   */
  private detectHomoglyphs(text: string): ThreatDetection | null {
    const found: string[] = [];

    for (const [confusable, latin] of HOMOGLYPH_MAP) {
      if (text.includes(confusable)) {
        found.push(`U+${confusable.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} (looks like "${latin}")`);
      }
    }

    if (found.length === 0) {
      return null;
    }

    return {
      type: 'injection',
      pattern: 'homoglyph_detection',
      severity: 'medium',
      description: `Confusable Unicode characters detected: ${found.join(', ')}`,
    };
  }

  /**
   * Detect zero-width and invisible Unicode characters.
   */
  private detectInvisibleChars(text: string): ThreatDetection | null {
    // Reset the global regex.
    INVISIBLE_CHARS.lastIndex = 0;
    const matches = text.match(INVISIBLE_CHARS);

    if (!matches || matches.length === 0) {
      return null;
    }

    const codepoints = [...new Set(matches.map(
      ch => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
    ))];

    return {
      type: 'injection',
      pattern: 'invisible_characters',
      severity: 'medium',
      description: `Invisible Unicode characters detected (${matches.length} total): ${codepoints.join(', ')}`,
    };
  }

  /**
   * Analyze multi-turn conversation context for escalation patterns.
   *
   * Flags when:
   * - Multiple extraction attempts across turns
   * - Multiple override attempts across turns
   * - Sensitive keywords paired with extraction/override behavior
   */
  private analyzeConversationContext(
    normalizedText: string,
    ctx: ConversationContext,
  ): ThreatDetection[] {
    const threats: ThreatDetection[] = [];

    // Repeated extraction attempts across turns.
    if (ctx.extractionAttempts >= 3) {
      threats.push({
        type: 'extraction',
        pattern: 'multi_turn_extraction',
        severity: 'high',
        description: `Repeated extraction attempts detected (${ctx.extractionAttempts} across ${ctx.turnCount} turns)`,
      });
    }

    // Repeated override attempts across turns.
    if (ctx.overrideAttempts >= 2) {
      threats.push({
        type: 'injection',
        pattern: 'multi_turn_override',
        severity: 'critical',
        description: `Repeated instruction override attempts detected (${ctx.overrideAttempts} across ${ctx.turnCount} turns)`,
      });
    }

    // Check if current input mentions sensitive keywords tracked by context.
    if (ctx.sensitiveKeywords.size > 0) {
      const lowerText = normalizedText.toLowerCase();
      for (const keyword of ctx.sensitiveKeywords) {
        if (lowerText.includes(keyword.toLowerCase())) {
          threats.push({
            type: 'extraction',
            pattern: 'sensitive_keyword_probe',
            severity: 'medium',
            description: `Input references tracked sensitive keyword: "${keyword}"`,
          });
          // One match is enough to flag; avoid duplicate noise.
          break;
        }
      }
    }

    return threats;
  }
}
