/**
 * WebChatChannel — WebSocket-based browser chat widget channel.
 *
 * Provides a lightweight text-chat interface for browser clients, distinct
 * from the Canvas workspace (which uses tldraw + spatial components). WebChat
 * is a simple bidirectional message stream over WebSocket.
 *
 * Configuration (via ChannelConfig):
 *   No special config required beyond standard channel fields.
 *   Auth is handled by the gateway's pairing system when enabled.
 *
 * Protocol (JSON over WebSocket):
 *   C→S: { type: "auth", token: "..." }          — authenticate (if pairing enabled)
 *   C→S: { type: "message", text: "...", userId?: "..." }  — send a message
 *   S→C: { type: "message", id: "...", text: "..." }       — receive a message
 *   S→C: { type: "edit", messageId: "...", text: "..." }   — edit a message
 *   S→C: { type: "error", error: "..." }                   — error response
 *
 * The gateway's handleUpgrade() checks for the /webchat URL path and routes
 * WebSocket connections to this channel.
 */

import type {
  IChannel,
  ChannelConfig,
  Recipient,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '@ch4p/core';

// Import ws types — the package is already a dependency of @ch4p/channels.
import type { WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebChatConfig extends ChannelConfig {
  /** Optional: require authentication for WebSocket connections. */
  requireAuth?: boolean;
}

/** Client-to-server WebSocket message. */
interface C2SMessage {
  type: 'auth' | 'message';
  text?: string;
  token?: string;
  userId?: string;
}

/** Server-to-client WebSocket message. */
interface S2CMessage {
  type: 'message' | 'edit' | 'error';
  id?: string;
  messageId?: string;
  text?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// WebChatChannel
// ---------------------------------------------------------------------------

export class WebChatChannel implements IChannel {
  readonly id = 'webchat';
  readonly name = 'WebChat';

  private config: WebChatConfig | null = null;
  private messageHandler: ((msg: InboundMessage) => void) | null = null;

  // Map of userId → Set<WebSocket> (supports multiple browser tabs).
  private clients = new Map<string, Set<WebSocket>>();

  // Counter for generating anonymous user IDs.
  private anonCounter = 0;

  // ---------------------------------------------------------------------------
  // IChannel lifecycle
  // ---------------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    this.config = config as WebChatConfig;
  }

  async stop(): Promise<void> {
    // Close all WebSocket connections.
    for (const [, sockets] of this.clients) {
      for (const ws of sockets) {
        try {
          ws.close(1001, 'Channel stopping');
        } catch {
          // Best-effort close.
        }
      }
    }
    this.clients.clear();
    this.messageHandler = null;
    this.config = null;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    if (!this.config) {
      return { success: false, error: 'WebChatChannel not started.' };
    }

    const userId = to.userId ?? to.channelId;
    const sockets = this.clients.get(userId);
    if (!sockets || sockets.size === 0) {
      return { success: false, error: `No WebSocket connection for user ${userId}` };
    }

    const messageId = `wc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload: S2CMessage = {
      type: 'message',
      id: messageId,
      text: message.text,
    };

    const json = JSON.stringify(payload);
    let sent = false;

    for (const ws of sockets) {
      try {
        if (ws.readyState === 1 /* WebSocket.OPEN */) {
          ws.send(json);
          sent = true;
        }
      } catch {
        // Remove dead sockets.
        sockets.delete(ws);
      }
    }

    return sent
      ? { success: true, messageId }
      : { success: false, error: 'All WebSocket connections are closed.' };
  }

  async editMessage(to: Recipient, messageId: string, message: OutboundMessage): Promise<SendResult> {
    if (!this.config) {
      return { success: false, error: 'WebChatChannel not started.' };
    }

    const userId = to.userId ?? to.channelId;
    const sockets = this.clients.get(userId);
    if (!sockets || sockets.size === 0) {
      return { success: false, error: `No WebSocket connection for user ${userId}` };
    }

    const payload: S2CMessage = {
      type: 'edit',
      messageId,
      text: message.text,
    };

    const json = JSON.stringify(payload);
    let sent = false;

    for (const ws of sockets) {
      try {
        if (ws.readyState === 1 /* WebSocket.OPEN */) {
          ws.send(json);
          sent = true;
        }
      } catch {
        sockets.delete(ws);
      }
    }

    return sent
      ? { success: true, messageId }
      : { success: false, error: 'All WebSocket connections are closed.' };
  }

  async isHealthy(): Promise<boolean> {
    return this.config !== null;
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection management
  // ---------------------------------------------------------------------------

  /**
   * Register a new WebSocket connection.
   * Called by the gateway's handleUpgrade() when a client connects to /webchat.
   */
  handleConnection(ws: WebSocket): void {
    if (!this.config) {
      ws.close(1013, 'Channel not started');
      return;
    }

    let userId: string | null = null;
    const requireAuth = this.config.requireAuth ?? false;

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as C2SMessage;

        if (msg.type === 'auth') {
          // Auth handling is done by the gateway before reaching here.
          // If we get here, the connection is already authenticated.
          return;
        }

        if (msg.type === 'message') {
          // Assign userId if not yet assigned.
          if (!userId) {
            if (requireAuth && !msg.userId) {
              this.sendError(ws, 'Authentication required.');
              return;
            }
            userId = msg.userId ?? `anon-${++this.anonCounter}`;
            this.addClient(userId, ws);
          }

          if (!msg.text) return;

          if (!this.messageHandler) return;

          const inbound: InboundMessage = {
            id: `wc-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            channelId: this.id,
            from: {
              channelId: this.id,
              userId,
            },
            text: msg.text,
            timestamp: new Date(),
          };

          this.messageHandler(inbound);
        }
      } catch {
        this.sendError(ws, 'Invalid message format.');
      }
    });

    ws.on('close', () => {
      if (userId) {
        this.removeClient(userId, ws);
      }
    });

    ws.on('error', () => {
      if (userId) {
        this.removeClient(userId, ws);
      }
    });
  }

  /**
   * Register a WebSocket for a specific userId.
   * Called when the user is already authenticated via the gateway.
   */
  handleAuthenticatedConnection(ws: WebSocket, authenticatedUserId: string): void {
    if (!this.config) {
      ws.close(1013, 'Channel not started');
      return;
    }

    this.addClient(authenticatedUserId, ws);

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as C2SMessage;

        if (msg.type === 'message' && msg.text) {
          if (!this.messageHandler) return;

          const inbound: InboundMessage = {
            id: `wc-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            channelId: this.id,
            from: {
              channelId: this.id,
              userId: authenticatedUserId,
            },
            text: msg.text,
            timestamp: new Date(),
          };

          this.messageHandler(inbound);
        }
      } catch {
        this.sendError(ws, 'Invalid message format.');
      }
    });

    ws.on('close', () => {
      this.removeClient(authenticatedUserId, ws);
    });

    ws.on('error', () => {
      this.removeClient(authenticatedUserId, ws);
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private addClient(userId: string, ws: WebSocket): void {
    let sockets = this.clients.get(userId);
    if (!sockets) {
      sockets = new Set();
      this.clients.set(userId, sockets);
    }
    sockets.add(ws);
  }

  private removeClient(userId: string, ws: WebSocket): void {
    const sockets = this.clients.get(userId);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        this.clients.delete(userId);
      }
    }
  }

  private sendError(ws: WebSocket, error: string): void {
    try {
      const payload: S2CMessage = { type: 'error', error };
      ws.send(JSON.stringify(payload));
    } catch {
      // Best-effort.
    }
  }
}
