/**
 * SlackChannel — Slack Bot channel adapter.
 *
 * Implements the IChannel interface for Slack using the Web API (for sending)
 * and Socket Mode or Events API (for receiving). Uses raw fetch() — zero
 * external dependencies.
 *
 * Configuration (via ChannelConfig):
 *   botToken       — Bot User OAuth Token (xoxb-*) (required)
 *   appToken       — App-Level Token (xapp-*) for Socket Mode (optional)
 *   signingSecret  — Signing secret for Events API webhook verification (optional)
 *   mode           — 'socket' | 'events' (default: 'socket' if appToken present)
 *   allowedChannels — Array of allowed channel IDs (empty = allow all)
 *   allowedUsers    — Array of allowed user IDs (empty = allow all)
 *
 * Supported features:
 *   - Text message receiving and sending
 *   - Thread support via replyTo (thread_ts)
 *   - Rich text formatting (mrkdwn)
 *   - Attachment support
 *   - Typing indicators (presence events)
 *   - Socket Mode for firewall-friendly connectivity
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

export interface SlackConfig extends ChannelConfig {
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  mode?: 'socket' | 'events';
  allowedChannels?: string[];
  allowedUsers?: string[];
  streamMode?: 'off' | 'edit' | 'block';
}

import { splitMessage, truncateMessage, evictOldTimestamps } from './message-utils.js';

const API_BASE = 'https://slack.com/api';
const SLACK_MAX_MESSAGE_LEN = 4_000;
const SLACK_EDIT_RATE_LIMIT_MS = 1_000;

const SLACK_RECONNECT_BASE_MS = 1_000;
const SLACK_RECONNECT_MAX_MS = 60_000;

/** Minimal Slack message event. */
interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
  bot_id?: string;
}

/** Minimal Slack file attachment. */
interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private?: string;
  size: number;
}

/** Slack Web API response shape. */
interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** Socket Mode envelope. */
interface SocketModeEnvelope {
  type: string;
  envelope_id?: string;
  payload?: {
    event?: SlackMessageEvent;
    type?: string;
  };
  retry_attempt?: number;
  retry_reason?: string;
}

// ---------------------------------------------------------------------------
// SlackChannel
// ---------------------------------------------------------------------------

export class SlackChannel implements IChannel {
  readonly id = 'slack';
  readonly name = 'Slack';

  private botToken = '';
  private appToken = '';
  private signingSecret = '';
  private streamMode: 'off' | 'edit' | 'block' = 'off';
  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private presenceHandler: ((event: PresenceEvent) => void) | null = null;
  private running = false;
  private ws: WebSocket | null = null;
  private botUserId: string | null = null;
  private allowedChannels: Set<string> = new Set();
  private allowedUsers: Set<string> = new Set();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private lastEditTimestamps = new Map<string, number>();
  private static readonly EDIT_TS_MAX_ENTRIES = 500;

  // -----------------------------------------------------------------------
  // IChannel implementation
  // -----------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    if (this.running) return;

    const cfg = config as SlackConfig;
    if (!cfg.botToken) {
      throw new Error('Slack channel requires a "botToken" in config');
    }

    this.botToken = cfg.botToken;
    this.appToken = cfg.appToken ?? '';
    this.signingSecret = cfg.signingSecret ?? '';
    this.streamMode = cfg.streamMode ?? 'off';
    this.allowedChannels = new Set(cfg.allowedChannels ?? []);
    this.allowedUsers = new Set(cfg.allowedUsers ?? []);

    // Verify the token and get bot user ID.
    const auth = await this.apiCall('auth.test');
    if (!auth.ok) {
      throw new Error(`Slack auth.test failed: ${auth.error ?? 'Unknown error'}`);
    }
    this.botUserId = auth.user_id as string;

    // Determine connection mode.
    const mode = cfg.mode ?? (this.appToken ? 'socket' : 'events');

    if (mode === 'socket') {
      if (!this.appToken) {
        throw new Error('Socket Mode requires an "appToken" (xapp-*) in config');
      }
      await this.connectSocketMode();
    }
    // In 'events' mode, the gateway handles incoming HTTP events.
    // The caller should invoke handleEventsPayload() from their route handler.

    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
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
    const channel = to.groupId ?? to.userId;
    if (!channel) {
      return { success: false, error: 'Recipient must have groupId or userId' };
    }

    try {
      const chunks = splitMessage(message.text ?? '', SLACK_MAX_MESSAGE_LEN);
      let lastTs: string | undefined;

      for (const chunk of chunks) {
        const params: Record<string, unknown> = {
          channel,
          text: chunk,
        };

        // Use mrkdwn formatting by default for Slack.
        if (message.format === 'markdown' || !message.format) {
          params.mrkdwn = true;
        }

        // Thread reply — only on first chunk.
        if (!lastTs && message.replyTo) {
          params.thread_ts = message.replyTo;
        }

        const result = await this.apiCall('chat.postMessage', params);

        if (!result.ok) {
          return { success: false, error: result.error ?? 'chat.postMessage failed' };
        }

        lastTs = result.ts as string;
      }

      // Send file attachments if present.
      if (message.attachments?.length) {
        for (const att of message.attachments) {
          await this.uploadFile(channel, att, message.replyTo);
        }
      }

      return {
        success: true,
        messageId: lastTs ?? '',
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }


  /** Edit a previously sent message. Used for progressive streaming updates. */
  async editMessage(to: Recipient, messageId: string, message: OutboundMessage): Promise<SendResult> {
    const channel = to.groupId ?? to.userId;
    if (!channel) {
      return { success: false, error: 'Recipient must have groupId or userId' };
    }
    // Rate limit: skip if we edited this message too recently.
    const lastEdit = this.lastEditTimestamps.get(messageId);
    const now = Date.now();
    if (lastEdit && now - lastEdit < SLACK_EDIT_RATE_LIMIT_MS) {
      return { success: true, messageId };
    }
    try {
      const result = await this.apiCall('chat.update', {
        channel,
        ts: messageId,
        text: truncateMessage(message.text ?? '', SLACK_MAX_MESSAGE_LEN),
      });
      if (!result.ok) {
        return { success: false, error: result.error ?? 'chat.update failed' };
      }
      this.lastEditTimestamps.set(messageId, now);
      evictOldTimestamps(this.lastEditTimestamps, SlackChannel.EDIT_TS_MAX_ENTRIES);
      return { success: true, messageId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Return the configured stream mode. */
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
      const result = await this.apiCall('auth.test');
      return result.ok === true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Events API webhook handler
  // -----------------------------------------------------------------------

  /**
   * Process an Events API payload from the gateway.
   * Call this from a gateway route handler when receiving POST /webhook/slack.
   *
   * Returns a response body:
   *   - For url_verification: returns { challenge } for Slack's verification.
   *   - For event_callback: processes the event and returns { ok: true }.
   */
  handleEventsPayload(
    body: Record<string, unknown>,
  ): { status: number; body: Record<string, unknown> } {
    const type = body.type as string;

    // URL verification challenge (one-time setup).
    if (type === 'url_verification') {
      return {
        status: 200,
        body: { challenge: body.challenge },
      };
    }

    // Event callback.
    if (type === 'event_callback') {
      const event = body.event as SlackMessageEvent | undefined;
      if (event) {
        this.processEvent(event);
      }
      return { status: 200, body: { ok: true } };
    }

    return { status: 200, body: { ok: true } };
  }

  /**
   * Verify a Slack request signature.
   * Uses the signing secret to validate that the request came from Slack.
   */
  async verifySignature(
    body: string,
    timestamp: string,
    signature: string,
  ): Promise<boolean> {
    if (!this.signingSecret) return true; // No secret configured, skip.

    const { createHmac } = await import('node:crypto');
    const baseString = `v0:${timestamp}:${body}`;
    const hash = createHmac('sha256', this.signingSecret)
      .update(baseString)
      .digest('hex');
    const expected = `v0=${hash}`;

    return expected === signature;
  }

  // -----------------------------------------------------------------------
  // Socket Mode
  // -----------------------------------------------------------------------

  private async connectSocketMode(): Promise<void> {
    // Get a WebSocket URL from Slack.
    const response = await fetch(`${API_BASE}/apps.connections.open`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const data = (await response.json()) as SlackApiResponse;
    if (!data.ok) {
      throw new Error(`Socket Mode connection failed: ${data.error ?? 'Unknown error'}`);
    }

    const wsUrl = data.url as string;
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      let connected = false;

      this.ws.on('open', () => {
        connected = true;
        this.reconnectAttempts = 0;
        // Clear any previous ping timer before creating a new one.
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        // Keep-alive pings every 30 seconds.
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === 1) {
            this.ws.ping();
          }
        }, 30_000);
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const envelope = JSON.parse(data.toString()) as SocketModeEnvelope;
          this.handleSocketEnvelope(envelope);
        } catch {
          // Ignore malformed messages.
        }
      });

      this.ws.on('error', (err: Error) => {
        if (!connected) {
          reject(err);
        }
      });

      this.ws.on('close', () => {
        if (this.running) {
          this.scheduleReconnect();
        }
      });

      setTimeout(() => {
        if (!connected) {
          reject(new Error('Slack Socket Mode connection timed out'));
        }
      }, 30000);
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(SLACK_RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1), SLACK_RECONNECT_MAX_MS);
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    setTimeout(() => {
      if (!this.running) return;
      this.connectSocketMode().catch(() => {
        this.scheduleReconnect();
      });
    }, Math.max(0, delay + jitter));
  }

  private handleSocketEnvelope(envelope: SocketModeEnvelope): void {
    // Acknowledge the envelope to Slack.
    if (envelope.envelope_id && this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({
        envelope_id: envelope.envelope_id,
      }));
    }

    if (envelope.type === 'events_api' && envelope.payload?.event) {
      this.processEvent(envelope.payload.event);
    }
  }

  // -----------------------------------------------------------------------
  // Event processing
  // -----------------------------------------------------------------------

  private processEvent(event: SlackMessageEvent): void {
    // Typing indicators.
    if (event.type === 'user_typing' && this.presenceHandler) {
      this.presenceHandler({
        userId: event.user ?? 'unknown',
        status: 'typing',
        channelId: event.channel,
      });
      return;
    }

    // Message events.
    if (event.type === 'message' && !event.subtype) {
      this.processMessage(event);
    }
  }

  private processMessage(event: SlackMessageEvent): void {
    if (!this.messageHandler) return;

    // Ignore bot messages (including ourselves).
    if (event.bot_id) return;
    if (event.user === this.botUserId) return;

    const userId = event.user ?? 'unknown';

    // Enforce allowed channels/users.
    if (this.allowedChannels.size > 0 && !this.allowedChannels.has(event.channel)) {
      return;
    }
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId)) {
      return;
    }

    const attachments: Attachment[] = (event.files ?? []).map((f) => ({
      type: this.classifyFile(f.mimetype) as Attachment['type'],
      url: f.url_private,
      filename: f.name,
      mimeType: f.mimetype,
    }));

    const inbound: InboundMessage = {
      id: event.ts,
      channelId: this.id,
      from: {
        channelId: this.id,
        userId,
        groupId: event.channel,
        threadId: event.thread_ts,
      },
      text: event.text ?? '',
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo: event.thread_ts,
      timestamp: new Date(parseFloat(event.ts) * 1000),
      raw: event,
    };

    this.messageHandler(inbound);
  }

  // -----------------------------------------------------------------------
  // Web API
  // -----------------------------------------------------------------------

  private async apiCall(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<SlackApiResponse> {
    const response = await fetch(`${API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: params ? JSON.stringify(params) : undefined,
    });

    return (await response.json()) as SlackApiResponse;
  }

  private async uploadFile(
    channel: string,
    att: Attachment,
    threadTs?: string,
  ): Promise<void> {
    // Use files.uploadV2 if we have the file data or URL.
    // For simplicity, share the URL as a text message if no data is available.
    if (att.url) {
      await this.apiCall('chat.postMessage', {
        channel,
        text: `📎 ${att.filename ?? 'attachment'}: ${att.url}`,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    }
  }

  private classifyFile(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'file';
  }
}
