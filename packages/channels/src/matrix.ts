/**
 * MatrixChannel — Matrix protocol channel adapter.
 *
 * Implements the IChannel interface for Matrix using MinimalMatrixClient,
 * a lightweight fetch()-based wrapper around the Matrix client-server API.
 * Zero third-party dependencies.
 *
 * Configuration (via ChannelConfig):
 *   homeserverUrl  — Matrix homeserver URL, e.g. "https://matrix.org" (required)
 *   accessToken    — Bot access token (required)
 *   allowedRooms   — Array of room IDs to restrict to (empty = allow all)
 *   allowedUsers   — Array of user IDs to restrict to, e.g. "@user:matrix.org" (empty = allow all)
 *   autoJoin       — Auto-accept room invitations (default: true)
 *
 * Supported features:
 *   - Text message receiving and sending
 *   - Markdown/HTML formatted messages via formatted_body
 *   - Attachment support (images, audio, video, files via m.image/m.audio/m.video/m.file)
 *   - Room and user filtering whitelists
 *   - Auto-join room invitations
 *   - Typing indicator presence events
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
import { generateId } from '@ch4p/core';
import { MinimalMatrixClient, type MatrixEvent } from './matrix-client.js';
import { evictOldTimestamps } from './message-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatrixConfig extends ChannelConfig {
  homeserverUrl: string;    // e.g. "https://matrix.org"
  accessToken: string;      // Bot access token
  allowedRooms?: string[];  // Room ID whitelist
  allowedUsers?: string[];  // User ID whitelist (e.g. "@user:matrix.org")
  autoJoin?: boolean;       // Auto-accept room invitations (default: true)
}

/** Matrix room event content for m.room.message events. */
interface MatrixMessageContent {
  msgtype: string;
  body: string;
  formatted_body?: string;
  format?: string;
  url?: string;               // mxc:// URL for media
  info?: {
    mimetype?: string;
    size?: number;
    w?: number;
    h?: number;
    duration?: number;
  };
  filename?: string;
  'm.relates_to'?: {
    'm.in_reply_to'?: { event_id: string };
  };
}

// ---------------------------------------------------------------------------
// MatrixChannel
// ---------------------------------------------------------------------------

export class MatrixChannel implements IChannel {
  readonly id = 'matrix';
  readonly name = 'Matrix';

  private client: MinimalMatrixClient | null = null;
  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private presenceHandler: ((event: PresenceEvent) => void) | null = null;
  private running = false;
  private allowedRooms: Set<string> = new Set();
  private allowedUsers: Set<string> = new Set();
  private botUserId: string | null = null;
  private lastEditTimestamps = new Map<string, number>();
  private static readonly EDIT_TS_MAX_ENTRIES = 500;

  // -----------------------------------------------------------------------
  // IChannel implementation
  // -----------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    if (this.running) return;

    const cfg = config as MatrixConfig;
    if (!cfg.homeserverUrl) {
      throw new Error('Matrix channel requires a "homeserverUrl" in config');
    }
    if (!cfg.accessToken) {
      throw new Error('Matrix channel requires an "accessToken" in config');
    }

    this.allowedRooms = new Set(cfg.allowedRooms ?? []);
    this.allowedUsers = new Set(cfg.allowedUsers ?? []);

    // Create the Matrix client.
    this.client = new MinimalMatrixClient(cfg.homeserverUrl, cfg.accessToken);

    // Set up auto-join if enabled (default: true).
    const autoJoin = cfg.autoJoin ?? true;
    if (autoJoin) {
      this.client.on('room.invite', (roomId: string) => {
        void this.client?.joinRoom(roomId).catch(() => {/* ignore join errors */});
      });
    }

    // Resolve the bot's own user ID to ignore our own messages.
    this.botUserId = await this.client.getUserId();

    // Register room message handler.
    this.client.on('room.message', (roomId: string, event: MatrixEvent) => {
      this.processEvent(roomId, event as unknown as { event_id: string; type: string; sender: string; room_id: string; origin_server_ts: number; content: MatrixMessageContent });
    });

    // Register typing event handler for presence.
    this.client.on('room.event', (roomId: string, event: MatrixEvent) => {
      if (event.type === 'm.typing') {
        this.handleTypingEvent(roomId, event as unknown as { event_id: string; type: string; sender: string; room_id: string; origin_server_ts: number; content: MatrixMessageContent });
      }
    });

    // Start the sync loop.
    await this.client.start();
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.client) {
      this.client.stop();
      this.client = null;
    }
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    const roomId = to.groupId ?? to.userId;
    if (!roomId) {
      return { success: false, error: 'Recipient must have groupId (room ID) or userId' };
    }

    if (!this.client) {
      return { success: false, error: 'Matrix client is not running' };
    }

    try {
      // Build the message content.
      const content: Record<string, unknown> = {};

      if (message.format === 'markdown' || message.format === 'html') {
        // Use m.notice for formatted messages (conventionally used by bots).
        content.msgtype = 'm.notice';
        content.body = message.text;
        content.format = 'org.matrix.custom.html';
        content.formatted_body = message.format === 'html'
          ? message.text
          : this.markdownToSimpleHtml(message.text);
      } else {
        content.msgtype = 'm.text';
        content.body = message.text;
      }

      // Add reply reference if present.
      if (message.replyTo) {
        content['m.relates_to'] = {
          'm.in_reply_to': { event_id: message.replyTo },
        };
      }

      const eventId = await this.client.sendMessage(roomId, content);

      // Send attachments if present.
      if (message.attachments?.length) {
        for (const att of message.attachments) {
          await this.sendAttachment(roomId, att);
        }
      }

      return {
        success: true,
        messageId: eventId ?? generateId(),
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }


  /** Edit a previously sent message using Matrix m.replace relation. */
  async editMessage(to: Recipient, messageId: string, message: OutboundMessage): Promise<SendResult> {
    const roomId = to.groupId ?? to.userId;
    if (!roomId) {
      return { success: false, error: 'Recipient must have groupId (room ID) or userId' };
    }
    if (!this.client) {
      return { success: false, error: 'Matrix client is not running' };
    }
    const lastEdit = this.lastEditTimestamps.get(messageId);
    const now = Date.now();
    const MATRIX_EDIT_RATE_LIMIT_MS = 1_000;
    if (lastEdit && now - lastEdit < MATRIX_EDIT_RATE_LIMIT_MS) {
      return { success: true, messageId };
    }
    try {
      const content: Record<string, unknown> = {
        msgtype: 'm.text',
        body: `* ${message.text}`,
      };
      const newEventId = await this.client.editMessage(roomId, messageId, content);
      this.lastEditTimestamps.set(messageId, now);
      evictOldTimestamps(this.lastEditTimestamps, MatrixChannel.EDIT_TS_MAX_ENTRIES);
      return { success: true, messageId: newEventId ?? messageId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onPresence(handler: (event: PresenceEvent) => void): void {
    this.presenceHandler = handler;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.running || !this.client) return false;
    try {
      // Verify the client can reach the homeserver by fetching our own user ID.
      await this.client.getUserId();
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Event processing
  // -----------------------------------------------------------------------

  private processEvent(roomId: string, event: { event_id: string; type: string; sender: string; room_id: string; origin_server_ts: number; content: MatrixMessageContent }): void {
    if (!this.messageHandler) return;

    // Only process m.room.message events.
    if (event.type !== 'm.room.message') return;

    const sender = event.sender;

    // Ignore messages from the bot itself.
    if (sender === this.botUserId) return;

    // Enforce allowedRooms if configured.
    if (this.allowedRooms.size > 0 && !this.allowedRooms.has(roomId)) {
      return;
    }

    // Enforce allowedUsers if configured.
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(sender)) {
      return;
    }

    const content = event.content;
    const msgtype = content.msgtype;

    // Extract text content.
    const text = content.body ?? '';

    // Build attachments based on msgtype.
    const attachments: Attachment[] = [];

    if (msgtype === 'm.image' || msgtype === 'm.audio' || msgtype === 'm.video' || msgtype === 'm.file') {
      attachments.push({
        type: this.classifyMsgtype(msgtype),
        url: content.url,
        mimeType: content.info?.mimetype,
        filename: content.filename ?? content.body,
      });
    }

    // Skip events with no text and no attachments.
    if (!text && attachments.length === 0) return;

    // Extract reply-to event ID if present.
    const replyTo = content['m.relates_to']?.['m.in_reply_to']?.event_id;

    const inbound: InboundMessage = {
      id: event.event_id,
      channelId: this.id,
      from: {
        channelId: this.id,
        userId: sender,
        groupId: roomId,
      },
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo,
      timestamp: new Date(event.origin_server_ts),
      raw: event,
    };

    this.messageHandler(inbound);
  }

  private handleTypingEvent(roomId: string, event: { event_id: string; type: string; sender: string; room_id: string; origin_server_ts: number; content: MatrixMessageContent }): void {
    if (!this.presenceHandler) return;

    // The m.typing event content has a user_ids array of currently typing users.
    const content = event.content as unknown as { user_ids?: string[] };
    const typingUsers = content.user_ids ?? [];

    for (const userId of typingUsers) {
      // Don't emit typing events for the bot itself.
      if (userId === this.botUserId) continue;

      this.presenceHandler({
        userId,
        status: 'typing',
        channelId: roomId,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async sendAttachment(roomId: string, att: Attachment): Promise<void> {
    if (!this.client) return;

    const msgtype = att.type === 'image' ? 'm.image' :
      att.type === 'audio' ? 'm.audio' :
        att.type === 'video' ? 'm.video' : 'm.file';

    const content: Record<string, unknown> = {
      msgtype,
      body: att.filename ?? 'attachment',
      url: att.url ?? '',
    };

    if (att.mimeType) {
      content.info = { mimetype: att.mimeType };
    }

    await this.client.sendMessage(roomId, content);
  }

  /**
   * Classify a Matrix msgtype to an Attachment type.
   *   m.image -> 'image'
   *   m.audio -> 'audio'
   *   m.video -> 'video'
   *   m.file  -> 'file'
   */
  private classifyMsgtype(msgtype: string): Attachment['type'] {
    switch (msgtype) {
      case 'm.image': return 'image';
      case 'm.audio': return 'audio';
      case 'm.video': return 'video';
      default: return 'file';
    }
  }

  /**
   * Convert simple markdown to basic HTML for formatted_body.
   * Handles bold, italic, code, and line breaks.
   */
  private markdownToSimpleHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }
}
