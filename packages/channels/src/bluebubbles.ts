/**
 * BlueBubblesChannel — iMessage channel adapter via BlueBubbles server.
 *
 * Implements the IChannel interface for iMessage using the BlueBubbles
 * REST API. Webhook-driven: BlueBubbles server sends HTTP POST events to
 * the gateway, and the channel sends messages via the BlueBubbles REST API.
 *
 * Configuration (via ChannelConfig):
 *   host              — BlueBubbles server URL, e.g. "http://localhost:1234" (required)
 *   password          — BlueBubbles server password (required)
 *   allowedAddresses  — Phone/email whitelist (empty = allow all)
 *
 * Authentication: Password is passed as a query parameter (?password=xxx)
 * on all REST API calls (BlueBubbles API convention).
 *
 * Supported features:
 *   - Text message sending/receiving
 *   - Webhook-driven inbound via handleIncomingEvent()
 *   - Health check via GET /api/v1/server/info
 *
 * Limitations:
 *   - No editMessage() (iMessage doesn't support editing)
 *   - Requires macOS with BlueBubbles server installed
 *
 * Zero external dependencies.
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

export interface BlueBubblesConfig extends ChannelConfig {
  host: string;
  password: string;
  allowedAddresses?: string[];
}

/** Shape of a BlueBubbles webhook event (new-message type). */
export interface BlueBubblesEvent {
  type: string;
  data: {
    guid?: string;
    text?: string;
    handle?: { address?: string; id?: string };
    chats?: Array<{ guid?: string; chatIdentifier?: string; displayName?: string }>;
    dateCreated?: number;
    isFromMe?: boolean;
    attachments?: Array<{ guid?: string; mimeType?: string; transferName?: string }>;
  };
}

/** BlueBubbles API response for message send. */
interface SendResponse {
  status: number;
  message: string;
  data?: { guid?: string };
  error?: { message: string };
}

/** BlueBubbles server info response. */
interface ServerInfoResponse {
  status: number;
  data?: { os_version?: string; server_version?: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// BlueBubblesChannel
// ---------------------------------------------------------------------------

export class BlueBubblesChannel implements IChannel {
  readonly id = 'bluebubbles';
  readonly name = 'BlueBubbles';

  private config: BlueBubblesConfig | null = null;
  private messageHandler: ((msg: InboundMessage) => void) | null = null;

  // ---------------------------------------------------------------------------
  // IChannel lifecycle
  // ---------------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    const cfg = config as BlueBubblesConfig;

    if (!cfg.host || typeof cfg.host !== 'string') {
      throw new Error('BlueBubblesChannel requires host in config.');
    }
    if (!cfg.password || typeof cfg.password !== 'string') {
      throw new Error('BlueBubblesChannel requires password in config.');
    }

    // Normalize: strip trailing slash.
    cfg.host = cfg.host.replace(/\/+$/, '');
    this.config = cfg;

    // Verify connection on startup.
    await this.verifyConnection();
  }

  async stop(): Promise<void> {
    this.messageHandler = null;
    this.config = null;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    if (!this.config) {
      return { success: false, error: 'BlueBubblesChannel not started.' };
    }

    const chatGuid = to.groupId ?? to.channelId;
    if (!chatGuid) {
      return { success: false, error: 'No chat GUID specified.' };
    }

    try {
      const url = this.apiUrl(`/api/v1/message/text`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatGuid,
            message: message.text,
            tempGuid: `temp-${Date.now()}`,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          return { success: false, error: `BlueBubbles API ${response.status}: ${errText}` };
        }

        const result = await response.json() as SendResponse;
        if (result.status !== 200) {
          return { success: false, error: result.error?.message ?? result.message };
        }

        return { success: true, messageId: result.data?.guid };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return { success: false, error: `BlueBubbles send timed out after ${API_TIMEOUT_MS}ms.` };
      }
      return { success: false, error: `BlueBubbles send failed: ${(err as Error).message}` };
    }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.config) return false;

    try {
      const url = this.apiUrl('/api/v1/server/info');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return false;
        const data = await response.json() as ServerInfoResponse;
        return data.status === 200;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound event handling
  // ---------------------------------------------------------------------------

  /**
   * Process an inbound webhook event from BlueBubbles server.
   * Called by the gateway's channel webhook route.
   */
  handleIncomingEvent(event: BlueBubblesEvent): void {
    if (!this.config || !this.messageHandler) return;

    // Only process new-message events.
    if (event.type !== 'new-message') return;

    const data = event.data;
    if (!data || !data.text) return;

    // Skip messages from self.
    if (data.isFromMe) return;

    // Extract sender address.
    const senderAddress = data.handle?.address ?? data.handle?.id ?? '';
    if (!senderAddress) return;

    // Access control.
    if (this.config.allowedAddresses?.length) {
      if (!this.config.allowedAddresses.includes(senderAddress)) return;
    }

    // Determine chat context.
    const chat = data.chats?.[0];
    const chatGuid = chat?.guid ?? senderAddress;

    const inbound: InboundMessage = {
      id: data.guid ?? `bb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelId: chatGuid,
      from: {
        channelId: chatGuid,
        userId: senderAddress,
        groupId: chat?.chatIdentifier?.startsWith('chat') ? chatGuid : undefined,
      },
      text: data.text,
      timestamp: data.dateCreated ? new Date(data.dateCreated) : new Date(),
      raw: event,
    };

    this.messageHandler(inbound);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a full API URL with the password query parameter.
   */
  private apiUrl(path: string): string {
    const base = `${this.config!.host}${path}`;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}password=${encodeURIComponent(this.config!.password)}`;
  }

  /**
   * Verify the BlueBubbles server is reachable on startup.
   */
  private async verifyConnection(): Promise<void> {
    const healthy = await this.isHealthy();
    if (!healthy) {
      throw new Error(
        `Cannot connect to BlueBubbles server at ${this.config!.host}. ` +
        'Ensure the server is running and the password is correct.',
      );
    }
  }
}
