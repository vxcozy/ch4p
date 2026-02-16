/**
 * IChannel — messaging channel contract
 *
 * Every messaging surface (CLI, Telegram, Discord, Slack, WhatsApp, webhook, webchat)
 * implements this interface. Adding a new channel is implementing this + config.
 */

export interface ChannelConfig {
  [key: string]: unknown;
}

export interface Recipient {
  channelId: string;
  userId?: string;
  groupId?: string;
  threadId?: string;
}

export interface InboundMessage {
  id: string;
  channelId: string;
  from: Recipient;
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  timestamp: Date;
  raw?: unknown;
}

export interface OutboundMessage {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  format?: 'text' | 'markdown' | 'html';
}

export interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video';
  url?: string;
  data?: Buffer;
  mimeType?: string;
  filename?: string;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface PresenceEvent {
  userId: string;
  status: 'online' | 'offline' | 'typing';
  channelId: string;
}

export interface IChannel {
  readonly id: string;
  readonly name: string;

  start(config: ChannelConfig): Promise<void>;
  stop(): Promise<void>;
  send(to: Recipient, message: OutboundMessage): Promise<SendResult>;
  onMessage(handler: (msg: InboundMessage) => void): void;
  onPresence?(handler: (event: PresenceEvent) => void): void;
  isHealthy(): Promise<boolean>;

  /**
   * Edit a previously sent message. Used for progressive streaming (edit-based).
   * Optional — channels that don't support message editing simply omit this.
   * The gateway detects capability via `channel.editMessage !== undefined`.
   */
  editMessage?(to: Recipient, messageId: string, message: OutboundMessage): Promise<SendResult>;
}
