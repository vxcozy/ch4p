/**
 * Skill system types — Agent Skills specification compatible.
 *
 * Skills are curated instruction sets (SKILL.md files with YAML frontmatter)
 * loaded on-demand via progressive disclosure. Compatible with the OpenClaw
 * skill format and the Agent Skills specification (agentskills.io).
 */

/** Parsed YAML frontmatter from a SKILL.md file. */
export interface SkillManifest {
  /** Skill name in kebab-case. 1-64 chars, regex: ^[a-z0-9]+(-[a-z0-9]+)*$ */
  name: string;
  /** Human-readable description. 1-1024 chars. Used for progressive disclosure. */
  description: string;
  /** SPDX license identifier (optional). */
  license?: string;
  /** Agent compatibility list (optional). e.g., ["claude", "copilot"] */
  compatibility?: string[];
  /** Arbitrary key-value metadata (optional). */
  metadata?: Record<string, string>;
}

/** A fully loaded skill with parsed manifest and markdown body. */
export interface Skill {
  /** Parsed frontmatter fields. */
  manifest: SkillManifest;
  /** Markdown instruction body (everything after closing ---). */
  body: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Where this skill was loaded from. */
  source: 'global' | 'project' | 'legacy';
}

/** Result of parsing a SKILL.md file. */
export interface ParseResult {
  manifest: SkillManifest;
  body: string;
}

/** Validation error from skill manifest parsing. */
export class SkillParseError extends Error {
  constructor(message: string, public readonly path?: string) {
    super(message);
    this.name = 'SkillParseError';
  }
}
