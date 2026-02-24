/**
 * FileObserver — structured JSONL file logging with rotation.
 *
 * Each event is serialised as a single JSON line (JSONL) and appended to the
 * configured log file. When the file exceeds `maxBytes` it is rotated: the
 * current file is renamed with a `.1` suffix (overwriting any previous
 * rotation) and a fresh file is opened.
 *
 * Default path : ~/.ch4p/logs/ch4p.jsonl
 * Default limit: 10 MB
 */

import { writeFileSync, appendFileSync, renameSync, statSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

import type {
  IObserver,
  SessionMeta,
  SessionStats,
  ToolInvocationEvent,
  LLMCallEvent,
  ChannelMessageEvent,
  SecurityEvent,
  IdentityEvent,
} from '@ch4p/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

function serializeError(err: Error): Record<string, unknown> {
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
}

// ---------------------------------------------------------------------------
// FileObserver
// ---------------------------------------------------------------------------

export interface FileObserverOptions {
  /** Absolute or ~-relative path to the JSONL log file. */
  filePath?: string;
  /** Max file size in bytes before rotation (default 10 MB). */
  maxBytes?: number;
}

export class FileObserver implements IObserver {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(opts: FileObserverOptions = {}) {
    this.filePath = expandHome(opts.filePath ?? '~/.ch4p/logs/ch4p.jsonl');
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024; // 10 MB
    this.ensureDir();
  }

  // ---- internal -----------------------------------------------------------

  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private write(type: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      type,
      ...data,
    });
    this.buffer.push(line);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushSync();
      this.flushTimer = null;
    }, 100);
  }

  private flushSync(): void {
    if (this.buffer.length === 0 || this.flushing) return;
    this.flushing = true;

    this.rotateIfNeeded();

    const payload = this.buffer.join('\n') + '\n';
    this.buffer = [];

    try {
      appendFileSync(this.filePath, payload, { encoding: 'utf-8', mode: 0o600 });
      chmodSync(this.filePath, 0o600);
    } catch {
      // If we cannot write, silently drop — observability must never crash the host.
    } finally {
      this.flushing = false;
    }
  }

  private rotateIfNeeded(): void {
    try {
      const stats = statSync(this.filePath);
      if (stats.size >= this.maxBytes) {
        const rotatedPath = this.filePath + '.1';
        renameSync(this.filePath, rotatedPath);
        writeFileSync(this.filePath, '', { encoding: 'utf-8', mode: 0o600 });
      }
    } catch {
      // File may not exist yet — that is fine.
    }
  }

  // ---- IObserver ----------------------------------------------------------

  onSessionStart(meta: SessionMeta): void {
    this.write('session_start', {
      sessionId: meta.sessionId,
      channelId: meta.channelId,
      userId: meta.userId,
      engineId: meta.engineId,
      startedAt: meta.startedAt.toISOString(),
    });
  }

  onSessionEnd(meta: SessionMeta, stats: SessionStats): void {
    this.write('session_end', {
      sessionId: meta.sessionId,
      duration: stats.duration,
      toolInvocations: stats.toolInvocations,
      llmCalls: stats.llmCalls,
      tokensUsed: stats.tokensUsed,
      errors: stats.errors,
    });
  }

  onToolInvocation(event: ToolInvocationEvent): void {
    this.write('tool_invocation', {
      sessionId: event.sessionId,
      tool: event.tool,
      args: event.args,
      result: event.result,
      duration: event.duration,
      error: event.error ? serializeError(event.error) : undefined,
    });
  }

  onLLMCall(event: LLMCallEvent): void {
    this.write('llm_call', {
      sessionId: event.sessionId,
      provider: event.provider,
      model: event.model,
      usage: event.usage,
      duration: event.duration,
      finishReason: event.finishReason,
    });
  }

  onChannelMessage(event: ChannelMessageEvent): void {
    this.write('channel_message', {
      channelId: event.channelId,
      direction: event.direction,
      userId: event.userId,
      messageLength: event.messageLength,
      timestamp: event.timestamp.toISOString(),
    });
  }

  onError(error: Error, context: Record<string, unknown>): void {
    this.write('error', {
      error: serializeError(error),
      context,
    });
  }

  onSecurityEvent(event: SecurityEvent): void {
    this.write('security_event', {
      securityType: event.type,
      details: event.details,
      timestamp: event.timestamp.toISOString(),
    });
  }

  onIdentityEvent(event: IdentityEvent): void {
    this.write('identity_event', {
      identityType: event.type,
      agentId: event.agentId,
      chainId: event.chainId,
      details: event.details,
      timestamp: event.timestamp.toISOString(),
    });
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushSync();
  }
}
