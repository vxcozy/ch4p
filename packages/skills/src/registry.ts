/**
 * Skill registry — manages loaded skills and provides progressive disclosure.
 *
 * Mirrors the ToolRegistry pattern from @ch4p/tools but for skill manifests.
 * Skills are not tools — they are instruction sets loaded into agent context
 * on-demand when the agent determines a skill is relevant.
 */

import type { Skill } from './types.js';
import { SkillParseError } from './types.js';
import { discoverSkills } from './loader.js';

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  /**
   * Register a skill. Throws if a skill with the same name is already registered.
   */
  register(skill: Skill): void {
    if (this.skills.has(skill.manifest.name)) {
      throw new SkillParseError(
        `Skill "${skill.manifest.name}" is already registered.`,
        skill.path,
      );
    }
    this.skills.set(skill.manifest.name, skill);
  }

  /**
   * Get a skill by name. Returns undefined if not found.
   */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Check whether a skill is registered.
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * List all registered skills.
   */
  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * List skill names.
   */
  names(): string[] {
    return Array.from(this.skills.keys());
  }

  /**
   * Unregister a skill by name. Returns true if removed, false if not found.
   */
  unregister(name: string): boolean {
    return this.skills.delete(name);
  }

  /**
   * Get skill descriptions for system prompt injection.
   * Returns name + description pairs for progressive disclosure.
   */
  getDescriptions(): { name: string; description: string }[] {
    return this.list().map((skill) => ({
      name: skill.manifest.name,
      description: skill.manifest.description,
    }));
  }

  /**
   * Get the full markdown body for a skill (on-demand loading).
   * Returns the instruction content that gets injected into context
   * when the agent determines a skill is relevant.
   */
  getSkillContext(name: string): string | undefined {
    return this.skills.get(name)?.body;
  }

  /**
   * Get the count of registered skills.
   */
  get size(): number {
    return this.skills.size;
  }

  /**
   * Create a registry by discovering skills from search paths.
   *
   * Scans directories for SKILL.md files, parses manifests, and registers
   * all valid skills. Invalid manifests are silently skipped.
   */
  static createFromPaths(searchPaths: string[]): SkillRegistry {
    const registry = new SkillRegistry();
    const skills = discoverSkills(searchPaths);
    for (const skill of skills) {
      registry.register(skill);
    }
    return registry;
  }
}
