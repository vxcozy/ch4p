/**
 * MessageRouter -- routes inbound channel messages to sessions.
 *
 * Uses the combination of channelId + userId to locate an existing
 * session. When no session exists for the sender, one is created
 * automatically from the default session configuration.
 */

import type { InboundMessage, SessionConfig } from '@ch4p/core';
import { generateId } from '@ch4p/core';
import type { SessionManager } from './session-manager.js';

export interface RouteResult {
  sessionId: string;
  config: SessionConfig;
}

export class MessageRouter {
  /**
   * Maps "channelId:userId" keys to session ids so subsequent messages
   * from the same user on the same channel reach the same session.
   */
  private routeMap = new Map<string, string>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly defaultSessionConfig: Omit<SessionConfig, 'sessionId' | 'channelId' | 'userId'>,
  ) {}

  /**
   * Route an inbound message to a session.
   *
   * Routing key priority:
   *   1. Group + thread (Telegram forum topic, Discord thread): all users in the
   *      same thread share one session.
   *   2. Group only: each user in the group gets their own session.
   *   3. Private: keyed by userId (original behaviour).
   *
   * Returns `null` only if the message cannot be attributed to a user
   * (missing channelId).
   */
  route(msg: InboundMessage): RouteResult | null {
    if (!msg.channelId) return null;

    const routeKey = this.buildRouteKey(msg);

    // Check for an existing session
    const existingId = this.routeMap.get(routeKey);
    if (existingId) {
      const session = this.sessionManager.getSession(existingId);
      if (session) {
        this.sessionManager.touchSession(existingId);
        return { sessionId: existingId, config: session.config };
      }
      // Session was ended externally -- clean up stale route
      this.routeMap.delete(routeKey);
    }

    // Create a new session
    const sessionId = generateId();
    const config: SessionConfig = {
      ...this.defaultSessionConfig,
      sessionId,
      channelId: msg.channelId,
      userId: msg.from.userId,
    };

    const state = this.sessionManager.createSession(config);
    this.routeMap.set(routeKey, sessionId);

    return { sessionId, config: state.config };
  }

  /**
   * Evict route entries whose sessions no longer exist in the SessionManager.
   * Returns the number of stale routes removed.
   */
  evictStale(): number {
    let evicted = 0;
    for (const [key, sessionId] of this.routeMap) {
      if (!this.sessionManager.getSession(sessionId)) {
        this.routeMap.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildRouteKey(msg: InboundMessage): string {
    const { channelId, from } = msg;
    const { userId, groupId, threadId } = from;

    // Forum topic / thread: all participants share one session per thread.
    if (groupId && threadId) {
      return `${channelId}:group:${groupId}:thread:${threadId}`;
    }

    // Regular group chat: each user has their own session.
    if (groupId) {
      return `${channelId}:group:${groupId}:user:${userId ?? 'anonymous'}`;
    }

    // Private / direct message: keyed by user.
    return `${channelId}:${userId ?? 'anonymous'}`;
  }
}
