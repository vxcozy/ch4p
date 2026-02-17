/**
 * LogChannel — a minimal IChannel for cron and webhook triggers.
 *
 * Since cron jobs and webhook triggers don't have a reply surface
 * (no Discord/Telegram user to send back to), this channel simply
 * logs the response through the observer system.
 *
 * It implements the IChannel interface so it can be used anywhere
 * channels are expected, but send() is a no-op that logs the output.
 */

import type {
  IChannel,
  InboundMessage,
  OutboundMessage,
  Recipient,
  SendResult,
  ChannelConfig,
} from '@ch4p/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the log channel. */
export interface LogChannelOptions {
  /** Optional callback when a response is generated. */
  onResponse?: (recipient: Recipient, msg: OutboundMessage) => void;
}

// ---------------------------------------------------------------------------
// LogChannel
// ---------------------------------------------------------------------------

export class LogChannel implements IChannel {
  readonly id = 'log-channel';
  readonly name = 'log';
  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private readonly onResponseCb: LogChannelOptions['onResponse'];

  constructor(opts?: LogChannelOptions) {
    this.onResponseCb = opts?.onResponse;
  }

  // IChannel interface
  async start(_config: ChannelConfig): Promise<void> {
    // No-op — no external service to connect to.
  }

  async stop(): Promise<void> {
    this.messageHandler = null;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async send(to: Recipient, msg: OutboundMessage): Promise<SendResult> {
    // Log the response; optionally call the callback.
    this.onResponseCb?.(to, msg);
    return { success: true };
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  /**
   * Inject a synthetic inbound message (used by scheduler and webhooks).
   */
  injectMessage(msg: InboundMessage): void {
    this.messageHandler?.(msg);
  }
}
