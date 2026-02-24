/**
 * DiscordChannel — Discord Bot channel adapter.
 *
 * Implements the IChannel interface for Discord using the Gateway WebSocket
 * API (for receiving events) and the REST API (for sending messages).
 *
 * This is a lightweight implementation using raw WebSocket and fetch() with
 * minimal dependencies (ws for WebSocket, no discord.js).
 *
 * Configuration (via ChannelConfig):
 *   token          — Bot token (required)
 *   intents        — Gateway intents bitmask (default: GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT)
 *   allowedGuilds  — Array of allowed guild IDs (empty = allow all)
 *   allowedUsers   — Array of allowed user IDs (empty = allow all)
 *
 * Supported features:
 *   - Text message receiving and sending
 *   - Reply threading via replyTo
 *   - Attachment support (images, files)
 *   - Presence events (typing indicators)
 *   - Automatic heartbeat and reconnection
 */

import type {
  IChannel,
  ChannelConfig,
  Recipient,
  InboundMessage,
  OutboundMessage,
  SendResult,
  PresenceEvent,
  Attachment,
} from '@ch4p/core';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscordConfig extends ChannelConfig {
  token: string;
  intents?: number;
  allowedGuilds?: string[];
  allowedUsers?: string[];
  /** Streaming mode: 'off' (default), 'edit' (progressive edits), 'block' (wait then send). */
  streamMode?: 'off' | 'edit' | 'block';
}

/** Minimum interval between message edits for streaming (Discord rate limit). */
import { splitMessage, truncateMessage } from './message-utils.js';

const DISCORD_MAX_MESSAGE_LEN = 2_000;
const DISCORD_EDIT_RATE_LIMIT_MS = 1_000;

const DISCORD_RECONNECT_BASE_MS = 1_000;
const DISCORD_RECONNECT_MAX_MS = 60_000;

/** Discord Gateway opcodes. */
const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** Discord Gateway intents. */
export const DiscordIntents = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15,
} as const;

const DEFAULT_INTENTS =
  DiscordIntents.GUILDS |
  DiscordIntents.GUILD_MESSAGES |
  DiscordIntents.DIRECT_MESSAGES |
  DiscordIntents.MESSAGE_CONTENT;

const API_BASE = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

/** Minimal Discord message payload. */
interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: { id: string; username: string; bot?: boolean };
  content: string;
  timestamp: string;
  attachments?: Array<{
    id: string;
    filename: string;
    url: string;
    content_type?: string;
    size: number;
  }>;
  message_reference?: { message_id: string };
  referenced_message?: { id: string };
}

/** Minimal Discord typing event payload. */
interface DiscordTypingStart {
  channel_id: string;
  guild_id?: string;
  user_id: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// DiscordChannel
// ---------------------------------------------------------------------------

export class DiscordChannel implements IChannel {
  readonly id = 'discord';
  readonly name = 'Discord';

  private token = '';
  private intents = DEFAULT_INTENTS;
  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private presenceHandler: ((event: PresenceEvent) => void) | null = null;
  private running = false;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private botUserId: string | null = null;
  private allowedGuilds: Set<string> = new Set();
  private allowedUsers: Set<string> = new Set();
  private streamMode: 'off' | 'edit' | 'block' = 'off';
  private reconnectAttempts = 0;
  private lastEditTimestamps = new Map<string, number>();

  // -----------------------------------------------------------------------
  // IChannel implementation
  // -----------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    if (this.running) return;

    const cfg = config as DiscordConfig;
    if (!cfg.token) {
      throw new Error('Discord channel requires a "token" in config');
    }

    this.token = cfg.token;
    this.intents = cfg.intents ?? DEFAULT_INTENTS;
    this.allowedGuilds = new Set(cfg.allowedGuilds ?? []);
    this.allowedUsers = new Set(cfg.allowedUsers ?? []);
    this.streamMode = cfg.streamMode ?? 'off';

    // Verify the token.
    const me = await this.apiCall<{ id: string; username: string }>('/users/@me');
    this.botUserId = me.id;

    // Connect to the Gateway.
    await this.connectGateway();
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.close(1000, 'Shutting down');
      } catch {
        // Ignore close errors.
      }
      this.ws = null;
    }
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    // Discord sends to channel IDs (groupId in our model).
    const channelId = to.groupId ?? to.threadId ?? to.userId;
    if (!channelId) {
      return { success: false, error: 'Recipient must have groupId, threadId, or userId (DM channel ID)' };
    }

    try {
      const chunks = splitMessage(message.text ?? '', DISCORD_MAX_MESSAGE_LEN);
      let lastId: string | undefined;

      for (const chunk of chunks) {
        const body: Record<string, unknown> = { content: chunk };

        // Only attach reply reference to the first chunk.
        if (!lastId && message.replyTo) {
          body.message_reference = { message_id: message.replyTo };
        }

        const result = await this.apiCall<DiscordMessage>(
          `/channels/${channelId}/messages`,
          'POST',
          body,
        );

        lastId = result.id;
      }

      return { success: true, messageId: lastId ?? '' };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Edit a previously sent message. Used for progressive streaming updates.
   * Rate-limited to avoid hitting Discord API limits.
   */
  async editMessage(to: Recipient, messageId: string, message: OutboundMessage): Promise<SendResult> {
    const channelId = to.groupId ?? to.threadId ?? to.userId;
    if (!channelId) {
      return { success: false, error: 'Recipient must have groupId, threadId, or userId' };
    }

    // Rate limit: skip if we edited this message too recently.
    const lastEdit = this.lastEditTimestamps.get(messageId);
    const now = Date.now();
    if (lastEdit && now - lastEdit < DISCORD_EDIT_RATE_LIMIT_MS) {
      return { success: true, messageId }; // Silently skip — not an error.
    }

    try {
      await this.apiCall<DiscordMessage>(
        `/channels/${channelId}/messages/${messageId}`,
        'PATCH',
        { content: truncateMessage(message.text ?? '', DISCORD_MAX_MESSAGE_LEN) },
      );

      this.lastEditTimestamps.set(messageId, now);
      return { success: true, messageId };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Get the current stream mode configuration.
   */
  getStreamMode(): 'off' | 'edit' | 'block' {
    return this.streamMode;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onPresence(handler: (event: PresenceEvent) => void): void {
    this.presenceHandler = handler;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.running) return false;
    try {
      await this.apiCall<{ id: string }>('/users/@me');
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Gateway WebSocket
  // -----------------------------------------------------------------------

  private async connectGateway(): Promise<void> {
    const url = this.resumeGatewayUrl ?? GATEWAY_URL;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);

      let identified = false;

      this.ws.on('message', (data: Buffer) => {
        try {
          const payload = JSON.parse(data.toString()) as {
            op: number;
            d: unknown;
            s: number | null;
            t: string | null;
          };

          if (payload.s !== null) {
            this.sequence = payload.s;
          }

          switch (payload.op) {
            case GatewayOp.HELLO: {
              const { heartbeat_interval } = payload.d as { heartbeat_interval: number };
              this.startHeartbeat(heartbeat_interval);

              if (this.sessionId && this.sequence !== null) {
                // Resume existing session.
                this.ws!.send(JSON.stringify({
                  op: GatewayOp.RESUME,
                  d: {
                    token: this.token,
                    session_id: this.sessionId,
                    seq: this.sequence,
                  },
                }));
              } else {
                // Identify as new session.
                this.ws!.send(JSON.stringify({
                  op: GatewayOp.IDENTIFY,
                  d: {
                    token: this.token,
                    intents: this.intents,
                    properties: {
                      os: 'linux',
                      browser: 'ch4p',
                      device: 'ch4p',
                    },
                  },
                }));
              }
              break;
            }

            case GatewayOp.HEARTBEAT_ACK:
              // Server acknowledged heartbeat.
              break;

            case GatewayOp.HEARTBEAT:
              // Server requested immediate heartbeat.
              this.sendHeartbeat();
              break;

            case GatewayOp.RECONNECT:
              // Server requested reconnection.
              this.reconnect();
              break;

            case GatewayOp.INVALID_SESSION: {
              const resumable = payload.d as boolean;
              if (!resumable) {
                this.sessionId = null;
                this.sequence = null;
              }
              this.reconnect();
              break;
            }

            case GatewayOp.DISPATCH:
              this.handleDispatch(payload.t!, payload.d);

              if (payload.t === 'READY') {
                const ready = payload.d as {
                  session_id: string;
                  resume_gateway_url: string;
                };
                this.sessionId = ready.session_id;
                this.resumeGatewayUrl = ready.resume_gateway_url;
                this.reconnectAttempts = 0;
                if (!identified) {
                  identified = true;
                  resolve();
                }
              }
              break;
          }
        } catch {
          // Ignore malformed messages.
        }
      });

      this.ws.on('error', (err: Error) => {
        if (!identified) {
          reject(err);
        }
      });

      this.ws.on('close', () => {
        if (this.running) {
          // Auto-reconnect with exponential backoff.
          this.reconnect();
        }
      });

      // Timeout for initial connection.
      setTimeout(() => {
        if (!identified) {
          reject(new Error('Discord gateway connection timed out'));
        }
      }, 30000);
    });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    // Send first heartbeat after a random jitter.
    setTimeout(() => this.sendHeartbeat(), Math.random() * intervalMs);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
  }

  private sendHeartbeat(): void {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({
        op: GatewayOp.HEARTBEAT,
        d: this.sequence,
      }));
    }
  }

  private reconnect(): void {
    this.reconnectAttempts++;
    const delayMs = Math.min(DISCORD_RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1), DISCORD_RECONNECT_MAX_MS);
    // jitter: ±20%
    const jitter = delayMs * 0.2 * (Math.random() * 2 - 1);

    if (this.ws) {
      try {
        this.ws.close(4000, 'Reconnecting');
      } catch {
        // Ignore.
      }
      this.ws = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.running) {
      setTimeout(() => {
        this.connectGateway().catch(() => {
          this.reconnect();
        });
      }, Math.max(0, delayMs + jitter));
    }
  }

  // -----------------------------------------------------------------------
  // Event dispatch
  // -----------------------------------------------------------------------

  private handleDispatch(event: string, data: unknown): void {
    switch (event) {
      case 'MESSAGE_CREATE':
        this.handleMessageCreate(data as DiscordMessage);
        break;

      case 'TYPING_START':
        this.handleTypingStart(data as DiscordTypingStart);
        break;
    }
  }

  private handleMessageCreate(msg: DiscordMessage): void {
    if (!this.messageHandler) return;

    // Ignore messages from the bot itself.
    if (msg.author.id === this.botUserId) return;
    if (msg.author.bot) return;

    // Enforce allowed guilds/users.
    if (msg.guild_id && this.allowedGuilds.size > 0 && !this.allowedGuilds.has(msg.guild_id)) {
      return;
    }
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(msg.author.id)) {
      return;
    }

    const attachments: Attachment[] = (msg.attachments ?? []).map((a) => ({
      type: this.classifyAttachment(a.content_type ?? '') as Attachment['type'],
      url: a.url,
      filename: a.filename,
      mimeType: a.content_type,
    }));

    const inbound: InboundMessage = {
      id: msg.id,
      channelId: this.id,
      from: {
        channelId: this.id,
        userId: msg.author.id,
        groupId: msg.channel_id,
      },
      text: msg.content,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo: msg.message_reference?.message_id,
      timestamp: new Date(msg.timestamp),
      raw: msg,
    };

    this.messageHandler(inbound);
  }

  private handleTypingStart(event: DiscordTypingStart): void {
    if (!this.presenceHandler) return;

    this.presenceHandler({
      userId: event.user_id,
      status: 'typing',
      channelId: event.channel_id,
    });
  }

  // -----------------------------------------------------------------------
  // REST API
  // -----------------------------------------------------------------------

  private async apiCall<T>(
    path: string,
    method: string = 'GET',
    body?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`Discord API error (${response.status}): ${text}`);
    }

    return (await response.json()) as T;
  }

  private classifyAttachment(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'file';
  }
}
