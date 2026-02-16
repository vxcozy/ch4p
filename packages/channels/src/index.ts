/**
 * @ch4p/channels -- messaging channel implementations and registry
 */

export { CliChannel } from './cli.js';
export { TelegramChannel } from './telegram.js';
export type { TelegramConfig } from './telegram.js';
export { DiscordChannel, DiscordIntents } from './discord.js';
export type { DiscordConfig } from './discord.js';
export { SlackChannel } from './slack.js';
export type { SlackConfig } from './slack.js';
export { MatrixChannel } from './matrix.js';
export type { MatrixConfig } from './matrix.js';
export { WhatsAppChannel } from './whatsapp.js';
export type { WhatsAppConfig } from './whatsapp.js';
export { SignalChannel } from './signal.js';
export type { SignalConfig } from './signal.js';
export { IMessageChannel } from './imessage.js';
export type { IMessageConfig } from './imessage.js';

// Re-export channel-related types from core for convenience
export type {
  IChannel,
  ChannelConfig,
  InboundMessage,
  OutboundMessage,
  Recipient,
  SendResult,
  PresenceEvent,
} from '@ch4p/core';

import type { IChannel, ChannelConfig } from '@ch4p/core';

/**
 * ChannelRegistry -- central catalogue of available channels.
 *
 * Allows registering channel instances by id and retrieving or
 * listing them. `createFromConfig` instantiates a registered channel
 * and calls `start()` with the provided configuration.
 */
export class ChannelRegistry {
  private channels = new Map<string, IChannel>();

  /** Register a channel instance. Overwrites if id already exists. */
  register(channel: IChannel): void {
    this.channels.set(channel.id, channel);
  }

  /** Retrieve a channel by id. */
  get(id: string): IChannel | undefined {
    return this.channels.get(id);
  }

  /** Check whether a channel with the given id is registered. */
  has(id: string): boolean {
    return this.channels.has(id);
  }

  /** Return all registered channels. */
  list(): IChannel[] {
    return [...this.channels.values()];
  }

  /** Remove all registered channels. */
  clear(): void {
    this.channels.clear();
  }

  /**
   * Look up a channel by id, call `start()` with the supplied config,
   * and return the started channel.
   *
   * Throws if the channel id is not registered.
   */
  async createFromConfig(id: string, config: ChannelConfig): Promise<IChannel> {
    const channel = this.channels.get(id);
    if (!channel) {
      throw new Error(`Channel "${id}" is not registered`);
    }
    await channel.start(config);
    return channel;
  }
}
