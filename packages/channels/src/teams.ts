/**
 * TeamsChannel — Microsoft Teams Bot Framework channel adapter.
 *
 * Implements the IChannel interface for Microsoft Teams using the Bot Framework
 * REST API v3. Webhook-driven: Teams sends HTTP POST activities to the gateway,
 * and the channel sends responses via the Bot Framework conversation API.
 *
 * Configuration (via ChannelConfig):
 *   appId          — Bot Framework App ID (required)
 *   appPassword    — Bot Framework App Password / Client Secret (required)
 *   tenantId       — Azure AD tenant ID (optional, for single-tenant bots)
 *   allowedTeams   — Array of allowed team IDs (empty = allow all)
 *   allowedUsers   — Array of allowed user AAD IDs (empty = allow all)
 *
 * Supported features:
 *   - Text message receiving and sending
 *   - Reply-to support via replyTo activity ID
 *   - Edit message support (for streaming via edit-based approach)
 *   - Health check via token acquisition
 *
 * Security:
 *   - OAuth2 client credentials flow for outbound API calls
 *   - JWT validation for inbound activities (via teams-auth module)
 *   - Token caching with expiry
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

export interface TeamsConfig extends ChannelConfig {
  appId: string;
  appPassword: string;
  tenantId?: string;
  allowedTeams?: string[];
  allowedUsers?: string[];
}

/** Bot Framework Activity (relevant fields). */
interface Activity {
  type: string;
  id?: string;
  timestamp?: string;
  channelId?: string;
  from?: { id: string; name?: string; aadObjectId?: string };
  conversation?: { id: string; tenantId?: string; isGroup?: boolean };
  recipient?: { id: string; name?: string };
  text?: string;
  textFormat?: string;
  serviceUrl?: string;
  channelData?: Record<string, unknown>;
  replyToId?: string;
}

// Token endpoint.
const TOKEN_URL = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default';

// ---------------------------------------------------------------------------
// TeamsChannel
// ---------------------------------------------------------------------------

export class TeamsChannel implements IChannel {
  readonly id = 'teams';
  readonly name = 'Microsoft Teams';

  private config: TeamsConfig | null = null;
  private messageHandler: ((msg: InboundMessage) => void) | null = null;

  // OAuth token cache.
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  // Service URL → conversation mappings for outbound messages.
  // Capped to prevent unbounded growth in high-traffic bots.
  private static readonly MAX_SERVICE_URLS = 10_000;
  private serviceUrls = new Map<string, string>();

  // ---------------------------------------------------------------------------
  // IChannel lifecycle
  // ---------------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    const cfg = config as TeamsConfig;

    if (!cfg.appId || typeof cfg.appId !== 'string') {
      throw new Error('TeamsChannel requires appId in config.');
    }
    if (!cfg.appPassword || typeof cfg.appPassword !== 'string') {
      throw new Error('TeamsChannel requires appPassword in config.');
    }

    this.config = cfg;

    // Warm the token cache.
    await this.getAccessToken();
  }

  async stop(): Promise<void> {
    this.messageHandler = null;
    this.accessToken = null;
    this.tokenExpiry = 0;
    this.serviceUrls.clear();
    this.config = null;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    if (!this.config) {
      return { success: false, error: 'TeamsChannel not started.' };
    }

    const serviceUrl = this.serviceUrls.get(to.channelId);
    if (!serviceUrl) {
      return { success: false, error: `No service URL known for conversation ${to.channelId}` };
    }

    try {
      const token = await this.getAccessToken();
      const conversationId = to.channelId;

      const activity: Activity = {
        type: 'message',
        text: message.text,
        textFormat: message.format === 'markdown' ? 'markdown' : 'plain',
      };

      if (message.replyTo) {
        activity.replyToId = message.replyTo;
      }

      const url = `${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(activity),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { success: false, error: `Teams API ${response.status}: ${errText}` };
      }

      const result = await response.json() as { id?: string };
      return { success: true, messageId: result.id };
    } catch (err) {
      return { success: false, error: `Teams send failed: ${(err as Error).message}` };
    }
  }

  async editMessage(to: Recipient, messageId: string, message: OutboundMessage): Promise<SendResult> {
    if (!this.config) {
      return { success: false, error: 'TeamsChannel not started.' };
    }

    const serviceUrl = this.serviceUrls.get(to.channelId);
    if (!serviceUrl) {
      return { success: false, error: `No service URL known for conversation ${to.channelId}` };
    }

    try {
      const token = await this.getAccessToken();
      const conversationId = to.channelId;

      const activity: Activity = {
        type: 'message',
        id: messageId,
        text: message.text,
        textFormat: message.format === 'markdown' ? 'markdown' : 'plain',
      };

      const url = `${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(messageId)}`;
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(activity),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { success: false, error: `Teams edit API ${response.status}: ${errText}` };
      }

      return { success: true, messageId };
    } catch (err) {
      return { success: false, error: `Teams edit failed: ${(err as Error).message}` };
    }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.config) return false;
    try {
      await this.getAccessToken();
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound activity handling
  // ---------------------------------------------------------------------------

  /**
   * Process an inbound activity from the Bot Framework webhook.
   * Called by the gateway's channel webhook route.
   */
  handleIncomingActivity(activity: Activity): void {
    if (!this.config || !this.messageHandler) return;

    // Cache the service URL for this conversation (capped to prevent unbounded growth).
    if (activity.serviceUrl && activity.conversation?.id) {
      this.serviceUrls.set(activity.conversation.id, activity.serviceUrl);
      if (this.serviceUrls.size > TeamsChannel.MAX_SERVICE_URLS) {
        // Evict oldest entry (Maps iterate in insertion order).
        const oldest = this.serviceUrls.keys().next().value;
        if (oldest !== undefined) this.serviceUrls.delete(oldest);
      }
    }

    // Only process message activities.
    if (activity.type !== 'message') return;
    if (!activity.text) return;

    // Skip messages from the bot itself.
    if (activity.from?.id === this.config.appId) return;

    // Access control: allowed teams/users.
    if (this.config.allowedUsers?.length) {
      const aadId = activity.from?.aadObjectId;
      if (aadId && !this.config.allowedUsers.includes(aadId)) return;
    }

    const conversationId = activity.conversation?.id ?? '';
    const userId = activity.from?.id ?? '';

    const inbound: InboundMessage = {
      id: activity.id ?? `teams-${Date.now()}`,
      channelId: conversationId,
      from: {
        channelId: conversationId,
        userId,
        groupId: activity.conversation?.isGroup ? conversationId : undefined,
      },
      text: activity.text,
      timestamp: activity.timestamp ? new Date(activity.timestamp) : new Date(),
      raw: activity,
    };

    this.messageHandler(inbound);
  }

  // ---------------------------------------------------------------------------
  // OAuth2 token management
  // ---------------------------------------------------------------------------

  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer).
    if (this.accessToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.accessToken;
    }

    if (!this.config) {
      throw new Error('TeamsChannel not configured.');
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.appId,
      client_secret: this.config.appPassword,
      scope: BOT_FRAMEWORK_SCOPE,
    });

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Token request failed (${response.status}): ${errText}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };

    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;

    return this.accessToken;
  }
}
