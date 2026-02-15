/**
 * SKILL.md parser — extracts YAML frontmatter and markdown body.
 *
 * Handles the Agent Skills specification format:
 *   ---
 *   name: skill-name
 *   description: |
 *     Multi-line description here.
 *   license: MIT
 *   compatibility: ["claude", "copilot"]
 *   metadata:
 *     author: someone
 *     version: "1.0.0"
 *   ---
 *
 *   # Skill body (markdown)
 *
 * Zero external dependencies — hand-parses the simple YAML subset
 * used in skill manifests.
 */

import type { SkillManifest, ParseResult } from './types.js';
import { SkillParseError } from './types.js';

/** Regex for valid skill names: lowercase alphanumeric with single hyphens. */
const NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Parse a SKILL.md file content string into manifest + body.
 */
export function parseSkillManifest(content: string, filePath?: string): ParseResult {
  const trimmed = content.trimStart();

  // Must start with ---
  if (!trimmed.startsWith('---')) {
    throw new SkillParseError(
      'SKILL.md must start with YAML frontmatter (---)',
      filePath,
    );
  }

  // Find closing ---
  const afterOpening = trimmed.slice(3);
  const closingIndex = afterOpening.indexOf('\n---');
  if (closingIndex === -1) {
    throw new SkillParseError(
      'SKILL.md frontmatter is missing closing ---',
      filePath,
    );
  }

  const yamlBlock = afterOpening.slice(0, closingIndex).trim();
  const body = afterOpening.slice(closingIndex + 4).trim(); // skip \n---

  // Parse YAML key-value pairs
  const manifest = parseYamlBlock(yamlBlock, filePath);

  // Validate required fields
  validateManifest(manifest, filePath);

  return { manifest, body };
}

/**
 * Hand-parse a simple YAML block into a SkillManifest.
 *
 * Supports:
 *   - Simple key: value pairs
 *   - Multi-line values with | (block scalar)
 *   - Inline arrays: ["a", "b"]
 *   - Nested objects (one level deep, for metadata)
 */
function parseYamlBlock(yaml: string, _filePath?: string): SkillManifest {
  const lines = yaml.split('\n');
  const result: Record<string, unknown> = {};

  let currentKey: string | null = null;
  let multilineValue = '';
  let inMultiline = false;
  let inNestedObject = false;
  let nestedKey: string | null = null;
  let nestedObj: Record<string, string> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Handle multi-line block scalar (|)
    if (inMultiline) {
      if (line.match(/^\s{2,}/) || line.trim() === '') {
        multilineValue += (multilineValue ? '\n' : '') + line.replace(/^\s{2,}/, '');
        continue;
      } else {
        // End of multi-line
        result[currentKey!] = multilineValue.trim();
        inMultiline = false;
        currentKey = null;
        multilineValue = '';
      }
    }

    // Handle nested object values (metadata section)
    if (inNestedObject) {
      const nestedMatch = line.match(/^\s{2,}(\w[\w-]*):\s*(.+)/);
      if (nestedMatch) {
        nestedObj[nestedMatch[1]!] = stripQuotes(nestedMatch[2]!.trim());
        continue;
      } else {
        // End of nested object — if empty, store as empty string (not {})
        result[nestedKey!] = Object.keys(nestedObj).length > 0 ? { ...nestedObj } : '';
        inNestedObject = false;
        nestedKey = null;
        nestedObj = {};
      }
    }

    // Skip empty lines
    if (line.trim() === '') continue;

    // Match top-level key: value
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (!kvMatch) continue;

    const key = kvMatch[1]!;
    const rawValue = kvMatch[2]!.trim();

    if (rawValue === '|') {
      // Block scalar — collect multi-line
      currentKey = key;
      inMultiline = true;
      multilineValue = '';
    } else if (rawValue === '') {
      // Empty value — could be start of nested object
      nestedKey = key;
      inNestedObject = true;
      nestedObj = {};
    } else if (rawValue.startsWith('[')) {
      // Inline array: ["a", "b", "c"]
      result[key] = parseInlineArray(rawValue);
    } else {
      // Simple value
      result[key] = stripQuotes(rawValue);
    }
  }

  // Flush any remaining multi-line or nested
  if (inMultiline && currentKey) {
    result[currentKey] = multilineValue.trim();
  }
  if (inNestedObject && nestedKey) {
    result[nestedKey] = Object.keys(nestedObj).length > 0 ? { ...nestedObj } : '';
  }

  return {
    name: String(result.name ?? ''),
    description: String(result.description ?? ''),
    license: result.license ? String(result.license) : undefined,
    compatibility: Array.isArray(result.compatibility)
      ? result.compatibility.map(String)
      : undefined,
    metadata: result.metadata && typeof result.metadata === 'object'
      ? result.metadata as Record<string, string>
      : undefined,
  };
}

/** Parse an inline YAML array: ["a", "b", "c"] */
function parseInlineArray(raw: string): string[] {
  const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map((item) => stripQuotes(item.trim()));
}

/** Strip surrounding quotes from a string value. */
function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Validate that a parsed manifest has valid required fields. */
function validateManifest(manifest: SkillManifest, filePath?: string): void {
  if (!manifest.name) {
    throw new SkillParseError('Skill manifest is missing required field: name', filePath);
  }

  if (!NAME_REGEX.test(manifest.name)) {
    throw new SkillParseError(
      `Invalid skill name "${manifest.name}": must be lowercase alphanumeric with hyphens (a-z, 0-9, -)`,
      filePath,
    );
  }

  if (manifest.name.length > MAX_NAME_LENGTH) {
    throw new SkillParseError(
      `Skill name "${manifest.name}" exceeds maximum length of ${MAX_NAME_LENGTH} characters`,
      filePath,
    );
  }

  if (!manifest.description) {
    throw new SkillParseError(
      'Skill manifest is missing required field: description',
      filePath,
    );
  }

  if (manifest.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new SkillParseError(
      `Skill description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters`,
      filePath,
    );
  }
}
