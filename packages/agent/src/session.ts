/**
 * Session — single conversation session with lifecycle management.
 *
 * Each session owns:
 *   - A ContextManager for conversation context.
 *   - A SteeringQueue for live steering messages.
 *   - Configuration (SessionConfig from @ch4p/core).
 *   - Session-level state and metadata.
 *
 * Lifecycle: created -> active -> paused -> completed | failed
 */

import type { SessionConfig } from '@ch4p/core';
import { ContextManager, type ContextManagerOpts } from './context.js';
import { SteeringQueue } from './steering.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionState = 'created' | 'active' | 'paused' | 'completed' | 'failed';

export interface SessionMetadata {
  id: string;
  channelId?: string;
  userId?: string;
  engineId: string;
  startedAt: Date;
  endedAt?: Date;
  state: SessionState;
  loopIterations: number;
  toolInvocations: number;
  llmCalls: number;
  errors: Error[];
}

export interface SessionOpts {
  /** Options forwarded to the ContextManager. */
  contextOpts?: ContextManagerOpts;
  /** Inject an existing ContextManager for conversation continuity (e.g. REPL).
   *  When provided, the session shares this context instead of creating a new one. */
  sharedContext?: ContextManager;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class Session {
  private readonly config: SessionConfig;
  private readonly context: ContextManager;
  private readonly steering: SteeringQueue;
  private readonly metadata: SessionMetadata;
  private state: SessionState;

  constructor(config: SessionConfig, opts: SessionOpts = {}) {
    this.config = config;
    this.state = 'created';

    this.context = opts.sharedContext ?? new ContextManager(opts.contextOpts);
    this.steering = new SteeringQueue();

    this.metadata = {
      id: config.sessionId,
      channelId: config.channelId,
      userId: config.userId,
      engineId: config.engineId,
      startedAt: new Date(),
      state: this.state,
      loopIterations: 0,
      toolInvocations: 0,
      llmCalls: 0,
      errors: [],
    };

    // Set the system prompt if one was provided in the config.
    if (config.systemPrompt) {
      this.context.setSystemPrompt(config.systemPrompt);
    }
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  getId(): string {
    return this.config.sessionId;
  }

  getConfig(): Readonly<SessionConfig> {
    return this.config;
  }

  getContext(): ContextManager {
    return this.context;
  }

  getSteering(): SteeringQueue {
    return this.steering;
  }

  getState(): SessionState {
    return this.state;
  }

  getMetadata(): Readonly<SessionMetadata> {
    return { ...this.metadata, state: this.state };
  }

  // -----------------------------------------------------------------------
  // Lifecycle transitions
  // -----------------------------------------------------------------------

  /** Transition to active. Only valid from created or paused. */
  activate(): void {
    if (this.state !== 'created' && this.state !== 'paused') {
      throw new Error(`Cannot activate session in state "${this.state}"`);
    }
    this.state = 'active';
    this.metadata.state = this.state;
  }

  /** Pause the session. Only valid from active. */
  pause(): void {
    if (this.state !== 'active') {
      throw new Error(`Cannot pause session in state "${this.state}"`);
    }
    this.state = 'paused';
    this.metadata.state = this.state;
  }

  /** Resume from paused back to active. */
  resume(): void {
    if (this.state !== 'paused') {
      throw new Error(`Cannot resume session in state "${this.state}"`);
    }
    this.state = 'active';
    this.metadata.state = this.state;
  }

  /** Mark the session as successfully completed. */
  complete(): void {
    if (this.state !== 'active' && this.state !== 'paused') {
      throw new Error(`Cannot complete session in state "${this.state}"`);
    }
    this.state = 'completed';
    this.metadata.state = this.state;
    this.metadata.endedAt = new Date();
    this.steering.clear();
  }

  /** Mark the session as failed with an error. */
  fail(error: Error): void {
    this.metadata.errors.push(error);
    this.state = 'failed';
    this.metadata.state = this.state;
    this.metadata.endedAt = new Date();
    this.steering.clear();
  }

  // -----------------------------------------------------------------------
  // Stats tracking
  // -----------------------------------------------------------------------

  /** Increment loop iteration counter. */
  recordIteration(): void {
    this.metadata.loopIterations++;
  }

  /** Increment tool invocation counter. */
  recordToolInvocation(): void {
    this.metadata.toolInvocations++;
  }

  /** Increment LLM call counter. */
  recordLLMCall(): void {
    this.metadata.llmCalls++;
  }

  /** Record an error without failing the session. */
  recordError(error: Error): void {
    this.metadata.errors.push(error);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /** Clear all session resources. */
  dispose(): void {
    this.context.clear();
    this.steering.clear();
  }
}
