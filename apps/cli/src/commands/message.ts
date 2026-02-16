/**
 * Message command -- send a message via a configured channel.
 *
 * Usage:
 *   ch4p message -c telegram "Hello, world!"
 *   ch4p message --channel discord "Check this out"
 *   ch4p message -c slack -t thread_123 "Reply in thread"
 *
 * This command sends a single outbound message through the specified
 * channel adapter. Channels must be configured in ~/.ch4p/config.json.
 */

import { loadConfig } from '../config.js';
import {
  TelegramChannel,
  DiscordChannel,
  SlackChannel,
  CliChannel,
  MatrixChannel,
  WhatsAppChannel,
  SignalChannel,
  IMessageChannel,
} from '@ch4p/channels';
import type { IChannel, OutboundMessage, Recipient } from '@ch4p/core';

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

// ---------------------------------------------------------------------------
// Channel factory
// ---------------------------------------------------------------------------

/**
 * Create a channel adapter instance by name.
 * Returns null if the channel type is unknown.
 */
function createChannelInstance(channelName: string): IChannel | null {
  switch (channelName) {
    case 'telegram':
      return new TelegramChannel();
    case 'discord':
      return new DiscordChannel();
    case 'slack':
      return new SlackChannel();
    case 'cli':
      return new CliChannel();
    case 'matrix':
      return new MatrixChannel();
    case 'whatsapp':
      return new WhatsAppChannel();
    case 'signal':
      return new SignalChannel();
    case 'imessage':
      return new IMessageChannel();
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface MessageArgs {
  channel: string | null;
  threadId: string | null;
  text: string | null;
}

function parseMessageArgs(args: string[]): MessageArgs {
  let channel: string | null = null;
  let threadId: string | null = null;
  let text: string | null = null;
  const textParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '-c' || arg === '--channel') {
      channel = args[i + 1] ?? null;
      i++;
      continue;
    }

    if (arg === '-t' || arg === '--thread') {
      threadId = args[i + 1] ?? null;
      i++;
      continue;
    }

    // Everything else is part of the message text.
    textParts.push(arg);
  }

  if (textParts.length > 0) {
    text = textParts.join(' ');
  }

  return { channel, threadId, text };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function message(args: string[]): Promise<void> {
  const parsed = parseMessageArgs(args);

  if (!parsed.channel) {
    console.error(`\n  ${RED}Error:${RESET} Channel is required.`);
    console.error(`  ${DIM}Usage: ch4p message -c <channel> "message text"${RESET}`);
    console.error(`  ${DIM}Example: ch4p message -c telegram "Hello!"${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  if (!parsed.text) {
    console.error(`\n  ${RED}Error:${RESET} Message text is required.`);
    console.error(`  ${DIM}Usage: ch4p message -c ${parsed.channel} "message text"${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${RED}Failed to load config:${RESET} ${errMessage}`);
    console.error(`  ${DIM}Run ${CYAN}ch4p onboard${DIM} to set up ch4p.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  // Check if the channel is configured.
  const channelConfig = config.channels[parsed.channel];
  if (!channelConfig) {
    const availableChannels = Object.keys(config.channels);
    console.error(`\n  ${RED}Error:${RESET} Channel "${parsed.channel}" is not configured.`);
    if (availableChannels.length > 0) {
      console.error(`  ${DIM}Available channels: ${availableChannels.join(', ')}${RESET}`);
    } else {
      console.error(`  ${DIM}No channels configured. Add channels to ~/.ch4p/config.json.${RESET}`);
      console.error(`  ${DIM}Example for Telegram:${RESET}`);
      console.error(`  ${DIM}  "channels": { "telegram": { "token": "BOT_TOKEN" } }${RESET}`);
    }
    console.error('');
    process.exitCode = 1;
    return;
  }

  // Create the channel adapter.
  const channel = createChannelInstance(parsed.channel);
  if (!channel) {
    console.error(`\n  ${RED}Error:${RESET} Unknown channel type "${parsed.channel}".`);
    console.error(`  ${DIM}Supported channels: telegram, discord, slack, cli${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  ${CYAN}${BOLD}ch4p Message${RESET}`);
  console.log(`  ${DIM}${'='.repeat(50)}${RESET}\n`);
  console.log(`  ${BOLD}Channel${RESET}   ${parsed.channel}`);
  if (parsed.threadId) {
    console.log(`  ${BOLD}Thread${RESET}    ${parsed.threadId}`);
  }
  console.log(`  ${BOLD}Message${RESET}   ${parsed.text}`);
  console.log('');

  // Start the channel adapter.
  try {
    console.log(`  ${DIM}Starting ${parsed.channel} channel...${RESET}`);
    await channel.start(channelConfig);
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error(`  ${RED}Failed to start channel:${RESET} ${errMessage}\n`);
    process.exitCode = 1;
    return;
  }

  // Build the outbound message.
  const outbound: OutboundMessage = {
    text: parsed.text,
    format: 'text',
  };

  // Build the recipient — for a simple CLI send, we use the channel's
  // default recipient info. The user can configure a default chat/channel ID
  // in their channel config (e.g., "chatId" for Telegram, "channelId" for Discord).
  const recipient: Recipient = {
    channelId: parsed.channel,
    userId: (channelConfig['chatId'] as string) ?? (channelConfig['defaultChatId'] as string) ?? undefined,
    groupId: (channelConfig['channelId'] as string) ?? (channelConfig['defaultChannelId'] as string) ?? undefined,
    threadId: parsed.threadId ?? undefined,
  };

  if (!recipient.userId && !recipient.groupId) {
    console.error(`  ${RED}Error:${RESET} No recipient specified.`);
    console.error(`  ${DIM}Add "chatId" or "defaultChatId" to your ${parsed.channel} channel config.${RESET}`);
    console.error(`  ${DIM}Example: "channels": { "${parsed.channel}": { "token": "...", "chatId": "123" } }${RESET}\n`);
    await channel.stop();
    process.exitCode = 1;
    return;
  }

  // Send the message.
  try {
    const result = await channel.send(recipient, outbound);

    if (result.success) {
      console.log(`  ${GREEN}${BOLD}Sent!${RESET}`);
      if (result.messageId) {
        console.log(`  ${DIM}Message ID: ${result.messageId}${RESET}`);
      }
    } else {
      console.error(`  ${RED}Failed to send:${RESET} ${result.error ?? 'Unknown error'}`);
      process.exitCode = 1;
    }
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error(`  ${RED}Send error:${RESET} ${errMessage}`);
    process.exitCode = 1;
  } finally {
    await channel.stop();
  }

  console.log('');
}
