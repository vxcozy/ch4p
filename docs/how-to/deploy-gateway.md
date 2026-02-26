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

Use `ch4p install` to install the gateway as a persistent background service. It auto-detects your platform and uses the appropriate service manager — no sudo required.

```bash
ch4p install
```

This creates and starts the service, routes logs to `~/.ch4p/logs/`, and configures it to restart automatically after crashes.

| Command | Description |
|---------|-------------|
| `ch4p install` | Install and start the daemon |
| `ch4p install --status` | Show current service status |
| `ch4p install --logs` | Tail live logs |
| `ch4p install --uninstall` | Remove the daemon |

### Platforms

| Platform | Service manager | Unit location |
|----------|----------------|---------------|
| macOS | launchd user agent | `~/Library/LaunchAgents/com.ch4p.gateway.plist` |
| Linux | systemd user service | `~/.config/systemd/user/ch4p-gateway.service` |

No `sudo` is required on either platform — the service runs as your user and picks up tokens from `~/.ch4p/.env` automatically.

### Manual service files (advanced)

If you prefer to manage the service file yourself, the generated files are standard platform formats. Run `ch4p install` once, inspect the file, then customize as needed before reloading with `systemctl --user daemon-reload` (Linux) or `launchctl unload && launchctl load` (macOS).

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

## Graceful Shutdown

The gateway drains in-flight messages before exiting. When it receives `SIGINT` (Ctrl+C) or `SIGTERM`:

1. **Channels stop** — no new inbound messages are accepted.
2. **Drain** — active agent runs are given up to 30 seconds to complete. A warning is printed if the timeout expires with work still in flight.
3. **Cleanup** — tunnel, memory WAL checkpoint, observer flush.

This means a `systemd` or Docker rolling restart can send `SIGTERM` to the old process while the new one starts, and in-flight responses will still be delivered cleanly.

```ini
# /etc/systemd/system/ch4p.service
[Service]
ExecStart=/usr/local/bin/ch4p gateway
Restart=on-failure
TimeoutStopSec=40
KillMode=mixed
```

## Crash Recovery (Session Notes)

If the gateway crashes mid-run (OOM, SIGKILL, power loss) without a clean shutdown, **session notes** ensure the agent can resume from where it left off on the next start.

During each agent run the gateway writes a short progress note to `~/.ch4p/session-notes/` after every tool call. On restart it reads any surviving notes and replays a compact context summary so the agent can continue the interrupted task rather than starting from scratch.

Notes are automatically cleaned up when a session ends normally. No configuration is required — crash recovery is on by default.

## Docker Deployment

A `Dockerfile` and `docker-compose.yml` are included in the repository root.

### Quick start with Docker Compose

```bash
# 1. Copy your config
cp ~/.ch4p/config.json ./my-config.json

# 2. Start the gateway
CH4P_CONFIG=./my-config.json docker compose up -d

# 3. Tail logs
docker compose logs -f gateway
```

The gateway is exposed on port 3141 by default. Override with `CH4P_PORT=8080 docker compose up`.

### Health / readiness checks

The gateway exposes two probes:

| Path | Purpose |
|------|---------|
| `GET /health` | **Liveness** — returns 200 while the process is alive |
| `GET /ready` | **Readiness** — returns 200 once the server is fully up and accepting traffic |

Use `/health` for Docker / systemd restart decisions, `/ready` for load-balancer or Kubernetes readiness gates.

```bash
curl http://localhost:3141/health  # {"status":"ok","timestamp":"...","sessions":0}
curl http://localhost:3141/ready   # {"ready":true,"timestamp":"...","sessions":0}
```

For Kubernetes, add to your `Deployment`:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3141
  initialDelaySeconds: 5
  periodSeconds: 30
readinessProbe:
  httpGet:
    path: /ready
    port: 3141
  initialDelaySeconds: 3
  periodSeconds: 10
```

---

## Common Pitfalls

- **Port in use**: Kill stale processes with `lsof -ti:18789 | xargs kill -9` before restarting.
- **Firewall**: Ensure port 18789 (or your configured port) is accessible if not using a tunnel.
- **Webhook registration**: After changing the tunnel URL, re-register webhooks with each platform.
- **Memory**: The gateway holds message queues in memory. Monitor RSS on long-running instances.
- **TLS**: Always use HTTPS for webhook URLs. Most platforms reject plain HTTP.
- **Secrets**: Never commit tokens to the repository. Use `~/.ch4p/.env` with `${VAR_NAME}` references.
