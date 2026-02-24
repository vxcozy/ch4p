/**
 * FilesystemScope -- Path blocking, symlink detection, null byte guard
 *
 * ZeroClaw-inspired filesystem scoping. Everything is blocked by default.
 * The agent operates within a workspace boundary; any escape attempt
 * (symlinks, traversal, null bytes) is caught and rejected.
 */

import { resolve, relative } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';
import type { PathValidation, PathOperation } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Custom error for security violations
// ---------------------------------------------------------------------------

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FilesystemScopeConfig {
  /** Absolute path to the workspace root. All access is scoped here. */
  workspaceRoot: string;

  /**
   * Additional paths to block beyond the built-in system dirs.
   * Must be absolute paths.
   */
  extraBlockedPaths?: string[];

  /**
   * If true (default), symlinks that resolve outside the workspace are
   * rejected.
   */
  enforceSymlinkBoundary?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** System directories that must never be accessed by an agent. */
const DEFAULT_BLOCKED_SYSTEM_DIRS: readonly string[] = [
  '/etc',
  '/root',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/sbin',
  '/usr/sbin',
  '/var/log',
  '/var/run',
  '/tmp',
  '/private/var',
  '/Library/Keychains',
  '/System',
] as const;

/**
 * Sensitive user-level dotfiles. The `~` prefix is expanded to the actual
 * home directory at runtime.
 */
const SENSITIVE_DOTFILES: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gcloud',
] as const;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class FilesystemScope {
  private readonly workspaceRoot: string;
  private readonly blockedPaths: Set<string>;
  private readonly enforceSymlinks: boolean;

  constructor(config: FilesystemScopeConfig) {
    // Resolve workspace root to an absolute canonical path.
    this.workspaceRoot = resolve(config.workspaceRoot);
    this.enforceSymlinks = config.enforceSymlinkBoundary ?? true;

    // Build the blocked set: system dirs + dotfiles + extras.
    this.blockedPaths = new Set<string>();

    for (const dir of DEFAULT_BLOCKED_SYSTEM_DIRS) {
      this.blockedPaths.add(dir);
    }

    // Expand dotfiles relative to $HOME.
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/root';
    for (const dotfile of SENSITIVE_DOTFILES) {
      this.blockedPaths.add(resolve(home, dotfile));
    }

    if (config.extraBlockedPaths) {
      for (const p of config.extraBlockedPaths) {
        this.blockedPaths.add(resolve(p));
      }
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Validate that `path` is safe for the given `operation`.
   *
   * Checks, in order:
   * 1. Null byte injection
   * 2. Blocked system / dotfile paths
   * 3. Workspace boundary (path must be within workspaceRoot)
   * 4. Symlink escape (real path must also be within workspaceRoot)
   */
  validatePath(path: string, _operation: PathOperation): PathValidation {
    // ---- 1. Null byte guard ----
    if (path.includes('\0')) {
      throw new SecurityError(
        `Null byte detected in path: ${JSON.stringify(path)}`
      );
    }

    // Resolve to absolute so traversal tricks (../../) are normalized.
    const absolute = resolve(path);

    // ---- 2. Workspace boundary ----
    const rel = relative(this.workspaceRoot, absolute);
    if (rel.startsWith('..') || resolve(this.workspaceRoot, rel) !== absolute) {
      return {
        allowed: false,
        reason: `Path "${absolute}" is outside workspace root "${this.workspaceRoot}"`,
        canonicalPath: absolute,
      };
    }

    // ---- 3. Blocked paths ----
    const blockReason = this.isBlocked(absolute);
    if (blockReason) {
      return {
        allowed: false,
        reason: blockReason,
        canonicalPath: absolute,
      };
    }

    // ---- 4. Symlink escape detection ----
    if (this.enforceSymlinks) {
      const symlinkResult = this.checkSymlink(absolute);
      if (symlinkResult) {
        return symlinkResult;
      }
    }

    return { allowed: true, canonicalPath: absolute };
  }

  /** Expose the current set of blocked paths (immutable copy). */
  getBlockedPaths(): ReadonlySet<string> {
    return new Set(this.blockedPaths);
  }

  /** Expose the workspace root. */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /** Whether symlink boundary enforcement is enabled. */
  isSymlinkEnforcementEnabled(): boolean {
    return this.enforceSymlinks;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Check if `absolute` falls under any blocked prefix.
   * Returns a reason string if blocked, otherwise null.
   */
  private isBlocked(absolute: string): string | null {
    for (const blocked of this.blockedPaths) {
      // If the workspace itself lives under a globally blocked prefix
      // (e.g. /tmp/project in tests), allow access within that workspace.
      if (
        this.workspaceRoot === blocked ||
        this.workspaceRoot.startsWith(blocked + '/')
      ) {
        continue;
      }
      // The path is blocked if it IS the blocked path or is a child of it.
      if (absolute === blocked || absolute.startsWith(blocked + '/')) {
        return `Access to "${absolute}" is blocked (matched blocked path "${blocked}")`;
      }
    }
    return null;
  }


  /**
   * Resolve symlinks and verify the real path is still inside the workspace.
   * Returns a failing PathValidation if the symlink escapes, otherwise null.
   */
  private checkSymlink(absolute: string): PathValidation | null {
    try {
      // lstatSync will tell us if the path itself is a symlink.
      const stats = lstatSync(absolute);
      if (!stats.isSymbolicLink()) {
        return null; // Not a symlink -- nothing to check.
      }

      // Resolve the actual destination.
      const realPath = realpathSync(absolute);
      const rel = relative(this.workspaceRoot, realPath);

      if (rel.startsWith('..') || resolve(this.workspaceRoot, rel) !== realPath) {
        return {
          allowed: false,
          reason: `Symlink "${absolute}" resolves to "${realPath}" which is outside workspace root "${this.workspaceRoot}"`,
          canonicalPath: realPath,
        };
      }

      // Also check if the real path lands in a blocked dir.
      const blockReason = this.isBlocked(realPath);
      if (blockReason) {
        return {
          allowed: false,
          reason: `Symlink "${absolute}" resolves to blocked path: ${blockReason}`,
          canonicalPath: realPath,
        };
      }

      return null; // Symlink is safe.
    } catch {
      // If the file doesn't exist yet (e.g., about to be created), we cannot
      // verify the symlink target. This is acceptable for write operations --
      // the workspace boundary check (step 3) already passed.
      return null;
    }
  }
}
