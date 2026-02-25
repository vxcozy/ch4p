/**
 * CanvasSessionManager — tracks per-session canvas state.
 *
 * Each canvas session owns a CanvasState (server-side component/node state)
 * and a CanvasChannel (IChannel adapter for bidirectional communication).
 * The WebSocketBridge connects the two to a live WebSocket client.
 */

import { CanvasState, CanvasChannel } from '@ch4p/canvas';
import type { WebSocketBridge } from './ws-bridge.js';

export interface CanvasSessionEntry {
  canvasState: CanvasState;
  canvasChannel: CanvasChannel;
  bridge: WebSocketBridge | null;
  lastActiveAt: number;
}

export class CanvasSessionManager {
  private sessions = new Map<string, CanvasSessionEntry>();

  /** Create a new canvas session with fresh state and channel. */
  createCanvasSession(sessionId: string, maxComponents?: number): CanvasSessionEntry {
    const canvasState = new CanvasState(maxComponents);
    const canvasChannel = new CanvasChannel();
    const entry: CanvasSessionEntry = { canvasState, canvasChannel, bridge: null, lastActiveAt: Date.now() };
    this.sessions.set(sessionId, entry);
    return entry;
  }

  /** Get the canvas state for a session. */
  getCanvasState(sessionId: string): CanvasState | undefined {
    return this.sessions.get(sessionId)?.canvasState;
  }

  /** Get the canvas channel for a session. */
  getCanvasChannel(sessionId: string): CanvasChannel | undefined {
    return this.sessions.get(sessionId)?.canvasChannel;
  }

  /** Get the full session entry. */
  getSession(sessionId: string): CanvasSessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  /** Associate a WebSocket bridge with a canvas session. */
  setBridge(sessionId: string, bridge: WebSocketBridge): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.bridge = bridge;
      entry.lastActiveAt = Date.now();
    }
  }

  /** Touch a session's lastActiveAt timestamp. */
  touchSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastActiveAt = Date.now();
    }
  }

  /** Check if a canvas session exists. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** List all active canvas session IDs. */
  listSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** End and clean up a canvas session. */
  endCanvasSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.bridge?.stop();
      entry.bridge = null;
      this.sessions.delete(sessionId);
    }
  }

  /** End all canvas sessions. */
  endAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.endCanvasSession(sessionId);
    }
  }

  /**
   * Evict canvas sessions idle longer than `maxIdleMs`.
   * Returns the number of sessions evicted.
   */
  evictIdle(maxIdleMs: number): number {
    const cutoff = Date.now() - maxIdleMs;
    let evicted = 0;
    for (const [sessionId, entry] of this.sessions) {
      if (entry.lastActiveAt < cutoff) {
        this.endCanvasSession(sessionId);
        evicted++;
      }
    }
    return evicted;
  }
}
