# Tutorial: Connecting Your First Channel (Telegram)

This tutorial connects ch4p to Telegram. By the end, you will send a message from the Telegram app and receive a response from your ch4p agent.

**Time required:** About 15 minutes.

**Prerequisites:** A working ch4p installation (complete the [Getting Started](getting-started.md) tutorial first). A Telegram account. The Telegram app on your phone or desktop.

---

## Step 1: Create a Telegram Bot

Open Telegram and search for `@BotFather`. Start a conversation with it and send:

```
/newbot
```

BotFather asks for a display name:

```
Alright, a new bot. How are we going to call it?
```

Type a name (this is the display name users see):

```
ch4p Assistant
```

BotFather asks for a username (must end in `bot`):

```
Good. Now let's choose a username for your bot.
```

```
ch4p_assistant_bot
```

BotFather responds with your bot token:

```
Done! ...
Use this token to access the HTTP API:
YOUR_BOT_TOKEN_HERE
```

Copy this token. You will need it in the next step.

---

## Step 2: Add the Token to Configuration

Open your ch4p configuration file:

```bash
ch4p agent --edit-config
```

This opens `~/.ch4p/config.json` in your default editor. Add a `channels` section with Telegram configured:

```json
{
  "agent": {
    "name": "ch4p"
  },
  "engine": {
    "provider": "anthropic",
    "apiKey": "sk-ant-xxxxx"
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "YOUR_BOT_TOKEN_HERE",
      "allowedUsers": []
    }
  }
}
```

Setting `allowedUsers` to an empty array means anyone can message the bot for now. In production, you would restrict this to specific Telegram user IDs.

Save and close the file.

---

## Step 3: Start the Gateway

The gateway is the process that manages external channel connections. Start it alongside the agent:

```bash
ch4p gateway
```

You will see the gateway boot with the Telegram channel:

```
[gateway] Starting gateway...
[gateway] Channel: telegram (polling mode)
[gateway] Telegram bot @ch4p_assistant_bot connected
[gateway] Agent "ch4p" ready on 1 channel.
```

The gateway is now running. It polls Telegram for incoming messages and routes them to the agent.

---

## Step 4: Send a Message from Telegram

Open Telegram and search for your bot by its username (`@ch4p_assistant_bot`). Start a conversation and send:

```
Hello from Telegram!
```

In your terminal, you will see the message arrive:

```
[telegram] Message from user 98765432: "Hello from Telegram!"
[agent] Processing message...
[agent] Response sent to telegram:98765432
```

In Telegram, you will see the agent's response appear as a message from the bot:

```
ch4p Assistant: Hello! I'm receiving your message through Telegram.
                   How can I help you today?
```

---

## Step 5: Test a Tool Execution

Send another message from Telegram:

```
What time is it?
```

If the agent has access to a time/date tool, it will execute it and respond. In `supervised` autonomy mode, the terminal shows the approval prompt:

```
[telegram] Message from user 98765432: "What time is it?"
[agent] Tool requested: system.datetime
[agent] Auto-approved (read-only tool)
[telegram] Response sent.
```

Read-only tools like `system.datetime` are auto-approved even in supervised mode. You will see the time appear as a response in Telegram.

---

## Step 6: Stop the Gateway

Press `Ctrl+C` in the terminal:

```
[gateway] Shutting down...
[gateway] Telegram bot disconnected.
[gateway] Gateway stopped.
```

---

## What You Learned

1. **BotFather** — Telegram bots are created through BotFather, which gives you a token.
2. **Configuration** — Channel tokens go in the `channels` section of `config.json`.
3. **Gateway** — `ch4p gateway` manages all external channel connections.
4. **Routing** — Messages flow from Telegram through the gateway to the agent and back.
5. **Autonomy** — Read-only tools execute without manual approval, even in supervised mode.

---

## Next Steps

- Restrict who can talk to your bot: [Configure Security](../how-to/configure-security.md)
- Expose the gateway publicly with a tunnel: [Deploy the Gateway](../how-to/deploy-gateway.md)
- Add more channels: [Add a Channel](../how-to/add-channel.md)
- See all supported channels: [Interfaces Reference](../reference/interfaces.md)
