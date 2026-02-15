/**
 * FileWrite tool — writes content to a file.
 *
 * Lightweight tool that creates or overwrites files. Parent directories
 * are created automatically if they do not exist.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
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

interface FileWriteArgs {
  path: string;
  content: string;
}

export class FileWriteTool implements ITool {
  readonly name = 'file_write';
  readonly description =
    'Write content to a file. Creates the file if it does not exist, or ' +
    'overwrites it if it does. Parent directories are created automatically. ' +
    'Path is validated against the security policy.';

  readonly weight = 'lightweight' as const;

  readonly parameters: JSONSchema7 = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file to write.',
        minLength: 1,
      },
      content: {
        type: 'string',
        description: 'The content to write to the file.',
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  };

  validate(args: unknown): ValidationResult {
    if (typeof args !== 'object' || args === null) {
      return { valid: false, errors: ['Arguments must be an object.'] };
    }

    const { path, content } = args as Record<string, unknown>;
    const errors: string[] = [];

    if (typeof path !== 'string' || path.trim().length === 0) {
      errors.push('path must be a non-empty string.');
    }

    if (typeof content !== 'string') {
      errors.push('content must be a string.');
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

    const { path: filePath, content } = args as FileWriteArgs;
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

    // Ensure parent directory exists
    const parentDir = dirname(resolvedPath);
    try {
      await mkdir(parentDir, { recursive: true });
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `Failed to create parent directory: ${(err as Error).message}`,
      };
    }

    // Write the file
    try {
      await writeFile(resolvedPath, content, 'utf-8');
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `Failed to write file: ${(err as Error).message}`,
      };
    }

    const lineCount = content.split('\n').length;
    const byteCount = Buffer.byteLength(content, 'utf-8');

    return {
      success: true,
      output: `File written successfully: ${resolvedPath} (${lineCount} lines, ${byteCount} bytes)`,
      metadata: {
        path: resolvedPath,
        lines: lineCount,
        bytes: byteCount,
      },
    };
  }

  async getStateSnapshot(args: unknown, context: ToolContext): Promise<StateSnapshot> {
    const { path: filePath } = (args ?? {}) as Partial<FileWriteArgs>;
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
