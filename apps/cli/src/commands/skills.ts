/**
 * Skills command — list, show, and verify installed skills.
 *
 * Usage:
 *   ch4p skills              List all discovered skills
 *   ch4p skills list         List all discovered skills
 *   ch4p skills show <name>  Display full SKILL.md content
 *   ch4p skills verify       Validate all skill manifests
 *   ch4p skills verify <name> Validate a specific skill manifest
 */

import { SkillRegistry } from '@ch4p/skills';
import { loadConfig } from '../config.js';

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadSkillRegistry(): SkillRegistry {
  const config = loadConfig();
  if (!config.skills?.enabled) {
    console.log(`  ${DIM}Skills are disabled in configuration.${RESET}`);
    return new SkillRegistry();
  }
  return SkillRegistry.createFromPaths(config.skills.paths);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function listSkills(): void {
  const registry = loadSkillRegistry();
  const allSkills = registry.list();

  if (allSkills.length === 0) {
    console.log(`\n  ${DIM}No skills found.${RESET}`);
    console.log(`  ${DIM}Skills are loaded from: ~/.ch4p/skills, .ch4p/skills, .agents/skills${RESET}\n`);
    return;
  }

  console.log(`\n  ${BOLD}Installed Skills${RESET} ${DIM}(${allSkills.length})${RESET}\n`);

  for (const skill of allSkills) {
    const sourceTag =
      skill.source === 'global' ? `${DIM}[global]${RESET}` :
      skill.source === 'legacy' ? `${YELLOW}[legacy]${RESET}` :
      `${GREEN}[project]${RESET}`;

    console.log(`  ${CYAN}${skill.manifest.name}${RESET} ${sourceTag}`);
    console.log(`    ${DIM}${skill.manifest.description}${RESET}`);
    if (skill.manifest.license) {
      console.log(`    ${DIM}License: ${skill.manifest.license}${RESET}`);
    }
  }
  console.log('');
}

function showSkill(name: string): void {
  const registry = loadSkillRegistry();
  const skill = registry.get(name);

  if (!skill) {
    console.error(`\n  ${RED}Skill not found:${RESET} ${name}`);
    console.error(`  ${DIM}Run ${CYAN}ch4p skills${DIM} to list available skills.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  ${BOLD}${skill.manifest.name}${RESET} ${DIM}(${skill.source})${RESET}`);
  console.log(`  ${DIM}Path: ${skill.path}${RESET}`);
  console.log(`  ${DIM}${'─'.repeat(60)}${RESET}\n`);
  console.log(skill.body);
  console.log('');
}

function verifySkills(name?: string): void {
  const config = loadConfig();
  const paths = config.skills?.paths ?? ['~/.ch4p/skills', '.ch4p/skills', '.agents/skills'];

  console.log(`\n  ${BOLD}Verifying Skills${RESET}\n`);

  let passed = 0;
  let failed = 0;

  if (name) {
    // Verify a specific skill
    const registry = loadSkillRegistry();
    const skill = registry.get(name);

    if (!skill) {
      console.error(`  ${RED}✗${RESET} Skill not found: ${name}`);
      process.exitCode = 1;
      return;
    }

    console.log(`  ${GREEN}✓${RESET} ${skill.manifest.name} — valid`);
    passed = 1;
  } else {
    // Verify all skills by attempting to load them
    try {
      const registry = SkillRegistry.createFromPaths(paths);
      for (const skill of registry.list()) {
        console.log(`  ${GREEN}✓${RESET} ${skill.manifest.name} — valid`);
        passed++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ${RED}✗${RESET} Error: ${message}`);
      failed++;
    }
  }

  console.log(`\n  ${DIM}Results: ${passed} passed, ${failed} failed${RESET}\n`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function skills(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'list';

  switch (subcommand) {
    case 'list':
      listSkills();
      break;

    case 'show': {
      const name = args[1];
      if (!name) {
        console.error(`\n  ${RED}Usage:${RESET} ch4p skills show <name>\n`);
        process.exitCode = 1;
        return;
      }
      showSkill(name);
      break;
    }

    case 'verify':
      verifySkills(args[1]);
      break;

    default:
      console.error(`\n  ${YELLOW}Unknown skills subcommand:${RESET} ${subcommand}`);
      console.error(`  ${DIM}Available: list, show, verify${RESET}\n`);
      process.exitCode = 1;
      break;
  }
}
