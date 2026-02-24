/**
 * GoogleChatChannel — Google Chat channel adapter.
 *
 * Implements the IChannel interface for Google Workspace Chat using
 * service account authentication and the Google Chat REST API.
 * Webhook-driven: Google Chat sends HTTP POST events to the gateway,
 * and the channel sends responses via the Chat API.
 *
 * Configuration (via ChannelConfig):
 *   serviceAccountKey  — JSON string of the Google service account key (required)
 *   allowedSpaces      — Space ID whitelist (empty = allow all)
 *   allowedUsers       — User email whitelist (empty = allow all)
 *   verificationToken  — Token from Google Chat webhook config (optional)
 *
 * Authentication: Self-signed JWT using the service account private key,
 * exchanged for an access token via Google's OAuth2 token endpoint.
 *
 * Supported features:
 *   - Text message send/receive
 *   - editMessage() — Google Chat supports message updates
 *   - Webhook verification token validation
 *
 * Zero external dependencies — uses node:crypto for JWT signing.
 */

import { createSign } from 'node:crypto';
import { splitMessage, truncateMessage } from './message-utils.js';
import type {
  IChannel,
  ChannelConfig,
  Recipient,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '@ch4p/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoogleChatConfig extends ChannelConfig {
  serviceAccountKey: string;
  allowedSpaces?: string[];
  allowedUsers?: string[];
  verificationToken?: string;
}

/** Parsed service account key fields. */
interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Google Chat event payload (relevant fields). */
export interface GoogleChatEvent {
  type: string;
  eventTime?: string;
  token?: string;
  message?: {
    name?: string;
    sender?: {
      name?: string;
      displayName?: string;
      email?: string;
      type?: string;
    };
    createTime?: string;
    text?: string;
    argumentText?: string;
    thread?: { name?: string };
    space?: { name?: string; type?: string };
  };
  space?: { name?: string; type?: string };
  user?: { name?: string; displayName?: string; email?: string };
}

/** Google Chat API message response. */
interface ChatMessageResponse {
  name?: string;
  text?: string;
  error?: { code: number; message: string; status: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_CHAT_MAX_MESSAGE_LEN = 4_000;
const CHAT_API_BASE = 'https://chat.googleapis.com/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';
const API_TIMEOUT_MS = 15_000;
const JWT_LIFETIME_S = 3600; // 1 hour

// ---------------------------------------------------------------------------
// GoogleChatChannel
// ---------------------------------------------------------------------------

export class GoogleChatChannel implements IChannel {
  readonly id = 'googlechat';
  readonly name = 'Google Chat';

  private config: GoogleChatConfig | null = null;
  private messageHandler: ((msg: InboundMessage) => void) | null = null;

  // Service account credentials (parsed once on start).
  private serviceAccount: ServiceAccountKey | null = null;

  // OAuth token cache.
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  // ---------------------------------------------------------------------------
  // IChannel lifecycle
  // ---------------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    const cfg = config as GoogleChatConfig;

    if (!cfg.serviceAccountKey || typeof cfg.serviceAccountKey !== 'string') {
      throw new Error('GoogleChatChannel requires serviceAccountKey in config.');
    }

    // Parse the service account key JSON.
    try {
      this.serviceAccount = JSON.parse(cfg.serviceAccountKey) as ServiceAccountKey;
    } catch {
      throw new Error('GoogleChatChannel: serviceAccountKey must be valid JSON.');
    }

    if (!this.serviceAccount.client_email || !this.serviceAccount.private_key) {
      throw new Error('GoogleChatChannel: serviceAccountKey must contain client_email and private_key.');
    }

    this.config = cfg;

    // Warm the token cache.
    await this.getAccessToken();
  }

  async stop(): Promise<void> {
    this.messageHandler = null;
    this.accessToken = null;
    this.tokenExpiry = 0;
    this.serviceAccount = null;
    this.config = null;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    if (!this.config || !this.serviceAccount) {
      return { success: false, error: 'GoogleChatChannel not started.' };
    }

    // target should be a space name like "spaces/AAAA"
    const spaceName = to.groupId ?? to.channelId;
    if (!spaceName) {
      return { success: false, error: 'No space specified.' };
    }

    try {
      const token = await this.getAccessToken();
      const url = `${CHAT_API_BASE}/${spaceName}/messages`;

      const chunks = splitMessage(message.text ?? '', GOOGLE_CHAT_MAX_MESSAGE_LEN);
      let lastId: string | undefined;

      for (const chunk of chunks) {
        const body: Record<string, unknown> = { text: chunk };

        // If replying to a thread, include thread name.
        if (to.threadId) {
          body.thread = { name: to.threadId };
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            return { success: false, error: `Google Chat API ${response.status}: ${errText}` };
          }

          const result = await response.json() as ChatMessageResponse;
          if (result.error) {
            return { success: false, error: `Google Chat API error: ${result.error.message}` };
          }

          lastId = result.name;
        } finally {
          clearTimeout(timeoutId);
        }
      }

      return { success: true, messageId: lastId };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return { success: false, error: `Google Chat send timed out after ${API_TIMEOUT_MS}ms.` };
      }
      return { success: false, error: `Google Chat send failed: ${(err as Error).message}` };
    }
  }

  async editMessage(_to: Recipient, messageId: string, message: OutboundMessage): Promise<SendResult> {
    if (!this.config || !this.serviceAccount) {
      return { success: false, error: 'GoogleChatChannel not started.' };
    }

    try {
      const token = await this.getAccessToken();

      // messageId should be a full resource name like "spaces/AAAA/messages/BBBB"
      const url = `${CHAT_API_BASE}/${messageId}?updateMask=text`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ text: truncateMessage(message.text ?? '', GOOGLE_CHAT_MAX_MESSAGE_LEN) }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          return { success: false, error: `Google Chat edit API ${response.status}: ${errText}` };
        }

        return { success: true, messageId };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return { success: false, error: `Google Chat edit timed out after ${API_TIMEOUT_MS}ms.` };
      }
      return { success: false, error: `Google Chat edit failed: ${(err as Error).message}` };
    }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.config || !this.serviceAccount) return false;
    try {
      await this.getAccessToken();
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound event handling
  // ---------------------------------------------------------------------------

  /**
   * Process an inbound event from Google Chat webhook.
   * Called by the gateway's channel webhook route.
   */
  handleIncomingEvent(event: GoogleChatEvent): void {
    if (!this.config || !this.messageHandler) return;

    // Verify token if configured.
    if (this.config.verificationToken && event.token) {
      if (event.token !== this.config.verificationToken) return;
    }

    // Only process MESSAGE events.
    if (event.type !== 'MESSAGE') return;

    const msg = event.message;
    if (!msg?.text && !msg?.argumentText) return;

    // Skip bot messages.
    if (msg.sender?.type === 'BOT') return;

    const senderEmail = msg.sender?.email ?? '';

    // Access control: allowed users.
    if (this.config.allowedUsers?.length) {
      if (senderEmail && !this.config.allowedUsers.includes(senderEmail)) return;
    }

    // Access control: allowed spaces.
    const spaceName = msg.space?.name ?? event.space?.name ?? '';
    if (this.config.allowedSpaces?.length) {
      if (spaceName && !this.config.allowedSpaces.includes(spaceName)) return;
    }

    const text = msg.argumentText ?? msg.text ?? '';
    const senderId = msg.sender?.name ?? senderEmail;

    const inbound: InboundMessage = {
      id: msg.name ?? `gc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelId: spaceName,
      from: {
        channelId: spaceName,
        userId: senderId,
        groupId: msg.space?.type === 'ROOM' ? spaceName : undefined,
        threadId: msg.thread?.name,
      },
      text,
      timestamp: msg.createTime ? new Date(msg.createTime) : new Date(),
      raw: event,
    };

    this.messageHandler(inbound);
  }

  // ---------------------------------------------------------------------------
  // JWT token management
  // ---------------------------------------------------------------------------

  /** Get a valid access token, refreshing if needed. */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer).
    if (this.accessToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.accessToken;
    }

    if (!this.serviceAccount) {
      throw new Error('GoogleChatChannel not configured.');
    }

    // Create a self-signed JWT.
    const jwt = this.createJwt();

    // Exchange JWT for an access token.
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    });

    const tokenUrl = this.serviceAccount.token_uri ?? TOKEN_URL;
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Google token request failed (${response.status}): ${errText}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };

    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;

    return this.accessToken;
  }

  /** Create a self-signed JWT for the service account. */
  private createJwt(): string {
    const now = Math.floor(Date.now() / 1000);

    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };

    const payload = {
      iss: this.serviceAccount!.client_email,
      scope: CHAT_SCOPE,
      aud: this.serviceAccount!.token_uri ?? TOKEN_URL,
      iat: now,
      exp: now + JWT_LIFETIME_S,
    };

    const headerB64 = base64urlEncode(JSON.stringify(header));
    const payloadB64 = base64urlEncode(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    // Sign with the service account's private key.
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = signer.sign(this.serviceAccount!.private_key, 'base64');

    // Convert base64 to base64url.
    const signatureB64 = signature
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    return `${signingInput}.${signatureB64}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a string as base64url (no padding). */
function base64urlEncode(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
