/**
 * @ch4p/skills — Skill discovery, loading, and registry.
 *
 * Skills are curated instruction sets (SKILL.md files) with YAML frontmatter
 * manifests that the agent loads on-demand via progressive disclosure.
 * Compatible with the Agent Skills specification and the OpenClaw skill format.
 */

export type { SkillManifest, Skill, ParseResult } from './types.js';
export { SkillParseError } from './types.js';
export { parseSkillManifest } from './parser.js';
export { loadSkill, discoverSkills } from './loader.js';
export { SkillRegistry } from './registry.js';
