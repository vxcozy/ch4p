/**
 * WhatsAppChannel — WhatsApp Cloud API channel adapter.
 *
 * Implements the IChannel interface for WhatsApp Business using the Meta
 * Cloud API (Graph API). Webhook-only — no polling. The gateway routes
 * incoming HTTP requests to handleWebhookVerification (GET) and
 * handleWebhookPayload (POST).
 *
 * Configuration (via ChannelConfig):
 *   accessToken    — Cloud API permanent access token (required)
 *   phoneNumberId  — WhatsApp Business phone number ID (required)
 *   verifyToken    — Webhook verification token you define (required)
 *   appSecret      — Facebook app secret for HMAC-SHA256 payload verification
 *   apiVersion     — Graph API version (default: 'v21.0')
 *   allowedNumbers — Phone number whitelist (empty = allow all)
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

export interface WhatsAppConfig extends ChannelConfig {
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret?: string;
  apiVersion?: string;
  allowedNumbers?: string[];
}

/** Graph API response wrapper. */
interface GraphApiResponse {
  messages?: Array<{ id: string }>;
  error?: { message: string; type: string; code: number };
}

/** Incoming webhook body from WhatsApp Cloud API. */
interface WebhookBody {
  object?: string;
  entry?: WebhookEntry[];
}

interface WebhookEntry {
  id: string;
  changes?: WebhookChange[];
}

interface WebhookChange {
  value?: WebhookValue;
  field?: string;
}

interface WebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: WhatsAppMessage[];
  statuses?: unknown[];
}

interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WhatsAppMedia;
  audio?: WhatsAppMedia;
  video?: WhatsAppMedia;
  document?: WhatsAppMedia & { filename?: string };
  sticker?: WhatsAppMedia;
  location?: { latitude: number; longitude: number; name?: string };
  contacts?: unknown[];
  context?: { message_id?: string };
}

interface WhatsAppMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
}

/** Media URL retrieval response. */
interface MediaUrlResponse {
  url?: string;
  mime_type?: string;
  sha256?: string;
  file_size?: number;
  id?: string;
  error?: { message: string };
}

const WA_MAX_MESSAGE_LEN = 4_096;
const WA_EDIT_RATE_LIMIT_MS = 1_000;

// ---------------------------------------------------------------------------
// WhatsAppChannel
// ---------------------------------------------------------------------------

export class WhatsAppChannel implements IChannel {
  readonly id = 'whatsapp';
  readonly name = 'WhatsApp';

  private accessToken = '';
  private phoneNumberId = '';
  private verifyToken = '';
  private appSecret = '';
  private apiVersion = 'v21.0';
  private allowedNumbers: Set<string> = new Set();
  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private running = false;
  private lastEditTimestamps = new Map<string, number>();
  private static readonly EDIT_TS_MAX_ENTRIES = 500;

  // -----------------------------------------------------------------------
  // IChannel implementation
  // -----------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    if (this.running) return;

    const cfg = config as WhatsAppConfig;
    if (!cfg.accessToken) {
      throw new Error('WhatsApp channel requires an "accessToken" in config');
    }
    if (!cfg.phoneNumberId) {
      throw new Error('WhatsApp channel requires a "phoneNumberId" in config');
    }
    if (!cfg.verifyToken) {
      throw new Error('WhatsApp channel requires a "verifyToken" in config');
    }

    this.accessToken = cfg.accessToken;
    this.phoneNumberId = cfg.phoneNumberId;
    this.verifyToken = cfg.verifyToken;
    this.appSecret = cfg.appSecret ?? '';
    this.apiVersion = cfg.apiVersion ?? 'v21.0';
    this.allowedNumbers = new Set(cfg.allowedNumbers ?? []);

    // WhatsApp is webhook-only — no polling loop to start.
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    const recipient = to.userId;
    if (!recipient) {
      return { success: false, error: 'Recipient must have a userId (phone number)' };
    }

    try {
      // Send attachments first if present.
      if (message.attachments?.length) {
        for (const att of message.attachments) {
          await this.sendAttachment(recipient, att);
        }
      }

      // Send the text body in chunks.
      if (message.text) {
        const chunks = splitMessage(message.text, WA_MAX_MESSAGE_LEN);
        let lastId: string | undefined;

        for (const chunk of chunks) {
          const body = {
            messaging_product: 'whatsapp',
            to: recipient,
            type: 'text' as const,
            text: { body: chunk },
            // Only attach reply context to the first chunk.
            ...(!lastId && message.replyTo ? { context: { message_id: message.replyTo } } : {}),
          };

          const result = await this.graphApiCall<GraphApiResponse>(
            `${this.phoneNumberId}/messages`,
            'POST',
            body,
          );

          lastId = result?.messages?.[0]?.id ?? lastId;
        }

        return {
          success: true,
          messageId: lastId ?? generateId(),
        };
      }

      return { success: true, messageId: generateId() };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }


  /** Edit a previously sent message using WhatsApp Cloud API. */
  async editMessage(to: Recipient, messageId: string, message: OutboundMessage): Promise<SendResult> {
    const recipient = to.userId;
    if (!recipient) {
      return { success: false, error: 'Recipient must have a userId (phone number)' };
    }
    const lastEdit = this.lastEditTimestamps.get(messageId);
    const now = Date.now();
    if (lastEdit && now - lastEdit < WA_EDIT_RATE_LIMIT_MS) {
      return { success: true, messageId };
    }
    try {
      const safeText = truncateMessage(message.text ?? '', WA_MAX_MESSAGE_LEN);
      await this.graphApiCall<GraphApiResponse>(
        `${this.phoneNumberId}/messages`,
        'POST',
        {
          messaging_product: 'whatsapp',
          to: recipient,
          type: 'text',
          text: { body: safeText },
          context: { message_id: messageId },
        },
      );
      this.lastEditTimestamps.set(messageId, now);
      evictOldTimestamps(this.lastEditTimestamps, WhatsAppChannel.EDIT_TS_MAX_ENTRIES);
      return { success: true, messageId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onPresence(_handler: (event: PresenceEvent) => void): void {
    // WhatsApp Cloud API does not expose real-time typing indicators.
  }

  async isHealthy(): Promise<boolean> {
    if (!this.running) return false;
    try {
      // Verify the phone number ID is reachable.
      const data = await this.graphApiCall<{ id?: string }>(
        this.phoneNumberId,
        'GET',
      );
      return data?.id !== undefined;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Webhook handlers (called by the gateway)
  // -----------------------------------------------------------------------

  /**
   * Handle the GET webhook verification challenge from Meta.
   * Call this from a gateway route handler when receiving GET /webhook/whatsapp.
   *
   * Returns the challenge string to echo back, or null if verification fails.
   */
  handleWebhookVerification(query: Record<string, string>): string | null {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === this.verifyToken) {
      return challenge ?? null;
    }

    return null;
  }

  /**
   * Process an incoming webhook POST payload from WhatsApp Cloud API.
   * Call this from a gateway route handler when receiving POST /webhook/whatsapp.
   */
  handleWebhookPayload(body: WebhookBody): void {
    if (body.object !== 'whatsapp_business_account') return;
    if (!body.entry) return;

    for (const entry of body.entry) {
      if (!entry.changes) continue;

      for (const change of entry.changes) {
        const value = change.value;
        if (!value?.messages) continue;

        // Build a contact name lookup.
        const contactNames = new Map<string, string>();
        if (value.contacts) {
          for (const contact of value.contacts) {
            if (contact.wa_id && contact.profile?.name) {
              contactNames.set(contact.wa_id, contact.profile.name);
            }
          }
        }

        for (const msg of value.messages) {
          this.processMessage(msg, contactNames);
        }
      }
    }
  }

  /**
   * Verify webhook payload signature using HMAC-SHA256 with the app secret.
   * The signature header from Meta is formatted as "sha256=<hex>".
   *
   * Uses lazy import of node:crypto (same pattern as Slack adapter).
   */
  async verifySignature(rawBody: string, signature: string): Promise<boolean> {
    if (!this.appSecret) return true; // No secret configured, skip.

    const { createHmac } = await import('node:crypto');
    const hash = createHmac('sha256', this.appSecret)
      .update(rawBody)
      .digest('hex');
    const expected = `sha256=${hash}`;

    return expected === signature;
  }

  // -----------------------------------------------------------------------
  // Media helpers
  // -----------------------------------------------------------------------

  /**
   * Download media by its Cloud API media ID.
   * Two-step process: first GET the media URL, then download the binary.
   *
   * Returns the raw Buffer and mime type, or null on failure.
   */
  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string } | null> {
    try {
      // Step 1: Retrieve the media URL.
      const meta = await this.graphApiCall<MediaUrlResponse>(mediaId, 'GET');
      if (!meta?.url) return null;

      // Step 2: Download the actual binary.
      const response = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });

      if (!response.ok) return null;

      const arrayBuf = await response.arrayBuffer();
      return {
        data: Buffer.from(arrayBuf),
        mimeType: meta.mime_type ?? 'application/octet-stream',
      };
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Message processing
  // -----------------------------------------------------------------------

  private processMessage(msg: WhatsAppMessage, _contactNames: Map<string, string>): void {
    if (!this.messageHandler) return;

    const sender = msg.from;

    // Enforce allowedNumbers if configured.
    if (this.allowedNumbers.size > 0 && !this.allowedNumbers.has(sender)) {
      return;
    }

    const text = this.extractText(msg);
    const attachments = this.extractAttachments(msg);

    // Skip messages with no text and no attachments.
    if (!text && attachments.length === 0) return;

    const inbound: InboundMessage = {
      id: msg.id,
      channelId: this.id,
      from: {
        channelId: this.id,
        userId: sender,
      },
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo: msg.context?.message_id,
      timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      raw: msg,
    };

    this.messageHandler(inbound);
  }

  private extractText(msg: WhatsAppMessage): string {
    switch (msg.type) {
      case 'text':
        return msg.text?.body ?? '';
      case 'image':
        return msg.image?.caption ?? '';
      case 'video':
        return msg.video?.caption ?? '';
      case 'document':
        return msg.document?.caption ?? '';
      case 'location': {
        const loc = msg.location;
        if (!loc) return '';
        const label = loc.name ? `${loc.name}: ` : '';
        return `${label}${loc.latitude},${loc.longitude}`;
      }
      default:
        return '';
    }
  }

  private extractAttachments(msg: WhatsAppMessage): Attachment[] {
    const attachments: Attachment[] = [];

    if (msg.image) {
      attachments.push({
        type: 'image',
        url: msg.image.id, // Cloud API media ID — resolve via downloadMedia()
        mimeType: msg.image.mime_type,
      });
    }

    if (msg.audio) {
      attachments.push({
        type: 'audio',
        url: msg.audio.id,
        mimeType: msg.audio.mime_type,
      });
    }

    if (msg.video) {
      attachments.push({
        type: 'video',
        url: msg.video.id,
        mimeType: msg.video.mime_type,
      });
    }

    if (msg.document) {
      attachments.push({
        type: 'file',
        url: msg.document.id,
        mimeType: msg.document.mime_type,
        filename: msg.document.filename,
      });
    }

    if (msg.sticker) {
      attachments.push({
        type: 'image',
        url: msg.sticker.id,
        mimeType: msg.sticker.mime_type,
      });
    }

    return attachments;
  }

  // -----------------------------------------------------------------------
  // Outbound attachment sending
  // -----------------------------------------------------------------------

  private async sendAttachment(recipient: string, att: Attachment): Promise<void> {
    // If we have raw binary data, upload to Meta first.
    if (att.data) {
      const mediaId = await this.uploadMedia(att);
      if (!mediaId) return;

      const waType = this.attachmentTypeToWaType(att.type);
      const body: Record<string, unknown> = {
        messaging_product: 'whatsapp',
        to: recipient,
        type: waType,
        [waType]: { id: mediaId },
      };

      await this.graphApiCall(`${this.phoneNumberId}/messages`, 'POST', body);
      return;
    }

    // If we have a URL, send as a link-based media message.
    if (att.url) {
      const waType = this.attachmentTypeToWaType(att.type);
      const mediaObj: Record<string, unknown> = { link: att.url };
      if (att.filename) mediaObj.filename = att.filename;

      const body: Record<string, unknown> = {
        messaging_product: 'whatsapp',
        to: recipient,
        type: waType,
        [waType]: mediaObj,
      };

      await this.graphApiCall(`${this.phoneNumberId}/messages`, 'POST', body);
    }
  }

  private attachmentTypeToWaType(type: Attachment['type']): string {
    switch (type) {
      case 'image': return 'image';
      case 'audio': return 'audio';
      case 'video': return 'video';
      case 'file': return 'document';
    }
  }

  /**
   * Upload binary media to Meta's media endpoint.
   * Returns the media ID on success, or null on failure.
   */
  private async uploadMedia(att: Attachment): Promise<string | null> {
    if (!att.data) return null;

    try {
      const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/media`;

      // Build multipart/form-data manually to avoid external dependencies.
      const boundary = `----ch4p${Date.now()}${Math.random().toString(36).slice(2)}`;
      const mimeType = att.mimeType ?? 'application/octet-stream';
      const filename = att.filename ?? 'upload';

      const preamble =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="messaging_product"\r\n\r\n` +
        `whatsapp\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="type"\r\n\r\n` +
        `${mimeType}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`;

      const epilogue = `\r\n--${boundary}--\r\n`;

      const preambleBuf = Buffer.from(preamble, 'utf-8');
      const epilogueBuf = Buffer.from(epilogue, 'utf-8');
      const bodyBuf = Buffer.concat([preambleBuf, att.data, epilogueBuf]);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: bodyBuf,
      });

      const data = (await response.json()) as { id?: string; error?: { message: string } };
      return data.id ?? null;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Graph API helper
  // -----------------------------------------------------------------------

  private async graphApiCall<T>(
    endpoint: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<T | null> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${endpoint}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
    };

    const init: RequestInit = { method, headers };

    if (body && method === 'POST') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);
    const data = (await response.json()) as T & { error?: { message: string; code: number } };

    if ((data as any).error) {
      const err = (data as any).error;
      throw new Error(`WhatsApp API error: ${err.message ?? 'Unknown error'} (code ${err.code})`);
    }

    return data;
  }
}
