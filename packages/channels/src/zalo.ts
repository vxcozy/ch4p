/**
 * ZaloChannel — Zalo Official Account channel adapter.
 *
 * Implements the IChannel interface for Zalo using the Official Account
 * Open API v3.0. Webhook-driven: Zalo sends HTTP POST events to the
 * gateway, and the channel sends responses via the OA messaging API.
 *
 * Configuration (via ChannelConfig):
 *   oaId           — Official Account ID (required)
 *   oaSecretKey    — OA Secret Key for webhook MAC verification (required)
 *   accessToken    — OA Access Token (required, obtained via OAuth)
 *   refreshToken   — Refresh token for auto-renewal (optional)
 *   appId          — Zalo App ID (required for token refresh and MAC)
 *   appSecret      — Zalo App Secret (required for token refresh)
 *   allowedUsers   — Array of allowed user IDs (empty = allow all)
 *
 * Supported features:
 *   - Text message receiving and sending
 *   - Reply-to support (Zalo does not have threading — replies go to same user)
 *   - Health check via test API call
 *   - Webhook MAC (SHA-256) verification
 *   - Access token auto-refresh
 *
 * Security:
 *   - HMAC-SHA256 webhook signature verification
 *   - Access token caching with auto-refresh
 */

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

export interface ZaloConfig extends ChannelConfig {
  oaId: string;
  oaSecretKey: string;
  accessToken: string;
  refreshToken?: string;
  appId: string;
  appSecret?: string;
  allowedUsers?: string[];
}

/** Zalo webhook event payload (relevant fields). */
interface ZaloWebhookEvent {
  app_id: string;
  user_id_by_app: string;
  event_name: string;
  timestamp: string;
  sender?: { id: string };
  recipient?: { id: string };
  message?: {
    msg_id: string;
    text?: string;
    attachments?: Array<{ type: string; payload?: { url?: string } }>;
  };
}

// API endpoints.
const OA_API_BASE = 'https://openapi.zalo.me/v3.0/oa';
const GRAPH_API_BASE = 'https://graph.zalo.me/v2.0';

// ---------------------------------------------------------------------------
// ZaloChannel
// ---------------------------------------------------------------------------

export class ZaloChannel implements IChannel {
  readonly id = 'zalo';
  readonly name = 'Zalo';

  private config: ZaloConfig | null = null;
  private messageHandler: ((msg: InboundMessage) => void) | null = null;

  // Access token cache (tokens expire after ~1 hour).
  private currentAccessToken: string | null = null;
  private tokenExpiry = 0;

  // ---------------------------------------------------------------------------
  // IChannel lifecycle
  // ---------------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    const cfg = config as ZaloConfig;

    if (!cfg.oaId || typeof cfg.oaId !== 'string') {
      throw new Error('ZaloChannel requires oaId in config.');
    }
    if (!cfg.oaSecretKey || typeof cfg.oaSecretKey !== 'string') {
      throw new Error('ZaloChannel requires oaSecretKey in config.');
    }
    if (!cfg.accessToken || typeof cfg.accessToken !== 'string') {
      throw new Error('ZaloChannel requires accessToken in config.');
    }
    if (!cfg.appId || typeof cfg.appId !== 'string') {
      throw new Error('ZaloChannel requires appId in config.');
    }

    this.config = cfg;
    this.currentAccessToken = cfg.accessToken;
    // Assume token is valid for 1 hour from start.
    this.tokenExpiry = Date.now() + 3600 * 1000;
  }

  async stop(): Promise<void> {
    this.messageHandler = null;
    this.currentAccessToken = null;
    this.tokenExpiry = 0;
    this.config = null;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    if (!this.config) {
      return { success: false, error: 'ZaloChannel not started.' };
    }

    const userId = to.userId;
    if (!userId) {
      return { success: false, error: 'Recipient must have userId for Zalo.' };
    }

    try {
      const token = await this.getAccessToken();

      const body = {
        recipient: { user_id: userId },
        message: { text: message.text },
      };

      const response = await fetch(`${OA_API_BASE}/message/cs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'access_token': token,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { success: false, error: `Zalo API ${response.status}: ${errText}` };
      }

      const result = await response.json() as { error: number; message: string; data?: { message_id?: string } };

      if (result.error !== 0) {
        return { success: false, error: `Zalo API error ${result.error}: ${result.message}` };
      }

      return { success: true, messageId: result.data?.message_id };
    } catch (err) {
      return { success: false, error: `Zalo send failed: ${(err as Error).message}` };
    }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.config) return false;
    try {
      const token = await this.getAccessToken();
      // Simple check: call OA info endpoint.
      const response = await fetch(`${OA_API_BASE}/getoa`, {
        method: 'GET',
        headers: { 'access_token': token },
      });
      if (!response.ok) return false;
      const result = await response.json() as { error: number };
      return result.error === 0;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound webhook handling
  // ---------------------------------------------------------------------------

  /**
   * Verify a Zalo webhook MAC signature.
   *
   * Zalo signs webhooks using SHA-256:
   *   mac = SHA256(appId + rawBody + timestamp + oaSecretKey)
   *
   * The signature is sent in the `mac` field of the event payload.
   */
  async verifyWebhookMac(rawBody: string, mac: string): Promise<boolean> {
    if (!this.config) return false;

    try {
      const { createHash } = await import('node:crypto');

      // Parse body to get timestamp and app_id.
      const parsed = JSON.parse(rawBody) as { app_id?: string; timestamp?: string };
      const appId = parsed.app_id ?? this.config.appId;
      const timestamp = parsed.timestamp ?? '';

      const baseString = `${appId}${rawBody}${timestamp}${this.config.oaSecretKey}`;
      const expected = createHash('sha256').update(baseString).digest('hex');

      return expected === mac;
    } catch {
      return false;
    }
  }

  /**
   * Process an inbound webhook event from Zalo.
   * Called by the gateway's channel webhook route.
   */
  handleIncomingEvent(event: ZaloWebhookEvent): void {
    if (!this.config || !this.messageHandler) return;

    // Only process user-sent text messages.
    if (event.event_name !== 'user_send_text') return;

    const text = event.message?.text;
    if (!text) return;

    const senderId = event.sender?.id ?? '';
    if (!senderId) return;

    // Access control: allowed users.
    if (this.config.allowedUsers?.length) {
      if (!this.config.allowedUsers.includes(senderId)) return;
    }

    const inbound: InboundMessage = {
      id: event.message?.msg_id ?? `zalo-${Date.now()}`,
      channelId: this.id,
      from: {
        channelId: this.id,
        userId: senderId,
      },
      text,
      timestamp: event.timestamp ? new Date(parseInt(event.timestamp, 10)) : new Date(),
      raw: event,
    };

    this.messageHandler(inbound);
  }

  // ---------------------------------------------------------------------------
  // Access token management
  // ---------------------------------------------------------------------------

  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer).
    if (this.currentAccessToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.currentAccessToken;
    }

    // Try to refresh if we have a refresh token.
    if (this.config?.refreshToken && this.config.appSecret) {
      try {
        return await this.refreshAccessToken();
      } catch {
        // Fall through to use current token.
      }
    }

    if (this.currentAccessToken) {
      return this.currentAccessToken;
    }

    throw new Error('ZaloChannel: no valid access token available.');
  }

  private async refreshAccessToken(): Promise<string> {
    if (!this.config?.refreshToken || !this.config.appSecret) {
      throw new Error('Cannot refresh: missing refreshToken or appSecret.');
    }

    const response = await fetch(`${GRAPH_API_BASE}/me/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        app_id: this.config.appId,
        grant_type: 'refresh_token',
        refresh_token: this.config.refreshToken,
        app_secret: this.config.appSecret,
      }).toString(),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Token refresh failed (${response.status}): ${errText}`);
    }

    const data = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: number;
      message?: string;
    };

    if (data.error && data.error !== 0) {
      throw new Error(`Token refresh error ${data.error}: ${data.message ?? 'unknown'}`);
    }

    if (!data.access_token) {
      throw new Error('Token refresh returned no access_token.');
    }

    this.currentAccessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;

    // Update refresh token if a new one was returned.
    if (data.refresh_token) {
      this.config.refreshToken = data.refresh_token;
    }

    return this.currentAccessToken;
  }
}
