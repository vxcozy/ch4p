# How to Deploy the Gateway

This guide covers deploying the ch4p gateway so external messaging channels (Telegram, Discord, Slack, etc.) can reach your agent.

---

## Prerequisites

- A working ch4p installation with at least one channel configured
- A machine with persistent uptime (server, VM, or always-on workstation)
- For webhook-based channels: a publicly accessible URL or a tunneling tool

---

## Start the Gateway

Run the gateway:

```bash
ch4p gateway
```

The gateway starts the HTTP server, connects all configured channels, and begins routing messages to the agent. You will see:

```
  ch4p Gateway
  ==================================================

  Server listening on 127.0.0.1:18789
  Pairing       disabled
  Engine        claude-cli
  Memory        disabled

  Routes:
    GET    /health              - liveness probe
    POST   /pair                - exchange pairing code for token
    GET    /sessions            - list active sessions
    POST   /sessions            - create a new session
    GET    /sessions/:id        - get session details
    POST   /sessions/:id/steer  - inject message into session
    DELETE /sessions/:id        - end a session

  Channels:
    telegram    polling     started
    discord     websocket   started
```

### Override the Port

Pass `--port` to override the configured port:

```bash
ch4p gateway --port 9000
```

---

## Configure a Tunnel

Webhook-based channels (Slack, some Telegram modes) require a publicly accessible URL. Use a tunnel to expose your local gateway.

### Option A: Cloudflare Tunnel

For persistent deployments, use Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:18789
```

Then set the webhook base URL in config:

```json
{
  "gateway": {
    "port": 18789,
    "webhookBaseUrl": "https://your-tunnel.trycloudflare.com"
  }
}
```

### Option B: Reverse Proxy

If your machine has a public IP and domain, use a reverse proxy:

```nginx
server {
    listen 443 ssl;
    server_name ch4p.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set the corresponding config:

```json
{
  "gateway": {
    "port": 18789,
    "webhookBaseUrl": "https://ch4p.yourdomain.com"
  }
}
```

---

## Configure Gateway Settings

Gateway configuration in `~/.ch4p/config.json`:

```json
{
  "gateway": {
    "port": 18789,
    "requirePairing": false,
    "allowPublicBind": false
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `18789` | HTTP server port |
| `requirePairing` | `false` | Require pairing code for new connections |
| `allowPublicBind` | `false` | Bind to `0.0.0.0` instead of `127.0.0.1` |

---

## Secrets Management

Store channel tokens in `~/.ch4p/.env` (not in the repo):

```bash
TELEGRAM_BOT_TOKEN=your-telegram-token
DISCORD_BOT_TOKEN=your-discord-token
```

Lock down permissions:

```bash
chmod 600 ~/.ch4p/.env
```

Reference tokens in `config.json` using `${VAR_NAME}` syntax:

```json
{
  "channels": {
    "telegram": {
      "token": "${TELEGRAM_BOT_TOKEN}"
    }
  }
}
```

ch4p automatically loads `~/.ch4p/.env` at startup, so just run:

```bash
ch4p gateway
```

Existing shell environment variables take precedence over `.env` values — you can still override with `export VAR=value && ch4p gateway` if needed.

---

## Run as a System Service

### Using systemd (Linux)

Create `/etc/systemd/system/ch4p-gateway.service`:

```ini
[Unit]
Description=ch4p Gateway
After=network.target

[Service]
Type=simple
User=youruser
EnvironmentFile=/home/youruser/.ch4p/.env
ExecStart=/usr/local/bin/ch4p gateway
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable ch4p-gateway
sudo systemctl start ch4p-gateway
```

### Using launchd (macOS)

Create `~/Library/LaunchAgents/com.ch4p.gateway.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ch4p.gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/ch4p</string>
        <string>gateway</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Load:

```bash
launchctl load ~/Library/LaunchAgents/com.ch4p.gateway.plist
```

---

## Verify the Deployment

Check the health endpoint:

```bash
curl http://localhost:18789/health
```

List active sessions:

```bash
curl http://localhost:18789/sessions
```

---

## Common Pitfalls

- **Port in use**: Kill stale processes with `lsof -ti:18789 | xargs kill -9` before restarting.
- **Firewall**: Ensure port 18789 (or your configured port) is accessible if not using a tunnel.
- **Webhook registration**: After changing the tunnel URL, re-register webhooks with each platform.
- **Memory**: The gateway holds message queues in memory. Monitor RSS on long-running instances.
- **TLS**: Always use HTTPS for webhook URLs. Most platforms reject plain HTTP.
- **Secrets**: Never commit tokens to the repository. Use `~/.ch4p/.env` with `${VAR_NAME}` references.
