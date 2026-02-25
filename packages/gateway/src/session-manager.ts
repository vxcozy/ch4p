/**
 * SessionManager -- tracks active assistant sessions.
 *
 * Each session maps one-to-one with an engine run. The manager
 * provides CRUD operations over the session map and keeps
 * `lastActiveAt` timestamps for idle-detection.
 */

import type { SessionConfig } from '@ch4p/core';

export interface SessionState {
  config: SessionConfig;
  createdAt: Date;
  lastActiveAt: Date;
  status: 'active' | 'idle' | 'ended';
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();

  /** Create a new session and return its state. */
  createSession(config: SessionConfig): SessionState {
    const now = new Date();
    const state: SessionState = {
      config,
      createdAt: now,
      lastActiveAt: now,
      status: 'active',
    };
    this.sessions.set(config.sessionId, state);
    return state;
  }

  /** Look up a session by its id. */
  getSession(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  /** Mark a session as ended and remove it from the active map. */
  endSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.status = 'ended';
      session.lastActiveAt = new Date();
      this.sessions.delete(id);
    }
  }

  /** Return all currently tracked sessions (not ended). */
  listSessions(): SessionState[] {
    return [...this.sessions.values()];
  }

  /** Touch a session's lastActiveAt timestamp to keep it alive. */
  touchSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.lastActiveAt = new Date();
      session.status = 'active';
    }
  }

  /**
   * Evict sessions that have been idle longer than `maxIdleMs`.
   * Returns the number of sessions evicted.
   */
  evictIdle(maxIdleMs: number): number {
    const cutoff = Date.now() - maxIdleMs;
    let evicted = 0;
    for (const [id, session] of this.sessions) {
      if (session.lastActiveAt.getTime() < cutoff) {
        this.sessions.delete(id);
        evicted++;
      }
    }
    return evicted;
  }
}
