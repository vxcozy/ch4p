/**
 * LoadSkill tool — on-demand skill loading for progressive disclosure.
 *
 * The agent sees skill names + descriptions in its system prompt. When it
 * determines a skill is relevant, it calls this tool with the skill name
 * to receive the full markdown instruction body. The body is returned as
 * the tool result, naturally injecting the instructions into the
 * conversation context for the LLM to follow.
 *
 * This implements the "progressive disclosure" pattern from the Agent Skills
 * specification: the agent knows *what* skills exist (via system prompt)
 * but only loads *how* to use them when needed.
 */

import type {
  ITool,
  ToolContext,
  ToolResult,
  ValidationResult,
  JSONSchema7,
} from '@ch4p/core';

/**
 * Minimal interface for a skill registry.
 * Uses duck typing so we don't create a circular dependency on @ch4p/skills.
 */
export interface SkillProvider {
  has(name: string): boolean;
  names(): string[];
  getSkillContext(name: string): string | undefined;
}

interface LoadSkillArgs {
  name: string;
}

export class LoadSkillTool implements ITool {
  readonly name = 'load_skill';
  readonly description =
    'Load a skill by name to receive detailed instructions. ' +
    'Use this when you need the full instructions for a skill listed in your system prompt. ' +
    'The skill body will be returned as markdown instructions to follow.';

  readonly weight = 'lightweight' as const;

  readonly parameters: JSONSchema7 = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'The skill name to load (kebab-case, e.g., "code-review", "test-runner").',
        minLength: 1,
        maxLength: 64,
      },
    },
    required: ['name'],
    additionalProperties: false,
  };

  private readonly provider: SkillProvider;

  constructor(provider: SkillProvider) {
    this.provider = provider;
  }

  validate(args: unknown): ValidationResult {
    if (typeof args !== 'object' || args === null) {
      return { valid: false, errors: ['Arguments must be an object.'] };
    }

    const { name } = args as Record<string, unknown>;
    const errors: string[] = [];

    if (typeof name !== 'string' || name.trim().length === 0) {
      errors.push('`name` is required and must be a non-empty string.');
    }

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    const { name } = args as LoadSkillArgs;
    const trimmedName = name.trim();

    if (!this.provider.has(trimmedName)) {
      const available = this.provider.names();
      const suggestion = available.length > 0
        ? `Available skills: ${available.join(', ')}`
        : 'No skills are currently loaded.';

      return {
        success: false,
        output: '',
        error: `Skill "${trimmedName}" not found. ${suggestion}`,
      };
    }

    const body = this.provider.getSkillContext(trimmedName);
    if (!body) {
      return {
        success: false,
        output: '',
        error: `Skill "${trimmedName}" exists but has no content.`,
      };
    }

    return {
      success: true,
      output: `# Skill: ${trimmedName}\n\n${body}`,
      metadata: {
        skillName: trimmedName,
        bodyLength: body.length,
      },
    };
  }
}
