# How to Add a New Messaging Channel

This guide walks you through implementing the `IChannel` interface to connect ch4p to a new messaging surface.

---

## Prerequisites

- A working ch4p development environment
- API documentation for the target messaging platform
- Understanding of the platform's authentication model (tokens, OAuth, webhooks)

---

## Step 1: Create the Channel File

Create a new file in `packages/channels/src/`:

```bash
touch packages/channels/src/my-channel.ts
```

---

## Step 2: Implement IChannel

```typescript
import type {
  IChannel,
  ChannelConfig,
  Recipient,
  InboundMessage,
  OutboundMessage,
  SendResult,
  PresenceEvent,
} from '@ch4p/core';

export class MyChannel implements IChannel {
  readonly id = 'my-channel';
  readonly name = 'My Channel';

  private messageHandler?: (msg: InboundMessage) => void;

  async start(config: ChannelConfig): Promise<void> {
    // Set up API client, authenticate, validate credentials.
    // Begin listening for messages.
    // For polling-based platforms: start the poll loop.
    // For webhook-based platforms: register the webhook route.
  }

  async stop(): Promise<void> {
    // Disconnect gracefully. Close sockets, stop polling.
  }

  async send(to: Recipient, message: OutboundMessage): Promise<SendResult> {
    // Deliver a message to the platform.
    // Map ch4p's OutboundMessage to the platform's send API.
    return { success: true, messageId: '...' };
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onPresence?(handler: (event: PresenceEvent) => void): void {
    // Optional: handle presence events (typing, online/offline).
  }

  async isHealthy(): Promise<boolean> {
    // Return whether the channel connection is active and working.
    return true;
  }
}
```

---

## Step 3: Handle Incoming Messages

When a message arrives from the platform, normalize it and emit an event:

```typescript
private handlePlatformMessage(raw: PlatformMessage): void {
  const message: InboundMessage = {
    id: raw.messageId,
    channelId: this.id,
    from: {
      channelId: this.id,
      userId: raw.senderId,
    },
    text: this.extractContent(raw),
    timestamp: new Date(raw.timestamp),
    replyTo: raw.replyToId ?? undefined,
    attachments: this.extractAttachments(raw),
  };
  this.messageHandler?.(message);
}
```

---

## Step 4: Support Rich Content

If the platform supports rich content (images, files, embeds), handle outgoing formatting:

```typescript
async send(message: OutgoingMessage): Promise<void> {
  if (message.attachments?.length) {
    for (const attachment of message.attachments) {
      await this.sendAttachment(message.targetId, attachment);
    }
  }

  if (message.content) {
    const formatted = this.formatContent(message.content);
    await this.api.sendMessage(message.targetId, formatted);
  }
}

private formatContent(content: string): string {
  // Convert ch4p's markdown to platform-specific formatting.
  // Some platforms use their own markdown dialect.
  return content;
}
```

---

## Step 5: Implement Webhook or Polling

Choose the appropriate message ingestion strategy.

**Webhook-based** (preferred when available):

```typescript
async start(): Promise<void> {
  this.gateway.registerRoute(`/webhooks/${this.name}`, (req, res) => {
    const event = this.verifyWebhook(req);
    if (event.type === 'message') {
      this.handlePlatformMessage(event.data);
    }
    res.status(200).send('ok');
  });
}
```

**Polling-based:**

```typescript
async start(): Promise<void> {
  this.pollInterval = setInterval(async () => {
    const messages = await this.api.getUpdates(this.lastOffset);
    for (const msg of messages) {
      this.handlePlatformMessage(msg);
      this.lastOffset = msg.updateId + 1;
    }
  }, this.config.pollIntervalMs ?? 1000);
}
```

---

## Step 6: Register the Channel

Add to the channel registry in `packages/channels/src/index.ts`:

```typescript
import { MyChannel } from './my-channel.js';

export const channels = {
  telegram: TelegramChannel,
  discord: DiscordChannel,
  slack: SlackChannel,
  'my-channel': MyChannel,
};
```

---

## Step 7: Add Configuration Schema

Add channel-specific fields to the config schema:

```typescript
'my-channel': {
  enabled: { type: 'boolean', default: false },
  token: { type: 'string', required: true },
  allowedUsers: { type: 'string[]', default: [] },
  pollIntervalMs: { type: 'number', default: 1000 },
}
```

---

## Step 8: Test the Channel

```bash
ch4p doctor --channel my-channel
```

This validates:
- Authentication and connection
- Message send/receive round-trip
- User resolution
- Graceful shutdown

---

## Optional: Edit-Based Streaming

If the platform supports editing previously sent messages, you can implement the optional `editMessage()` method to enable progressive streaming. The gateway's `StreamHandler` will detect this capability automatically and stream the agent's response in-place instead of waiting for the complete answer.

```typescript
async editMessage(to: Recipient, messageId: string, message: OutboundMessage): Promise<SendResult> {
  // Rate limit to avoid hitting platform API limits (e.g., 1 edit/second).
  const now = Date.now();
  if (now - this.lastEditTime < 1000) {
    return { success: true, messageId }; // Skip, not an error.
  }

  await this.api.editMessage(messageId, message.text);
  this.lastEditTime = now;
  return { success: true, messageId };
}
```

Add `streamMode?: 'off' | 'edit' | 'block'` to your channel config to let users control streaming behavior.

---

## Common Pitfalls

- **Rate limits**: Most platforms enforce rate limits. Implement queuing with backpressure in `send()`.
- **Message size**: Platforms have character limits. Split long messages in `formatContent()`.
- **Reconnection**: Implement automatic reconnection for websocket-based channels.
- **User allowlisting**: Always respect `config.allowedUsers`. Drop messages from unauthorized users before emitting.
