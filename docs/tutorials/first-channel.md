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

## Step 2: Store the Token Securely

Create (or edit) your secrets file at `~/.ch4p/.env`:

```bash
echo 'TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN_HERE' >> ~/.ch4p/.env
chmod 600 ~/.ch4p/.env
```

This keeps your token out of configuration files and version control.

---

## Step 3: Add Telegram to Configuration

Edit `~/.ch4p/config.json` and add a `channels` section. Reference the token via the environment variable:

```json
{
  "engines": {
    "default": "claude-cli"
  },
  "channels": {
    "telegram": {
      "token": "${TELEGRAM_BOT_TOKEN}",
      "mode": "polling",
      "pollInterval": 1000,
      "allowedUsers": []
    }
  },
  "gateway": {
    "port": 18789,
    "requirePairing": false,
    "allowPublicBind": false
  }
}
```

Setting `allowedUsers` to an empty array means anyone can message the bot for now. In production, restrict this to specific Telegram user IDs (e.g., `["497131680"]`).

Save and close the file.

---

## Step 4: Start the Gateway

Start the gateway:

```bash
ch4p gateway
```

ch4p automatically loads `~/.ch4p/.env` at startup, so you don't need to source it manually.

You will see the gateway boot with the Telegram channel:

```
  ch4p Gateway
  ==================================================

  Server listening on 127.0.0.1:18789
  Pairing       disabled
  Engine        claude-cli
  Memory        disabled

  Routes:
    GET    /health              - liveness probe
    POST   /sessions            - create a new session
    ...

  Channels:
    telegram    polling     started

  ch4p gateway ready — 1 channel active.
```

The gateway is now running. It polls Telegram for incoming messages and routes them to the agent.

---

## Step 5: Send a Message from Telegram

Open Telegram and search for your bot by its username (`@ch4p_assistant_bot`). Start a conversation and send:

```
Hello from Telegram!
```

In your terminal, you will see the message arrive and the agent process it. In Telegram, the bot replies with the agent's response.

---

## Step 6: Stop the Gateway

Press `Ctrl+C` in the terminal. The gateway performs a graceful shutdown, disconnecting all channels cleanly.

---

## What You Learned

1. **BotFather** — Telegram bots are created through BotFather, which gives you a token.
2. **Secrets management** — Tokens go in `~/.ch4p/.env` (auto-loaded at startup), referenced via `${VAR_NAME}` in config.
3. **Configuration** — Channel settings go in the `channels` section of `config.json`.
4. **Gateway** — `ch4p gateway` manages all external channel connections.
5. **Routing** — Messages flow from Telegram through the gateway to the agent and back.

---

## Next Steps

- Restrict who can talk to your bot: [Configure Security](../how-to/configure-security.md)
- Expose the gateway publicly with a tunnel: [Deploy the Gateway](../how-to/deploy-gateway.md)
- Add more channels: [Add a Channel](../how-to/add-channel.md)
- See all supported channels: [Interfaces Reference](../reference/interfaces.md)
