/**
 * Shared utilities for file-based state snapshots.
 *
 * Used by FileWriteTool, FileEditTool, and BashTool to capture
 * observable filesystem state before and after tool execution.
 * These snapshots feed into IVerifier for AWM-style outcome verification.
 */

import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { StateSnapshot } from '@ch4p/core';

/** Capture the observable state of a file (or its absence). */
export async function captureFileState(
  absolutePath: string,
  description?: string,
): Promise<StateSnapshot> {
  try {
    const fileStats = await stat(absolutePath);

    if (!fileStats.isFile()) {
      return {
        timestamp: new Date().toISOString(),
        state: {
          path: absolutePath,
          exists: true,
          isFile: false,
          isDirectory: fileStats.isDirectory(),
        },
        description: description ?? `State of ${absolutePath}`,
      };
    }

    // Read file content for hashing (cap at 1MB to avoid excessive memory).
    const MAX_HASH_SIZE = 1_048_576;
    let contentHash: string;
    let lineCount: number | undefined;

    if (fileStats.size <= MAX_HASH_SIZE) {
      const content = await readFile(absolutePath, 'utf-8');
      contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
      lineCount = content.split('\n').length;
    } else {
      // For large files, hash the first 1MB.
      const buffer = await readFile(absolutePath);
      contentHash = createHash('sha256')
        .update(buffer.subarray(0, MAX_HASH_SIZE))
        .digest('hex')
        .slice(0, 16);
    }

    return {
      timestamp: new Date().toISOString(),
      state: {
        path: absolutePath,
        exists: true,
        isFile: true,
        size: fileStats.size,
        mtime: fileStats.mtime.toISOString(),
        contentHash,
        ...(lineCount !== undefined ? { lineCount } : {}),
      },
      description: description ?? `State of ${absolutePath}`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        timestamp: new Date().toISOString(),
        state: {
          path: absolutePath,
          exists: false,
        },
        description: description ?? `State of ${absolutePath} (does not exist)`,
      };
    }

    // Other errors (permissions, etc.)
    return {
      timestamp: new Date().toISOString(),
      state: {
        path: absolutePath,
        exists: undefined,
        error: `Cannot access: ${(err as Error).message}`,
      },
      description: description ?? `State of ${absolutePath} (error)`,
    };
  }
}
