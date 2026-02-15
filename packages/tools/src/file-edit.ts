/**
 * FileEdit tool — exact string replacement in files.
 *
 * Lightweight tool that performs precise string replacements. By default,
 * the old_string must appear exactly once to avoid ambiguous edits. The
 * replace_all flag enables replacing all occurrences.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ITool,
  ToolContext,
  ToolResult,
  ValidationResult,
  JSONSchema7,
  StateSnapshot,
} from '@ch4p/core';
import { SecurityError } from '@ch4p/core';
import { captureFileState } from './snapshot-utils.js';

interface FileEditArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export class FileEditTool implements ITool {
  readonly name = 'file_edit';
  readonly description =
    'Perform exact string replacements in a file. The old_string must be ' +
    'unique in the file unless replace_all is set to true. This ensures ' +
    'edits are unambiguous. The new_string must differ from old_string.';

  readonly weight = 'lightweight' as const;

  readonly parameters: JSONSchema7 = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file to edit.',
        minLength: 1,
      },
      old_string: {
        type: 'string',
        description: 'The exact string to find and replace.',
      },
      new_string: {
        type: 'string',
        description: 'The replacement string.',
      },
      replace_all: {
        type: 'boolean',
        description:
          'If true, replace all occurrences. If false (default), old_string must be unique.',
        default: false,
      },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  };

  validate(args: unknown): ValidationResult {
    if (typeof args !== 'object' || args === null) {
      return { valid: false, errors: ['Arguments must be an object.'] };
    }

    const { path, old_string, new_string, replace_all } = args as Record<
      string,
      unknown
    >;
    const errors: string[] = [];

    if (typeof path !== 'string' || path.trim().length === 0) {
      errors.push('path must be a non-empty string.');
    }

    if (typeof old_string !== 'string') {
      errors.push('old_string must be a string.');
    }

    if (typeof new_string !== 'string') {
      errors.push('new_string must be a string.');
    }

    if (
      typeof old_string === 'string' &&
      typeof new_string === 'string' &&
      old_string === new_string
    ) {
      errors.push('new_string must be different from old_string.');
    }

    if (replace_all !== undefined && typeof replace_all !== 'boolean') {
      errors.push('replace_all must be a boolean.');
    }

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const validation = this.validate(args);
    if (!validation.valid) {
      return {
        success: false,
        output: '',
        error: `Invalid arguments: ${validation.errors!.join(' ')}`,
      };
    }

    const {
      path: filePath,
      old_string: oldString,
      new_string: newString,
      replace_all: replaceAll = false,
    } = args as FileEditArgs;

    const absolutePath = resolve(context.cwd, filePath);

    // Validate path against security policy
    const pathValidation = context.securityPolicy.validatePath(absolutePath, 'write');
    if (!pathValidation.allowed) {
      throw new SecurityError(
        `Path blocked for writing: ${pathValidation.reason ?? absolutePath}`,
        { path: absolutePath },
      );
    }

    const resolvedPath = pathValidation.canonicalPath ?? absolutePath;

    // Read the file
    let content: string;
    try {
      content = await readFile(resolvedPath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          success: false,
          output: '',
          error: `File not found: ${resolvedPath}`,
        };
      }
      return {
        success: false,
        output: '',
        error: `Failed to read file: ${(err as Error).message}`,
      };
    }

    // Count occurrences
    const occurrences = countOccurrences(content, oldString);

    if (occurrences === 0) {
      return {
        success: false,
        output: '',
        error:
          'old_string was not found in the file. Ensure you have the exact string ' +
          'including whitespace and indentation.',
        metadata: { path: resolvedPath },
      };
    }

    if (!replaceAll && occurrences > 1) {
      return {
        success: false,
        output: '',
        error:
          `old_string appears ${occurrences} times in the file. ` +
          'Provide more surrounding context to make it unique, or set replace_all to true.',
        metadata: { path: resolvedPath, occurrences },
      };
    }

    // Perform the replacement
    let newContent: string;
    let replacedCount: number;

    if (replaceAll) {
      newContent = content.split(oldString).join(newString);
      replacedCount = occurrences;
    } else {
      // Replace only the first (and only) occurrence
      const idx = content.indexOf(oldString);
      newContent =
        content.slice(0, idx) + newString + content.slice(idx + oldString.length);
      replacedCount = 1;
    }

    // Write the modified content
    try {
      await writeFile(resolvedPath, newContent, 'utf-8');
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `Failed to write file: ${(err as Error).message}`,
      };
    }

    return {
      success: true,
      output: `Replaced ${replacedCount} occurrence${replacedCount > 1 ? 's' : ''} in ${resolvedPath}.`,
      metadata: {
        path: resolvedPath,
        replacements: replacedCount,
      },
    };
  }

  async getStateSnapshot(args: unknown, context: ToolContext): Promise<StateSnapshot> {
    const { path: filePath } = (args ?? {}) as Partial<FileEditArgs>;
    if (!filePath) {
      return {
        timestamp: new Date().toISOString(),
        state: { error: 'No path argument provided' },
      };
    }
    const absolutePath = resolve(context.cwd, filePath);
    return captureFileState(absolutePath);
  }
}

/** Count non-overlapping occurrences of a substring. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    pos = haystack.indexOf(needle, pos);
    if (pos === -1) break;
    count++;
    pos += needle.length;
  }
  return count;
}
