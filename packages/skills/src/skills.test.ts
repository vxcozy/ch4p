/**
 * Comprehensive test suite for the @ch4p/skills package.
 *
 * Covers three modules:
 *   - parser.ts  -- parseSkillManifest() YAML frontmatter parsing & validation
 *   - loader.ts  -- loadSkill() / discoverSkills() filesystem operations
 *   - registry.ts -- SkillRegistry in-memory skill management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSkillManifest } from './parser.js';
import { loadSkill, discoverSkills } from './loader.js';
import { SkillRegistry } from './registry.js';
import { SkillParseError } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a skill directory with a SKILL.md file inside it. */
function createSkillDir(basePath: string, name: string, content: string): string {
  const dir = join(basePath, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8');
  return dir;
}

/** Generate a unique temporary directory path for test isolation. */
function makeTmpDir(): string {
  const dir = join(tmpdir(), `ch4p-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for unit testing.
license: MIT
compatibility: ["claude", "copilot"]
metadata:
  author: tester
  version: "1.0.0"
---

# Test Skill

This is the skill body content.`;

const MINIMAL_SKILL_MD = `---
name: minimal
description: A minimal skill.
---

Body text.`;

// ===========================================================================
// Parser tests
// ===========================================================================

describe('parseSkillManifest', () => {
  // -------------------------------------------------------------------------
  // Valid inputs
  // -------------------------------------------------------------------------

  it('parses valid SKILL.md with all fields', () => {
    const result = parseSkillManifest(VALID_SKILL_MD);
    expect(result).toBeDefined();
    expect(result.manifest).toBeDefined();
    expect(result.body).toBeDefined();
  });

  it('extracts name correctly', () => {
    const { manifest } = parseSkillManifest(VALID_SKILL_MD);
    expect(manifest.name).toBe('test-skill');
  });

  it('extracts description correctly', () => {
    const { manifest } = parseSkillManifest(VALID_SKILL_MD);
    expect(manifest.description).toBe('A test skill for unit testing.');
  });

  it('extracts optional license', () => {
    const { manifest } = parseSkillManifest(VALID_SKILL_MD);
    expect(manifest.license).toBe('MIT');
  });

  it('extracts compatibility array', () => {
    const { manifest } = parseSkillManifest(VALID_SKILL_MD);
    expect(manifest.compatibility).toEqual(['claude', 'copilot']);
  });

  it('extracts nested metadata object', () => {
    const { manifest } = parseSkillManifest(VALID_SKILL_MD);
    expect(manifest.metadata).toEqual({ author: 'tester', version: '1.0.0' });
  });

  it('extracts markdown body correctly', () => {
    const { body } = parseSkillManifest(VALID_SKILL_MD);
    expect(body).toContain('# Test Skill');
    expect(body).toContain('This is the skill body content.');
  });

  it('handles multiline description with | block scalar', () => {
    const content = `---
name: multi-desc
description: |
  This is a multiline
  description that spans
  multiple lines.
---

Body.`;
    const { manifest } = parseSkillManifest(content);
    expect(manifest.description).toContain('This is a multiline');
    expect(manifest.description).toContain('description that spans');
    expect(manifest.description).toContain('multiple lines.');
  });

  it('handles minimal manifest (name + description only)', () => {
    const { manifest } = parseSkillManifest(MINIMAL_SKILL_MD);
    expect(manifest.name).toBe('minimal');
    expect(manifest.description).toBe('A minimal skill.');
    expect(manifest.license).toBeUndefined();
    expect(manifest.compatibility).toBeUndefined();
    expect(manifest.metadata).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Invalid inputs
  // -------------------------------------------------------------------------

  it('throws SkillParseError on missing frontmatter (no ---)', () => {
    const content = `name: bad
description: No delimiters.

Body here.`;
    expect(() => parseSkillManifest(content)).toThrow(SkillParseError);
  });

  it('throws SkillParseError on unclosed frontmatter', () => {
    const content = `---
name: unclosed
description: Oops no closing delimiter.

Body here.`;
    expect(() => parseSkillManifest(content)).toThrow(SkillParseError);
  });

  it('throws SkillParseError on invalid name (uppercase)', () => {
    const content = `---
name: TestSkill
description: Invalid uppercase name.
---

Body.`;
    expect(() => parseSkillManifest(content)).toThrow(SkillParseError);
  });

  it('throws SkillParseError on invalid name (spaces)', () => {
    const content = `---
name: test skill
description: Invalid name with spaces.
---

Body.`;
    expect(() => parseSkillManifest(content)).toThrow(SkillParseError);
  });

  it('throws SkillParseError on name too long (65+ chars)', () => {
    const longName = 'a'.repeat(65);
    const content = `---
name: ${longName}
description: Name is too long.
---

Body.`;
    expect(() => parseSkillManifest(content)).toThrow(SkillParseError);
  });

  it('throws SkillParseError on empty description', () => {
    const content = `---
name: empty-desc
description:
---

Body.`;
    expect(() => parseSkillManifest(content)).toThrow(SkillParseError);
  });

  it('includes filePath in SkillParseError when provided', () => {
    const content = `---
name: Bad Name
description: Invalid.
---

Body.`;
    try {
      parseSkillManifest(content, '/some/path/SKILL.md');
      expect.fail('Expected SkillParseError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SkillParseError);
      expect((err as SkillParseError).path).toBe('/some/path/SKILL.md');
    }
  });
});

// ===========================================================================
// Loader tests
// ===========================================================================

describe('loadSkill', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a Skill object from a valid directory', () => {
    const skillDir = createSkillDir(tmpDir, 'test-skill', VALID_SKILL_MD);
    const skill = loadSkill(skillDir);

    expect(skill).not.toBeNull();
    expect(skill!.manifest.name).toBe('test-skill');
    expect(skill!.manifest.description).toBe('A test skill for unit testing.');
    expect(skill!.body).toContain('# Test Skill');
    expect(skill!.path).toBe(join(skillDir, 'SKILL.md'));
  });

  it('returns null when no SKILL.md exists in the directory', () => {
    const emptyDir = join(tmpDir, 'empty-dir');
    mkdirSync(emptyDir, { recursive: true });

    const skill = loadSkill(emptyDir);
    expect(skill).toBeNull();
  });

  it('throws SkillParseError when directory name does not match manifest name', () => {
    // Directory named "wrong-name" but manifest says name: test-skill
    const skillDir = createSkillDir(tmpDir, 'wrong-name', VALID_SKILL_MD);

    expect(() => loadSkill(skillDir)).toThrow(SkillParseError);
  });
});

describe('discoverSkills', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds skills across multiple search directories', () => {
    const searchDir1 = join(tmpDir, 'global');
    const searchDir2 = join(tmpDir, 'project');
    mkdirSync(searchDir1, { recursive: true });
    mkdirSync(searchDir2, { recursive: true });

    createSkillDir(searchDir1, 'skill-alpha', `---
name: skill-alpha
description: Alpha skill.
---

Alpha body.`);

    createSkillDir(searchDir2, 'skill-beta', `---
name: skill-beta
description: Beta skill.
---

Beta body.`);

    const skills = discoverSkills([searchDir1, searchDir2]);
    const names = skills.map((s) => s.manifest.name);

    expect(names).toContain('skill-alpha');
    expect(names).toContain('skill-beta');
    expect(skills.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for nonexistent search paths', () => {
    const skills = discoverSkills(['/nonexistent/path/abc123', '/also/does-not-exist']);
    expect(skills).toEqual([]);
  });

  it('later paths override earlier paths when skill names collide', () => {
    const globalDir = join(tmpDir, 'global');
    const projectDir = join(tmpDir, 'project');
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    createSkillDir(globalDir, 'my-skill', `---
name: my-skill
description: Global version.
---

Global body.`);

    createSkillDir(projectDir, 'my-skill', `---
name: my-skill
description: Project version (override).
---

Project body.`);

    const skills = discoverSkills([globalDir, projectDir]);
    const mySkill = skills.find((s) => s.manifest.name === 'my-skill');

    expect(mySkill).toBeDefined();
    expect(mySkill!.manifest.description).toBe('Project version (override).');
    expect(mySkill!.body).toContain('Project body.');
  });

  it('skips non-directory entries in search paths', () => {
    const searchDir = join(tmpDir, 'with-file');
    mkdirSync(searchDir, { recursive: true });

    // Create a regular file (not a directory) alongside a valid skill dir
    writeFileSync(join(searchDir, 'not-a-dir.txt'), 'just a file');
    createSkillDir(searchDir, 'real-skill', `---
name: real-skill
description: A real skill.
---

Body.`);

    const skills = discoverSkills([searchDir]);
    const names = skills.map((s) => s.manifest.name);

    expect(names).toContain('real-skill');
    // Should not crash or include the file entry
    expect(names).not.toContain('not-a-dir.txt');
  });

  it('skips invalid manifests silently without throwing', () => {
    const searchDir = join(tmpDir, 'mixed');
    mkdirSync(searchDir, { recursive: true });

    // Valid skill
    createSkillDir(searchDir, 'good-skill', `---
name: good-skill
description: A valid skill.
---

Good body.`);

    // Invalid skill (uppercase name)
    createSkillDir(searchDir, 'BadSkill', `---
name: BadSkill
description: Invalid name.
---

Bad body.`);

    const skills = discoverSkills([searchDir]);
    const names = skills.map((s) => s.manifest.name);

    expect(names).toContain('good-skill');
    expect(names).not.toContain('BadSkill');
  });
});

// ===========================================================================
// Registry tests
// ===========================================================================

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  // Helper to build a Skill object for registration
  function makeSkill(name: string, description = `Description for ${name}`, body = `Body of ${name}.`) {
    return {
      manifest: { name, description },
      body,
      path: `/fake/path/${name}/SKILL.md`,
      source: 'project' as const,
    };
  }

  it('registers and retrieves a skill', () => {
    const skill = makeSkill('my-tool');
    registry.register(skill);

    const retrieved = registry.get('my-tool');
    expect(retrieved).toBeDefined();
    expect(retrieved!.manifest.name).toBe('my-tool');
    expect(retrieved!.body).toBe('Body of my-tool.');
  });

  it('throws SkillParseError on duplicate name registration', () => {
    const skill1 = makeSkill('dup-skill');
    const skill2 = makeSkill('dup-skill', 'Different description');

    registry.register(skill1);
    expect(() => registry.register(skill2)).toThrow(SkillParseError);
  });

  it('get() returns undefined for a missing skill', () => {
    const result = registry.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('has() returns true for registered and false for missing skills', () => {
    const skill = makeSkill('check-has');
    registry.register(skill);

    expect(registry.has('check-has')).toBe(true);
    expect(registry.has('not-registered')).toBe(false);
  });

  it('list() returns all registered skills', () => {
    registry.register(makeSkill('alpha'));
    registry.register(makeSkill('beta'));
    registry.register(makeSkill('gamma'));

    const allSkills = registry.list();
    expect(allSkills).toHaveLength(3);

    const names = allSkills.map((s) => s.manifest.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toContain('gamma');
  });

  it('names() returns all registered skill names', () => {
    registry.register(makeSkill('first'));
    registry.register(makeSkill('second'));

    const nameList = registry.names();
    expect(nameList).toContain('first');
    expect(nameList).toContain('second');
    expect(nameList).toHaveLength(2);
  });

  it('unregister() removes a skill', () => {
    registry.register(makeSkill('removable'));
    expect(registry.has('removable')).toBe(true);

    registry.unregister('removable');
    expect(registry.has('removable')).toBe(false);
    expect(registry.get('removable')).toBeUndefined();
  });

  it('getDescriptions() returns name and description pairs', () => {
    registry.register(makeSkill('desc-a', 'Description A'));
    registry.register(makeSkill('desc-b', 'Description B'));

    const descriptions = registry.getDescriptions();
    expect(descriptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'desc-a', description: 'Description A' }),
        expect.objectContaining({ name: 'desc-b', description: 'Description B' }),
      ]),
    );
    expect(descriptions).toHaveLength(2);
  });

  it('getSkillContext() returns body for existing skill and undefined for missing', () => {
    registry.register(makeSkill('ctx-skill', 'Desc', 'The context body.'));

    expect(registry.getSkillContext('ctx-skill')).toBe('The context body.');
    expect(registry.getSkillContext('no-such-skill')).toBeUndefined();
  });

  it('size property reflects the number of registered skills', () => {
    expect(registry.size).toBe(0);

    registry.register(makeSkill('one'));
    expect(registry.size).toBe(1);

    registry.register(makeSkill('two'));
    expect(registry.size).toBe(2);

    registry.unregister('one');
    expect(registry.size).toBe(1);
  });

  it('createFromPaths() factory creates a populated registry', () => {
    // Use a real temp directory with valid skill files
    const tmpDir = makeTmpDir();
    try {
      const searchDir = join(tmpDir, 'search');
      mkdirSync(searchDir, { recursive: true });

      createSkillDir(searchDir, 'factory-skill', `---
name: factory-skill
description: Created via factory.
---

Factory body.`);

      const populated = SkillRegistry.createFromPaths([searchDir]);
      expect(populated.has('factory-skill')).toBe(true);
      expect(populated.size).toBeGreaterThanOrEqual(1);

      const skill = populated.get('factory-skill');
      expect(skill).toBeDefined();
      expect(skill!.manifest.description).toBe('Created via factory.');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
