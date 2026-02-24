/**
 * Skill loader — discovers and loads SKILL.md files from directories.
 *
 * Discovery paths (configurable):
 *   - ~/.ch4p/skills/{name}/SKILL.md  (global)
 *   - .ch4p/skills/{name}/SKILL.md    (project)
 *   - .agents/skills/{name}/SKILL.md  (legacy / OpenClaw compat)
 *
 * Project skills override global skills when names collide.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { Skill } from './types.js';
import { SkillParseError } from './types.js';
import { parseSkillManifest } from './parser.js';

/** Classify a path as global, project, or legacy. */
function classifySource(dirPath: string): 'global' | 'project' | 'legacy' {
  const home = homedir();
  if (dirPath.startsWith(resolve(home, '.ch4p'))) return 'global';
  if (dirPath.includes('.agents/skills')) return 'legacy';
  return 'project';
}

/** Resolve ~ to home directory. */
function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Load a single SKILL.md from a given directory path.
 *
 * @param skillDir — Absolute path to the skill directory (e.g., ~/.ch4p/skills/my-skill)
 * @returns The loaded Skill, or null if the directory has no valid SKILL.md.
 */
export function loadSkill(skillDir: string): Skill | null {
  const skillPath = join(skillDir, 'SKILL.md');

  if (!existsSync(skillPath)) return null;

  const content = readFileSync(skillPath, 'utf8');
  const { manifest, body } = parseSkillManifest(content, skillPath);

  // Validate directory name matches manifest name (case-insensitive for macOS/Windows).
  const dirName = basename(skillDir);
  if (dirName.toLowerCase() !== manifest.name.toLowerCase()) {
    throw new SkillParseError(
      `Directory name "${dirName}" does not match manifest name "${manifest.name}"`,
      skillPath,
    );
  }

  const source = classifySource(skillDir);

  return { manifest, body, path: skillPath, source };
}

/**
 * Discover all skills in a list of search directories.
 *
 * Each search directory should contain subdirectories named after skills,
 * each with a SKILL.md file inside.
 *
 * Later paths in the array take precedence (project overrides global).
 */
export function discoverSkills(searchPaths: string[]): Skill[] {
  const skillMap = new Map<string, Skill>();

  for (const rawPath of searchPaths) {
    const searchDir = expandTilde(rawPath);

    if (!existsSync(searchDir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(searchDir);
    } catch {
      continue; // Permission error, etc.
    }

    for (const entry of entries) {
      const fullPath = resolve(searchDir, entry);

      // Skip non-directories
      try {
        if (!statSync(fullPath).isDirectory()) continue;
      } catch {
        continue;
      }

      try {
        const skill = loadSkill(fullPath);
        if (skill) {
          // Later paths override earlier ones (project > global)
          skillMap.set(skill.manifest.name, skill);
        }
      } catch (err) {
        // Log but don't crash — skip invalid skills
        if (err instanceof SkillParseError) {
          // In production this would go to the observer
          // For now, silently skip invalid skills
        } else {
          // Re-throw unexpected errors
          throw err;
        }
      }
    }
  }

  return Array.from(skillMap.values());
}
