/**
 * ZaloPersonalChannel — Zalo Personal Account channel adapter (lightweight bridge).
 *
 * ⚠️ WARNING: Zalo Personal uses an unofficial/reverse-engineered API.
 * Using this channel may violate Zalo's Terms of Service.
 * By enabling this channel, the user accepts full responsibility.
 *
 * This channel does NOT implement the unofficial Zalo API directly. Instead,
 * it acts as a lightweight REST bridge: the user runs their own Zalo automation
 * (e.g., via zca-js or similar) and ch4p communicates with that bridge via HTTP.
 *
 * Configuration (via ChannelConfig):
 *   bridgeUrl      — URL of the user's Zalo bridge server (required)
 *   bridgeToken    — Bearer token for authenticating with the bridge (optional)
 *   allowedUsers   — User ID whitelist (empty = allow all)
 *
 * Inbound: Webhook-driven — handleIncomingEvent() is called from the gateway
 *          webhook route when the user's bridge forwards a message.
 * Outbound: POST {bridgeUrl}/send with { to, text } body.
 * Health:  GET  {bridgeUrl}/health — healthy if bridge responds 200.
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

export interface ZaloPersonalConfig extends ChannelConfig {
  bridgeUrl: string;
  bridgeToken?: string;
  allowedUsers?: string[];
}

/** Shape of an inbound event from the user's Zalo bridge. */
export interface ZaloPersonalEvent {
  sender: string;
  text: string;
  attachments?: Array<{ type: string; url: string }>;
  timestamp?: number;
  messageId?: string;
  threadId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEND_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// ZaloPersonalChannel
// ---------------------------------------------------------------------------

export class ZaloPersonalChannel implements IChannel {
  readonly id = 'zalo-personal';
  readonly name = 'Zalo Personal';

  private config: ZaloPersonalConfig | null = null;
  private messageHandler: ((msg: InboundMessage) => void) | null = null;

  // ---------------------------------------------------------------------------
  // IChannel lifecycle
  // ---------------------------------------------------------------------------

  async start(config: ChannelConfig): Promise<void> {
    const cfg = config as ZaloPersonalConfig;

    if (!cfg.bridgeUrl || typeof cfg.bridgeUrl !== 'string') {
      throw new Error('ZaloPersonalChannel requires bridgeUrl in config.');
    }

    // Normalize: strip trailing slash.
    cfg.bridgeUrl = cfg.bridgeUrl.replace(/\/+$/, '');
    this.config = cfg;

    // Log TOS warning.
    console.warn(
      '\n⚠️  Zalo Personal channel uses an unofficial API.\n' +
      '   Using this channel may violate Zalo\'s Terms of Service.\n' +
      '   By enabling this, you accept full responsibility.\n',
    );

    // Verify bridge is reachable.
    try {
      const healthy = await this.isHealthy();
      if (!healthy) {
        console.warn('⚠️  Zalo Personal bridge is not responding at: ' + cfg.bridgeUrl);
      }
    } catch {
      console.warn('⚠️  Could not reach Zalo Personal bridge at: ' + cfg.bridgeUrl);
    }
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
      return { success: false, error: 'ZaloPersonalChannel not started.' };
    }

    const target = to.userId ?? to.channelId;
    if (!target) {
      return { success: false, error: 'No target specified.' };
    }

    try {
      const url = `${this.config.bridgeUrl}/send`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.config.bridgeToken) {
        headers['Authorization'] = `Bearer ${this.config.bridgeToken}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ to: target, text: message.text }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          return { success: false, error: `Bridge send failed (${response.status}): ${errText}` };
        }

        const result = await response.json().catch(() => ({})) as { messageId?: string };
        return { success: true, messageId: result.messageId ?? `zp-${Date.now()}` };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return { success: false, error: `Bridge send timed out after ${SEND_TIMEOUT_MS}ms.` };
      }
      return { success: false, error: `Bridge send failed: ${(err as Error).message}` };
    }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.config) return false;

    try {
      const url = `${this.config.bridgeUrl}/health`;
      const headers: Record<string, string> = {};
      if (this.config.bridgeToken) {
        headers['Authorization'] = `Bearer ${this.config.bridgeToken}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      try {
        const response = await fetch(url, { headers, signal: controller.signal });
        return response.ok;
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
   * Process an inbound event from the user's Zalo bridge.
   * Called by the gateway's channel webhook route.
   */
  handleIncomingEvent(event: ZaloPersonalEvent): void {
    if (!this.config || !this.messageHandler) return;

    // Validate required fields.
    if (!event.sender || !event.text) return;

    // Access control.
    if (this.config.allowedUsers?.length) {
      if (!this.config.allowedUsers.includes(event.sender)) return;
    }

    const inbound: InboundMessage = {
      id: event.messageId ?? `zp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelId: event.threadId ?? event.sender,
      from: {
        channelId: event.threadId ?? event.sender,
        userId: event.sender,
        groupId: event.threadId,
      },
      text: event.text,
      timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
      raw: event,
    };

    this.messageHandler(inbound);
  }
}
