/**
 * TelegramChannel — Telegram Bot API channel adapter.
 *
 * Implements the IChannel interface for Telegram using the Bot HTTP API.
 * Supports both long-polling and webhook message ingestion.
 *
 * Configuration (via ChannelConfig):
 *   token        — Bot API token (required)
 *   mode         — 'polling' | 'webhook' (default: 'polling')
 *   webhookUrl   — Full URL for webhook mode
 *   pollInterval — Polling interval in ms (default: 1000)
 *   allowedUsers — Array of allowed user IDs (empty = allow all)
 *
 * Uses raw fetch() — zero external dependencies.
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
import { splitMessage, truncateMessage, evictOldTimestamps } from './message-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramConfig extends ChannelConfig {
  token: string;
  mode?: 'polling' | 'webhook';
  webhookUrl?: string;
  /** Secret token for webhook signature verification. */
  webhookSecret?: string;
  pollInterval?: number;
  allowedUsers?: string[];
  /** Streaming mode: 'off' (default), 'edit' (progressive edits), 'block' (wait then send). */
  streamMode?: 'off' | 'edit' | 'block';
}

/** Webhook processing timeout in milliseconds. */
const WEBHOOK_TIMEOUT_MS = 8_000;

/** Minimum interval between message edits for streaming (Telegram rate limit). */
const TELEGRAM_MAX_MESSAGE_LEN = 4_096;
const TELEGRAM_EDIT_RATE_LIMIT_MS = 1_000;

/** Minimal Telegram API response shape. */
interface TelegramResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

/** Minimal Telegram Update object. */
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/** Minimal Telegram Message object. */
interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string };
  /** Present when the message belongs to a forum topic (supergroup with topics enabled). */
  message_thread_id?: number;
  /** True when the message is sent to a forum topic. */
  is_topic_message?: boolean;
  text?: string;
  date: number;
  photo?: Array<{ file_id: string; file_size?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  voice?: { file_id: string; duration: number; mime_type?: string };
  audio?: { file_id: string; duration: number; mime_type?: string; title?: string };
  video?: { file_id: string; duration: number; mime_type?: string };
  reply_to_message?: { message_id: number };
}

/** Telegram File response from getFile API. */
interface TelegramFile {
  file_id: string;
  file_size?: number;
  file_path?: string;
}

// ---------------------------------------------------------------------------
// TelegramChannel
// ---------------------------------------------------------------------------

export class TelegramChannel implements IChannel {
  readonly id = 'telegram';
  readonly name = 'Telegram';

  private token = '';
  private baseUrl = '';
  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollOffset = 0;
  private pollInterval = 1000;
  private allowedUsers: Set<string> = new Set();
  private abortController: AbortController | null = null;
  private webhookSecret: string | null = null;
  private streamMode: 'off' | 'edit' | 'block' = 'off';
  private lastEditTimestamps = new Map<string, number>();
  private static readonly EDIT_TS_MAX_ENTRIES = 500;

  // -----------------------------------------------------------------------
  // IChannel implementation
  // -----------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    if (this.running) return;

    const cfg = config as TelegramConfig;
    if (!cfg.token) {
      throw new Error('Telegram channel requires a "token" in config');
    }

    this.token = cfg.token;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    this.pollInterval = cfg.pollInterval ?? 1000;
    this.streamMode = cfg.streamMode ?? 'off';
    this.webhookSecret = cfg.webhookSecret ?? null;
    this.abortController = new AbortController();

    // Validate and warn about non-numeric allowedUsers entries.
    const userEntries = cfg.allowedUsers ?? [];
    for (const entry of userEntries) {
      if (!/^\d+$/.test(entry)) {
        console.warn(
          `[Telegram] allowedUsers entry "${entry}" is not a numeric Telegram user ID. ` +
          'Telegram identifies users by numeric ID, not username. This entry may never match.',
        );
      }
    }
    this.allowedUsers = new Set(userEntries);

    // Verify the token is valid.
    const me = await this.apiCall<{ id: number; username?: string }>('getMe');
    if (!me) {
      throw new Error('Failed to verify Telegram bot token (getMe returned null)');
    }

    const mode = cfg.mode ?? 'polling';

    if (mode === 'webhook') {
      if (!cfg.webhookUrl) {
        throw new Error('Webhook mode requires a "webhookUrl" in config');
      }
      const webhookParams: Record<string, unknown> = { url: cfg.webhookUrl };
      if (this.webhookSecret) {
        webhookParams.secret_token = this.webhookSecret;
      }
      await this.apiCall('setWebhook', webhookParams);
    } else {
      // Delete any existing webhook so polling works.
      await this.apiCall('deleteWebhook');
      this.startPolling();
    }

    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    const chatId = to.userId ?? to.groupId;
    if (!chatId) {
      return { success: false, error: 'Recipient must have userId or groupId' };
    }

    try {
      // Determine parse mode from format.
      const parseMode = message.format === 'markdown' ? 'MarkdownV2' :
        message.format === 'html' ? 'HTML' : undefined;

      const rawText = parseMode === 'MarkdownV2'
        ? this.escapeMarkdownV2(message.text)
        : message.text;

      // Split long messages into chunks that fit within Telegram's 4096-char limit.
      const chunks = splitMessage(rawText ?? '', TELEGRAM_MAX_MESSAGE_LEN);
      let lastMessageId: string | undefined;
      for (const chunk of chunks) {
        const params: Record<string, unknown> = {
          chat_id: chatId,
          text: chunk,
          ...(parseMode ? { parse_mode: parseMode } : {}),
          ...(message.replyTo && !lastMessageId ? { reply_to_message_id: Number(message.replyTo) } : {}),
          // Thread replies: send into the correct forum topic.
          ...(to.threadId ? { message_thread_id: Number(to.threadId) } : {}),
        };
        const result = await this.apiCall<TelegramMessage>('sendMessage', params);
        lastMessageId = result ? String(result.message_id) : undefined;
      }

      // Send attachments if present.
      if (message.attachments?.length) {
        for (const att of message.attachments) {
          await this.sendAttachment(chatId, att, to.threadId);
        }
      }

      return {
        success: true,
        messageId: lastMessageId ?? generateId(),
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Edit a previously sent message. Used for progressive streaming updates.
   * Rate-limited to avoid hitting Telegram API limits.
   */
  async editMessage(to: Recipient, messageId: string, message: OutboundMessage): Promise<SendResult> {
    const chatId = to.userId ?? to.groupId;
    if (!chatId) {
      return { success: false, error: 'Recipient must have userId or groupId' };
    }

    // Rate limit: skip if we edited this message too recently.
    const lastEdit = this.lastEditTimestamps.get(messageId);
    const now = Date.now();
    if (lastEdit && now - lastEdit < TELEGRAM_EDIT_RATE_LIMIT_MS) {
      return { success: true, messageId }; // Silently skip — not an error.
    }

    try {
      const parseMode = message.format === 'markdown' ? 'MarkdownV2' :
        message.format === 'html' ? 'HTML' : undefined;

      const rawEditText = parseMode === 'MarkdownV2'
        ? this.escapeMarkdownV2(message.text)
        : message.text;

      // Truncate to Telegram's limit; full content will be delivered via send() chunks.
      const text = truncateMessage(rawEditText ?? '', TELEGRAM_MAX_MESSAGE_LEN);

      await this.apiCall('editMessageText', {
        chat_id: chatId,
        message_id: Number(messageId),
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(to.threadId ? { message_thread_id: Number(to.threadId) } : {}),
      });

      this.lastEditTimestamps.set(messageId, now);
      evictOldTimestamps(this.lastEditTimestamps, TelegramChannel.EDIT_TS_MAX_ENTRIES);

      return { success: true, messageId };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onPresence(_handler: (event: PresenceEvent) => void): void {
    // Telegram Bot API doesn't provide real-time typing events.
  }

  async isHealthy(): Promise<boolean> {
    if (!this.running) return false;
    try {
      const me = await this.apiCall<{ id: number }>('getMe');
      return me !== null;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Webhook handler (called by the gateway when a webhook POST arrives)
  // -----------------------------------------------------------------------

  /**
   * Verify the X-Telegram-Bot-Api-Secret-Token header matches our configured secret.
   * Returns true if no secret is configured (verification disabled) or if the header matches.
   */
  verifyWebhookSecret(secretHeader?: string): boolean {
    if (!this.webhookSecret) return true; // No secret configured — verification disabled.
    return secretHeader === this.webhookSecret;
  }

  /**
   * Process a webhook update from Telegram.
   * Call this from a gateway route handler when receiving POST /webhook/telegram.
   *
   * @param update - The Telegram update object.
   * @param secretHeader - The X-Telegram-Bot-Api-Secret-Token header value (optional).
   */
  handleWebhookUpdate(update: TelegramUpdate, secretHeader?: string): void {
    // Verify webhook secret if configured. Silently reject mismatches.
    if (!this.verifyWebhookSecret(secretHeader)) {
      return;
    }

    if (update.message) {
      this.processMessage(update.message);
    }
  }

  /**
   * Get the webhook timeout value for gateway-level timeout enforcement.
   * The gateway should race its HTTP response against this timeout.
   */
  static get WEBHOOK_TIMEOUT_MS(): number {
    return WEBHOOK_TIMEOUT_MS;
  }

  /**
   * Get the current stream mode configuration.
   */
  getStreamMode(): 'off' | 'edit' | 'block' {
    return this.streamMode;
  }

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  private startPolling(): void {
    if (!this.running && !this.abortController) return;

    const poll = async () => {
      if (!this.running) return;

      try {
        const updates = await this.apiCall<TelegramUpdate[]>('getUpdates', {
          offset: this.pollOffset,
          timeout: 30,
          limit: 100,
        });

        if (updates && updates.length > 0) {
          for (const update of updates) {
            this.pollOffset = update.update_id + 1;
            if (update.message) {
              this.processMessage(update.message);
            }
          }
        }
      } catch {
        // Polling errors are non-fatal; retry on next tick.
      }

      if (this.running) {
        this.pollTimer = setTimeout(poll, this.pollInterval);
      }
    };

    this.pollTimer = setTimeout(poll, 0);
  }

  // -----------------------------------------------------------------------
  // Message processing
  // -----------------------------------------------------------------------

  private processMessage(msg: TelegramMessage): void {
    if (!this.messageHandler) return;

    const userId = msg.from ? String(msg.from.id) : 'unknown';

    // Enforce allowedUsers if configured.
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId)) {
      return;
    }

    const text = msg.text ?? '';
    if (!text && !msg.photo && !msg.document && !msg.voice && !msg.audio && !msg.video) return;

    const attachments: Attachment[] = [];
    if (msg.photo && msg.photo.length > 0) {
      // Use the largest photo (last in array).
      const largest = msg.photo[msg.photo.length - 1]!;
      attachments.push({
        type: 'image',
        url: largest.file_id, // Will need getFile() to resolve actual URL
        mimeType: 'image/jpeg',
      });
    }
    if (msg.document) {
      attachments.push({
        type: 'file',
        url: msg.document.file_id,
        filename: msg.document.file_name,
        mimeType: msg.document.mime_type,
      });
    }
    if (msg.voice) {
      attachments.push({
        type: 'audio',
        url: msg.voice.file_id,
        mimeType: msg.voice.mime_type ?? 'audio/ogg',
      });
    }
    if (msg.audio) {
      attachments.push({
        type: 'audio',
        url: msg.audio.file_id,
        mimeType: msg.audio.mime_type ?? 'audio/mpeg',
        filename: msg.audio.title,
      });
    }
    if (msg.video) {
      attachments.push({
        type: 'video',
        url: msg.video.file_id,
        mimeType: msg.video.mime_type ?? 'video/mp4',
      });
    }

    const isGroup = msg.chat.type !== 'private';
    const groupId = isGroup ? String(msg.chat.id) : undefined;
    // message_thread_id is present on topic messages in forum supergroups.
    const threadId = (isGroup && msg.is_topic_message && msg.message_thread_id !== undefined)
      ? String(msg.message_thread_id)
      : undefined;

    const inbound: InboundMessage = {
      id: String(msg.message_id),
      channelId: this.id,
      from: {
        channelId: this.id,
        userId,
        groupId,
        threadId,
      },
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      timestamp: new Date(msg.date * 1000),
      raw: msg,
    };

    this.messageHandler(inbound);
  }

  // -----------------------------------------------------------------------
  // API helpers
  // -----------------------------------------------------------------------

  private async apiCall<T>(method: string, params?: Record<string, unknown>): Promise<T | null> {
    const url = `${this.baseUrl}/${method}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: params ? JSON.stringify(params) : undefined,
      signal: this.abortController?.signal,
    });

    const data = (await response.json()) as TelegramResponse<T>;

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description ?? 'Unknown error'}`);
    }

    return data.result ?? null;
  }

  /**
   * Resolve a Telegram file_id to a downloadable URL.
   * Uses the getFile API to get the file_path, then constructs the full URL.
   */
  async getFileUrl(fileId: string): Promise<string | null> {
    try {
      const file = await this.apiCall<TelegramFile>('getFile', { file_id: fileId });
      if (file?.file_path) {
        return `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
      }
    } catch {
      // Failed to resolve file URL.
    }
    return null;
  }

  /**
   * Download a Telegram file by its file_id and return the raw Buffer.
   */
  async downloadFile(fileId: string): Promise<{ data: Buffer; mimeType: string } | null> {
    const url = await this.getFileUrl(fileId);
    if (!url) return null;

    try {
      const response = await fetch(url, { signal: this.abortController?.signal });
      if (!response.ok) return null;
      const arrayBuf = await response.arrayBuffer();
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      return { data: Buffer.from(arrayBuf), mimeType: contentType };
    } catch {
      return null;
    }
  }

  private async sendAttachment(chatId: string, att: Attachment, threadId?: string): Promise<void> {
    // Detect OGG/Opus audio and use sendVoice (Telegram voice message) instead of sendAudio.
    const isVoice =
      att.type === 'audio' &&
      (att.mimeType === 'audio/ogg' ||
       att.mimeType === 'audio/ogg; codecs=opus' ||
       att.filename?.endsWith('.ogg') ||
       att.filename?.endsWith('.oga'));

    let method: string;
    let paramKey: string;

    if (isVoice) {
      method = 'sendVoice';
      paramKey = 'voice';
    } else if (att.type === 'image') {
      method = 'sendPhoto';
      paramKey = 'photo';
    } else if (att.type === 'audio') {
      method = 'sendAudio';
      paramKey = 'audio';
    } else if (att.type === 'video') {
      method = 'sendVideo';
      paramKey = 'video';
    } else {
      method = 'sendDocument';
      paramKey = 'document';
    }

    await this.apiCall(method, {
      chat_id: chatId,
      [paramKey]: att.url ?? att.filename ?? '',
      ...(threadId ? { message_thread_id: Number(threadId) } : {}),
    });
  }

  /**
   * Escape special characters for Telegram MarkdownV2 parse mode.
   * Telegram requires escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
   */
  private escapeMarkdownV2(text: string): string {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
  }
}
