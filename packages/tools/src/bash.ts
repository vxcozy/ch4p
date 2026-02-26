/**
 * Bash tool — executes shell commands with security validation.
 * Runs in worker threads due to heavyweight classification.
 *
 * Security: Commands are validated against the security policy before execution.
 * Output is captured from both stdout and stderr, truncated to configurable limits.
 * AbortSignal support enables cancellation of long-running processes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { stat, readdir } from 'node:fs/promises';
import type {
  ITool,
  ToolContext,
  ToolResult,
  ValidationResult,
  JSONSchema7,
  StateSnapshot,
} from '@ch4p/core';
import { SecurityError } from '@ch4p/core';

interface BashArgs {
  command: string;
  timeout?: number;
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_LENGTH = 30_000;
/** Kill the subprocess when combined stdout+stderr exceeds this (10 MiB). */
const MAX_BASH_OUTPUT_BYTES = 10 * 1024 * 1024;

export class BashTool implements ITool {
  readonly name = 'bash';
  readonly description =
    'Execute a shell command. Commands are validated against the security policy. ' +
    'Output from stdout and stderr is captured and returned. ' +
    'Long-running commands can be cancelled via abort signal.';

  readonly weight = 'heavyweight' as const;

  readonly parameters: JSONSchema7 = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute.',
        minLength: 1,
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds. Defaults to 120000 (2 minutes).',
        minimum: 1,
        maximum: 600_000,
      },
      cwd: {
        type: 'string',
        description:
          'Working directory for the command. Defaults to the session working directory.',
      },
    },
    required: ['command'],
    additionalProperties: false,
  };

  private activeProcess: ChildProcess | null = null;

  validate(args: unknown): ValidationResult {
    if (typeof args !== 'object' || args === null) {
      return { valid: false, errors: ['Arguments must be an object.'] };
    }

    const { command, timeout, cwd } = args as Record<string, unknown>;

    const errors: string[] = [];

    if (typeof command !== 'string' || command.trim().length === 0) {
      errors.push('command must be a non-empty string.');
    }

    if (timeout !== undefined) {
      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 1) {
        errors.push('timeout must be a positive number.');
      }
      if (typeof timeout === 'number' && timeout > 600_000) {
        errors.push('timeout cannot exceed 600000ms (10 minutes).');
      }
    }

    if (cwd !== undefined && typeof cwd !== 'string') {
      errors.push('cwd must be a string.');
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

    const { command, timeout, cwd } = args as BashArgs;
    const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
    const workingDir = cwd ? resolve(context.cwd, cwd) : context.cwd;

    // Validate working directory path
    const cwdValidation = context.securityPolicy.validatePath(workingDir, 'read');
    if (!cwdValidation.allowed) {
      throw new SecurityError(
        `Working directory blocked: ${cwdValidation.reason ?? workingDir}`,
        { path: workingDir },
      );
    }

    // Parse command for security validation. We pass the full command string
    // with 'bash' as the executable and '-c' + command as args.
    const commandValidation = context.securityPolicy.validateCommand('bash', [
      '-c',
      command,
    ]);
    if (!commandValidation.allowed) {
      throw new SecurityError(
        `Command blocked: ${commandValidation.reason ?? command}`,
        { command },
      );
    }

    if (context.abortSignal.aborted) {
      return {
        success: false,
        output: '',
        error: 'Command aborted before execution.',
      };
    }

    return this.runCommand(command, workingDir, timeoutMs, context);
  }

  abort(_reason: string): void {
    if (this.activeProcess && !this.activeProcess.killed) {
      this.activeProcess.kill('SIGTERM');
      // Force kill after 5 seconds if SIGTERM is ignored
      setTimeout(() => {
        if (this.activeProcess && !this.activeProcess.killed) {
          this.activeProcess.kill('SIGKILL');
        }
      }, 5_000);
    }
  }

  private runCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
    context: ToolContext,
  ): Promise<ToolResult> {
    return new Promise<ToolResult>((resolvePromise) => {
      const child = spawn('bash', ['-c', command], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        // Close stdin immediately — we never write to it
      });

      this.activeProcess = child;

      // Close stdin
      child.stdin?.end();

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalBytes = 0;
      let killed = false;
      let outputCapped = false;

      const killForOutputCap = () => {
        if (outputCapped) return;
        outputCapped = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5_000);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        totalBytes += chunk.length;
        context.onProgress(`[stdout] ${chunk.toString('utf-8').trim()}`);
        if (totalBytes > MAX_BASH_OUTPUT_BYTES) killForOutputCap();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
        totalBytes += chunk.length;
        context.onProgress(`[stderr] ${chunk.toString('utf-8').trim()}`);
        if (totalBytes > MAX_BASH_OUTPUT_BYTES) killForOutputCap();
      });

      // Timeout handling
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5_000);
      }, timeoutMs);

      // AbortSignal handling
      const onAbort = () => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5_000);
      };
      context.abortSignal.addEventListener('abort', onAbort, { once: true });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        context.abortSignal.removeEventListener('abort', onAbort);
        this.activeProcess = null;

        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        let output = '';
        if (stdout.length > 0) {
          output += stdout;
        }
        if (stderr.length > 0) {
          if (output.length > 0) output += '\n';
          output += stderr;
        }

        // Truncate output if needed
        if (output.length > DEFAULT_MAX_OUTPUT_LENGTH) {
          const halfLen = Math.floor((DEFAULT_MAX_OUTPUT_LENGTH - 50) / 2);
          output =
            output.slice(0, halfLen) +
            '\n\n... [output truncated] ...\n\n' +
            output.slice(output.length - halfLen);
        }

        if (outputCapped) {
          resolvePromise({
            success: false,
            output,
            error: `Command output exceeded ${MAX_BASH_OUTPUT_BYTES / 1024 / 1024}MiB limit and was killed.`,
            metadata: { code, signal, outputCapped: true },
          });
          return;
        }

        if (killed && context.abortSignal.aborted) {
          resolvePromise({
            success: false,
            output,
            error: 'Command was aborted.',
            metadata: { code, signal },
          });
          return;
        }

        if (killed) {
          resolvePromise({
            success: false,
            output,
            error: `Command timed out after ${timeoutMs}ms.`,
            metadata: { code, signal, timedOut: true },
          });
          return;
        }

        resolvePromise({
          success: code === 0,
          output,
          error: code !== 0 ? `Command exited with code ${code}.` : undefined,
          metadata: { code, signal },
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        context.abortSignal.removeEventListener('abort', onAbort);
        this.activeProcess = null;

        resolvePromise({
          success: false,
          output: '',
          error: `Failed to spawn command: ${err.message}`,
        });
      });
    });
  }

  async getStateSnapshot(args: unknown, context: ToolContext): Promise<StateSnapshot> {
    const { command, cwd } = (args ?? {}) as Partial<BashArgs>;
    const workingDir = cwd ? resolve(context.cwd, cwd) : context.cwd;

    try {
      const dirStats = await stat(workingDir);
      const entries = dirStats.isDirectory()
        ? await readdir(workingDir).then((e) => e.length)
        : 0;

      return {
        timestamp: new Date().toISOString(),
        state: {
          cwd: workingDir,
          cwdExists: true,
          entryCount: entries,
          command: command?.slice(0, 200),
        },
        description: `Working directory state for bash: ${workingDir}`,
      };
    } catch {
      return {
        timestamp: new Date().toISOString(),
        state: {
          cwd: workingDir,
          cwdExists: false,
          command: command?.slice(0, 200),
        },
        description: `Working directory state for bash: ${workingDir} (does not exist)`,
      };
    }
  }
}
