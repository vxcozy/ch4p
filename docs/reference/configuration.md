# Reference: Configuration

ch4p is configured via `~/.ch4p/config.json`. This document lists every field, its type, default value, and valid options.

### Environment variable resolution

String values can reference environment variables with `${VAR_NAME}` syntax. For example, `"apiKey": "${ANTHROPIC_API_KEY}"` resolves to the value of `ANTHROPIC_API_KEY` from the environment. Missing variables resolve to an empty string.

ch4p automatically loads `~/.ch4p/.env` at startup before resolving these references. The `.env` file supports `KEY=value` pairs, `#` comments, quoted values, and the optional `export` prefix. Shell environment variables always take precedence — values already set in the environment are never overwritten by `.env`.

---

## Top-Level Structure

```json
{
  "agent": { },
  "engine": { },
  "channels": { },
  "memory": { },
  "security": { },
  "gateway": { },
  "logging": { }
}
```

---

## agent

Agent identity and behavior.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | `"ch4p"` | Agent display name. |
| `systemPrompt` | `string` | `null` | Custom system prompt prepended to all conversations. |
| `autonomy` | `string` | `"supervised"` | Autonomy level: `"locked"`, `"supervised"`, `"autonomous"`. |
| `maxTurns` | `number` | `20` | Maximum tool-use turns per message. |
| `responseTimeout` | `number` | `60000` | Max time in ms to wait for a complete response. |
| `verifier` | `string` | `null` | Task-level verifier ID: `null` (disabled) or a verifier ID. |
| `enableStateSnapshots` | `boolean` | `true` | Capture state snapshots before/after tool execution for verification. |
| `contextStrategy` | `string\|object` | `"sliding"` | Context compaction strategy. See [Named Strategies](#named-context-strategies). |
| `maxToolResults` | `number` | `30` | Max tool result records kept per run for verification. Oldest evicted first. Increase for long autonomous runs. |
| `maxToolOutputLen` | `number` | `65536` | Max tool output/error length (bytes) per result. Must be at least 1024. |
| `maxStateRecords` | `number` | `20` | Max state snapshot records per run for verification. Oldest evicted first. |
| `maxSessionErrors` | `number` | `20` | Max session error records before FIFO eviction. |
| `runTimeout` | `number` | `300000` | Max duration (ms) for a single gateway agent run before abort. Must be at least 30000 (30s). |

### Named Context Strategies

The `contextStrategy` field accepts either a simple string (`"drop_oldest"`, `"summarize"`, `"sliding"`) or a named strategy object for fine-grained control:

```json
{
  "agent": {
    "contextStrategy": {
      "name": "coding_session",
      "type": "sliding",
      "compactionTarget": 0.6,
      "keepRatio": 0.4,
      "preserveRecentToolPairs": 4,
      "preserveTaskDescription": true
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | required | Unique name for this strategy. |
| `type` | `string` | required | Base strategy: `"drop_oldest"`, `"summarize"`, `"sliding"`. |
| `compactionTarget` | `number` | `0.6` | Compact to this fraction of maxTokens. |
| `keepRatio` | `number` | `0.3` | Fraction of messages to keep verbatim (summarize/sliding). |
| `pinnedRoles` | `string[]` | `[]` | Message roles that are never compacted away. |
| `preserveRecentToolPairs` | `number` | `3` | Recent tool-call/result pairs to always preserve. |
| `preserveTaskDescription` | `boolean` | `true` | Always keep the first user message. |

Built-in named strategies: `sliding_window_3`, `sliding_conservative`, `summarize_coding`, `drop_oldest_pinned`.

---

## engine

LLM provider configuration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `string` | **required** | Provider name: `"anthropic"`, `"openai"`, `"ollama"`, or custom. |
| `apiKey` | `string` | `null` | API key for the provider. Not required for local providers. |
| `baseUrl` | `string` | provider default | Override the API base URL. |
| `model` | `string` | provider default | Model identifier (e.g., `"claude-sonnet-4-6"`, `"gpt-4o"`). |
| `maxTokens` | `number` | `4096` | Maximum tokens in completion response. |
| `temperature` | `number` | `0.7` | Sampling temperature (0.0 - 2.0). |
| `topP` | `number` | `1.0` | Nucleus sampling parameter. |
| `timeout` | `number` | `30000` | API request timeout in ms. |
| `retries` | `number` | `3` | Number of retry attempts on transient failures. |
| `retryDelay` | `number` | `1000` | Base delay in ms between retries (exponential backoff). |

### Subprocess engines and tool support

When `engines.default` is set to `"claude-cli"` or `"codex-cli"`, ch4p wraps the CLI binary as a subprocess engine. Subprocess engines support tool execution (including `canvas_render`) via **prompt injection**: tool definitions are appended to the system prompt and the LLM is instructed to output `<tool_call>` XML blocks. The agent loop parses these blocks and executes tools in-process, then re-submits with tool results — exactly like the native engine path.

---

## channels

Per-channel configuration. Each key is a channel name.

### Common channel fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Whether this channel is active. |
| `token` | `string` | `null` | Authentication token for the platform. |
| `allowedUsers` | `string[]` | `[]` | Platform user IDs allowed to interact. Empty = all. |

### channels.telegram

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `string` | `"polling"` | `"polling"` or `"webhook"`. |
| `webhookUrl` | `string` | `null` | Public HTTPS URL for Telegram to POST updates to (webhook mode only). |
| `webhookSecret` | `string` | `null` | Secret token for webhook signature verification. |
| `pollInterval` | `number` | `1000` | Polling interval in ms (polling mode only). |
| `allowedUsers` | `string[]` | `[]` | Numeric Telegram user IDs allowed to interact. Empty = all. |
| `streamMode` | `string` | `"off"` | `"off"`, `"edit"` (progressive edits), or `"block"` (wait then send). |
| `parseMode` | `string` | `"Markdown"` | Message format: `"Markdown"`, `"HTML"`, `"MarkdownV2"`. |

Telegram forum topics (supergroups with topics enabled) are automatically supported. Messages in a topic are routed to a shared session for that topic. Replies are sent into the correct thread via `message_thread_id`.

### channels.discord

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `guildId` | `string` | `null` | Restrict to a specific server. |
| `channelIds` | `string[]` | `[]` | Restrict to specific channels. Empty = all. |
| `respondToMentions` | `boolean` | `true` | Only respond when mentioned. |

### channels.slack

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `appToken` | `string` | `null` | Slack app-level token (for Socket Mode). |
| `botToken` | `string` | `null` | Slack bot token. |
| `socketMode` | `boolean` | `true` | Use Socket Mode instead of webhooks. |

### channels.matrix

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `homeserver` | `string` | **required** | Matrix homeserver URL. |
| `userId` | `string` | **required** | Bot's Matrix user ID. |
| `accessToken` | `string` | **required** | Access token for authentication. |
| `roomIds` | `string[]` | `[]` | Rooms to join. Empty = accept all invites. |

### channels.teams

Microsoft Teams via Bot Framework REST API v3.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `appId` | `string` | **required** | Bot Framework App ID. |
| `appPassword` | `string` | **required** | Bot Framework App Password / Client Secret. |
| `tenantId` | `string` | `null` | Azure AD tenant ID (for single-tenant bots). |
| `allowedTeams` | `string[]` | `[]` | Allowed team IDs. Empty = all. |
| `allowedUsers` | `string[]` | `[]` | Allowed user AAD IDs. Empty = all. |

### channels.zalo

Zalo Official Account via OA Open API v3.0.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `oaId` | `string` | **required** | Official Account ID. |
| `oaSecretKey` | `string` | **required** | OA Secret Key for webhook MAC verification. |
| `accessToken` | `string` | **required** | OA Access Token (obtained via OAuth). |
| `refreshToken` | `string` | `null` | Refresh token for auto-renewal. |
| `appId` | `string` | **required** | Zalo App ID (for token refresh and MAC). |
| `appSecret` | `string` | `null` | Zalo App Secret (required for token refresh). |
| `allowedUsers` | `string[]` | `[]` | Allowed user IDs. Empty = all. |

### channels.whatsapp

WhatsApp Cloud API via Meta Graph API. Webhook-driven (no polling).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `accessToken` | `string` | **required** | Cloud API permanent access token. |
| `phoneNumberId` | `string` | **required** | WhatsApp Business phone number ID. |
| `verifyToken` | `string` | **required** | Webhook verification token (you define this). |
| `appSecret` | `string` | `null` | Facebook app secret for HMAC-SHA256 payload verification. |
| `apiVersion` | `string` | `"v21.0"` | Graph API version. |
| `allowedNumbers` | `string[]` | `[]` | Phone number whitelist. Empty = all. |

### channels.signal

Signal messenger via signal-cli REST API.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | `string` | `"localhost"` | signal-cli REST API host. |
| `port` | `number` | `7583` | signal-cli REST API port. |
| `account` | `string` | **required** | Signal account phone number (e.g., `"+15551234567"`). |
| `allowedNumbers` | `string[]` | `[]` | Phone number whitelist. Empty = all. |
| `reconnectInterval` | `number` | `5000` | WebSocket reconnect interval in ms. |

### channels.imessage

iMessage via macOS Messages database. Requires macOS with Full Disk Access for the running process.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pollInterval` | `number` | `2000` | Database polling interval in ms. |
| `allowedHandles` | `string[]` | `[]` | Phone/email whitelist. Empty = all. |
| `dbPath` | `string` | `~/Library/Messages/chat.db` | Path to Messages SQLite database. |

### channels.irc

IRC via raw TCP/TLS sockets. Zero external dependencies.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `server` | `string` | **required** | IRC server hostname. |
| `port` | `number` | `6697` | Server port. |
| `ssl` | `boolean` | `true` | Use TLS. |
| `nick` | `string` | `"ch4p"` | Bot nickname. |
| `channels` | `string[]` | `[]` | IRC channels to join (e.g., `["#general"]`). |
| `password` | `string` | `null` | Server password. |
| `allowedUsers` | `string[]` | `[]` | Nick whitelist. Empty = all. |
| `reconnectDelay` | `number` | `5000` | Reconnect delay in ms. |

### channels.bluebubbles

iMessage via BlueBubbles server. Requires macOS with BlueBubbles installed.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | `string` | **required** | BlueBubbles server URL (e.g., `"http://localhost:1234"`). |
| `password` | `string` | **required** | BlueBubbles server password. |
| `allowedAddresses` | `string[]` | `[]` | Phone/email whitelist. Empty = all. |

### channels.googlechat

Google Workspace Chat via service account JWT auth and REST API. Supports message editing.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serviceAccountKey` | `string` | **required** | Service account key JSON (or `"${ENV_VAR}"`). |
| `allowedSpaces` | `string[]` | `[]` | Space ID whitelist (e.g., `["spaces/AAAA"]`). Empty = all. |
| `allowedUsers` | `string[]` | `[]` | User email whitelist. Empty = all. |
| `verificationToken` | `string` | `null` | Google Chat webhook verification token. |

### channels.webchat

WebSocket-based browser chat widget. Lightweight alternative to Canvas.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `requireAuth` | `boolean` | `false` | Require authentication for WebSocket connections. |

WebChat uses the gateway's existing pairing system for authentication when enabled. Clients connect via `ws://host:port/webchat`.

### channels.zalo-personal

Zalo Personal Account via lightweight REST bridge. **Warning:** Uses an unofficial API — may violate Zalo's TOS.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `bridgeUrl` | `string` | **required** | URL of the user's Zalo bridge server. |
| `bridgeToken` | `string` | `null` | Bearer token for authenticating with the bridge. |
| `allowedUsers` | `string[]` | `[]` | User ID whitelist. Empty = all. |

The user must run their own Zalo automation bridge (e.g., via zca-js). ch4p communicates with the bridge via REST. A TOS warning is logged on startup.

### channels.macos

macOS Native channel via Notification Center and AppleScript dialogs. macOS only.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `string` | `"dialog"` | Input mode: `"dialog"` (polling AppleScript dialog) or `"notification"` (click-to-reply). |
| `dialogDelay` | `number` | `1000` | Delay in ms before showing next input dialog. |
| `title` | `string` | `"ch4p"` | Notification title. |
| `sound` | `string` | `"Submarine"` | Notification sound name. |

---

## verification

Hybrid task-level verification (AWM-inspired). Both format and semantic checks are active by default.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable task-level verification. |
| `semantic` | `boolean` | `true` | Enable LLM-based semantic verification on top of format checks. |
| `maxToolErrorRatio` | `number` | `0.5` | Maximum allowed ratio of failed tool calls before flagging. |

---

## voice.wake

Always-on voice wake configuration. Opt-in only — disabled by default.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable always-on microphone listening. |
| `wakeWord` | `string` | `null` | Optional wake word (e.g., `"hey ch4p"`). Omit for push-to-talk style. |
| `energyThreshold` | `number` | `500` | VAD energy threshold — lower values = more sensitive. |
| `silenceDurationMs` | `number` | `800` | Silence duration in ms before end-of-speech detection. |

Requires SoX (`rec` command) for microphone capture. On macOS: `brew install sox`. On Linux: `apt install sox`.

### CLI usage

Start the agent REPL with voice wake enabled:

```
ch4p agent --voice
```

The `--voice` flag activates voice wake when `voice.wake.enabled` is `true` in config. Transcribed speech is fed into the agent loop, and responses are spoken back via TTS if configured. The voice indicator appears in the session banner when active.

---

## mesh

Mesh orchestration (swarm-style multi-agent delegation). Opt-in — disabled by default.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable mesh orchestration tool. |
| `maxConcurrency` | `number` | `3` | Maximum parallel sub-agents (1-10). |
| `defaultTimeout` | `number` | `120000` | Per-task timeout in ms. |

When enabled, the `mesh` tool allows the agent to spawn multiple sub-agents in parallel across different engines/models, collecting results as a structured aggregate.

---

## search

Web search configuration (Brave Search API).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable web search tool. |
| `provider` | `string` | `"brave"` | Search provider. |
| `apiKey` | `string` | `null` | API key (or `"${BRAVE_SEARCH_API_KEY}"` for env var). |
| `maxResults` | `number` | `5` | Default result count per query. |
| `country` | `string` | `null` | Country code for results (e.g., `"US"`, `"DE"`). |
| `searchLang` | `string` | `null` | Search language code. |

---

## tunnel

Tunnel configuration for public URL exposure. The gateway starts the tunnel automatically on startup and exposes the public URL in `GET /health`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `string` | `"none"` | Tunnel provider: `"cloudflare"`, `"tailscale"`, `"ngrok"`, or `"none"`. |
| `authToken` | `string` | `null` | Auth token for ngrok (or `"${NGROK_AUTH_TOKEN}"` for env var). |
| `subdomain` | `string` | `null` | Custom subdomain (ngrok paid tier only). |
| `tunnelName` | `string` | `null` | Named tunnel for Cloudflare (omit for Quick Tunnel). |
| `binaryPath` | `string` | auto-detect | Path to tunnel binary (`cloudflared`, `tailscale`, `ngrok`). |
| `protocol` | `string` | `"http"` | Cloudflare tunnel protocol: `"http"` or `"https"`. |
| `https` | `boolean` | `true` | Tailscale: use HTTPS. |
| `region` | `string` | `null` | ngrok: tunnel region (auto by default). |

If the tunnel fails to start, the gateway continues running locally without public exposure.

---

## scheduler

Built-in cron scheduler for recurring agent tasks.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable the cron scheduler. |
| `jobs` | `CronJob[]` | `[]` | Array of scheduled jobs. |

### CronJob

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | **required** | Job identifier. |
| `schedule` | `string` | **required** | Cron expression (5-field: minute hour dom month dow). |
| `message` | `string` | **required** | Message text sent to the agent on trigger. |

---

## webhooks

Inbound webhook triggers for the gateway.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable webhook routes. |

Webhook endpoint: `POST /webhooks/:name` with body `{ "message": "...", "userId": "..." }`. Requires pairing token authentication.

---

## memory

Persistent memory configuration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backend` | `string` | `"sqlite"` | Backend type: `"sqlite"`, `"markdown"`, `"noop"`. |
| `path` | `string` | `~/.local/share/ch4p/memory.db` | SQLite database or markdown directory path. |
| `autoSave` | `boolean` | `true` | Automatically recall memories before and summarize after each conversation. |
| `vectorWeight` | `number` | `0.7` | Weight for vector (semantic) similarity in hybrid search (0–1). |
| `keywordWeight` | `number` | `0.3` | Weight for FTS5 keyword (BM25) results in hybrid search (0–1). |
| `embeddingProvider` | `string` | `undefined` | Embedding provider for semantic search: `"openai"` or `"noop"`. When omitted, only keyword search is used. |
| `embeddingModel` | `string` | `"text-embedding-3-small"` | OpenAI embedding model (when `embeddingProvider` is `"openai"`). |
| `embeddingDimensions` | `number` | `1536` | Embedding vector dimensions. Must match the model. |
| `openaiApiKey` | `string` | `$OPENAI_API_KEY` | OpenAI API key for embeddings. Defaults to the `OPENAI_API_KEY` environment variable. |
| `openaiBaseUrl` | `string` | `undefined` | Override the OpenAI API base URL (useful for compatible providers). |
| `maxCacheEntries` | `number` | `10000` | Maximum number of embedding vectors to cache in memory. |

### Hybrid Memory (Vector + Keyword)

ch4p uses **hybrid search** — combining FTS5 BM25 keyword ranking with OpenAI vector embeddings for semantic similarity. Results are merged using configurable weights.

To enable full hybrid search with semantic recall, add to your config:

```json
"memory": {
  "backend": "sqlite",
  "embeddingProvider": "openai",
  "vectorWeight": 0.7,
  "keywordWeight": 0.3
}
```

Ensure `OPENAI_API_KEY` is set in your environment. Without `embeddingProvider`, ch4p falls back to keyword-only search (still effective for exact and BM25 recall).

### Per-User Memory Isolation (Gateway)

In multi-user gateway deployments (Discord, Telegram, etc.), memories are automatically **scoped per user per channel** using the key namespace `u:{channelId}:{userId}`. This prevents memory bleed between users and across channels — Telegram user 123 and Discord user 123 maintain completely separate memory stores.

---

## security

Security subsystem configuration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `filesystem.enabled` | `boolean` | `true` | Enable filesystem scoping. |
| `filesystem.allowedPaths` | `string[]` | `["~"]` | Directories the agent can access. |
| `filesystem.blockedPaths` | `string[]` | see below | Explicitly denied paths. |
| `filesystem.followSymlinks` | `boolean` | `false` | Follow symlinks outside allowed paths. |
| `commands.enabled` | `boolean` | `true` | Enable command execution controls. |
| `commands.mode` | `string` | `"allowlist"` | `"allowlist"`, `"blocklist"`, or `"disabled"`. |
| `commands.allowed` | `string[]` | `[]` | Allowed commands (allowlist mode). |
| `commands.blocked` | `string[]` | `[]` | Blocked commands (blocklist mode). |
| `commands.maxExecutionTime` | `number` | `30000` | Command timeout in ms. |
| `sanitization.enabled` | `boolean` | `true` | Enable output sanitization. |
| `sanitization.patterns` | `object[]` | default patterns | Regex patterns to redact. |
| `inputValidation.maxMessageLength` | `number` | `10000` | Max input message length in characters. |
| `inputValidation.stripNullBytes` | `boolean` | `true` | Remove null bytes from input. |
| `inputValidation.stripControlChars` | `boolean` | `true` | Remove control characters. |
| `inputValidation.rejectPatterns` | `string[]` | `[]` | Input strings to reject. |

**Default blockedPaths:**

```json
["~/.ssh", "~/.gnupg", "~/.ch4p/config.json", "/etc/shadow", "/etc/passwd"]
```

---

## gateway

Gateway server configuration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | `number` | `3847` | HTTP server port. |
| `host` | `string` | `"127.0.0.1"` | Bind address. |
| `webhookBaseUrl` | `string` | `null` | Public URL for webhook registration. |
| `maxConcurrentMessages` | `number` | `10` | Max messages processed in parallel. |
| `messageTimeout` | `number` | `30000` | Per-message processing timeout in ms. |
| `healthCheck.enabled` | `boolean` | `true` | Enable health endpoint. |
| `healthCheck.path` | `string` | `"/health"` | Health check URL path. |
| `healthCheck.interval` | `number` | `60000` | Health check interval in ms. |

---

## skills

Agent skill system configuration. Skills are curated instruction sets (SKILL.md files) loaded on-demand.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable the skills system. |
| `paths` | `string[]` | `["~/.ch4p/skills", ".ch4p/skills", ".agents/skills"]` | Directories to search for skills. Later paths override earlier. |
| `autoLoad` | `boolean` | `true` | Auto-inject skill descriptions into the agent system prompt. |
| `contextBudget` | `number` | `16000` | Maximum characters for skill context injection. |

### SKILL.md Format

```markdown
---
name: my-skill
description: What this skill does.
license: MIT
compatibility: ["claude", "copilot"]
metadata:
  author: someone
  version: "1.0.0"
---

# Skill Instructions

Markdown body with detailed instructions...
```

**Name rules**: lowercase alphanumeric with hyphens, 1-64 chars (`^[a-z0-9]+(-[a-z0-9]+)*$`).

**Discovery**: Skills are stored as `{search-path}/{skill-name}/SKILL.md`. Directory name must match the `name` field in the manifest.

---

## x402

x402 HTTP micropayment plugin (`@ch4p/plugin-x402`). Disabled by default.

```json
{
  "x402": {
    "enabled": true,
    "server": {
      "payTo": "0xYourWallet",
      "amount": "1000000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "network": "base",
      "description": "Payment required to access this gateway.",
      "protectedPaths": ["/sessions", "/sessions/*", "/webhooks/*"],
      "maxTimeoutSeconds": 300,
      "routes": [
        { "path": "/sessions",   "amount": "500000",  "description": "0.50 USDC per session" },
        { "path": "/sessions/*", "amount": "250000" },
        { "path": "/webhooks/*", "amount": "2000000", "description": "2 USDC per webhook call" }
      ]
    },
    "client": {
      "privateKey": "${X402_PRIVATE_KEY}"
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable the x402 plugin. |
| `server.payTo` | `string` | — | Wallet address that receives payments. |
| `server.amount` | `string` | — | Global amount in the asset's smallest unit. E.g. `"1000000"` = 1 USDC. Used when no per-route override matches. |
| `server.asset` | `string` | USDC on Base | ERC-20 token contract address. |
| `server.network` | `string` | `"base"` | Network identifier (`"base"`, `"base-sepolia"`, `"ethereum"`). |
| `server.description` | `string` | auto | Human-readable payment description in the 402 response. Used when no per-route override matches. |
| `server.protectedPaths` | `string[]` | `["/*"]` | Paths to gate. Supports `"/*"` wildcard suffix. System paths are always exempt. |
| `server.maxTimeoutSeconds` | `number` | `300` | Payment authorization TTL in seconds. |
| `server.routes` | `X402RouteConfig[]` | `[]` | Per-route pricing overrides. Each entry supplies a `path` pattern, an `amount`, and an optional `description` that replace the global values for matched requests. Routes are checked in order; first match wins. |
| `server.routes[].path` | `string` | — | Path pattern (same syntax as `protectedPaths`). |
| `server.routes[].amount` | `string` | — | Amount override for this route. |
| `server.routes[].description` | `string` | — | Description override for this route's 402 response. |
| `client.privateKey` | `string` | — | 0x-prefixed private key for signing payment authorizations. Use env-var substitution: `"${X402_PRIVATE_KEY}"`. ⚠️ Never commit a real key. |
| `client.tokenAddress` | `string` | USDC on Base | ERC-20 token contract address for the EIP-712 domain. |
| `client.chainId` | `number` | `8453` | EIP-712 domain chain ID. Use `84532` for Base Sepolia. |
| `client.tokenName` | `string` | `"USD Coin"` | EIP-712 domain token name. |
| `client.tokenVersion` | `string` | `"2"` | EIP-712 domain token version. |

When `client.privateKey` is set, the `x402_pay` tool produces real on-chain EIP-712 signatures instead of placeholder values. The agent's wallet address is derived automatically from the private key.

When `client.privateKey` is set, the `web_fetch` tool also handles HTTP 402 responses
automatically: it signs the EIP-712 authorization, adds the `X-PAYMENT` header, and retries
the request transparently. No model intervention is required — the agent can browse
x402-gated APIs as if they were open.

When enabled, the `x402_pay` agent tool is registered automatically for gateway sessions. See the [Use x402 Payments](../how-to/use-x402.md) guide.

---

## routing

Config-driven multi-agent routing. Define named sub-agents with their own system prompts and models, then write routing rules to dispatch gateway messages to the right agent based on channel ID and/or message text patterns. Rules are evaluated in order — the first match wins.

```json
{
  "routing": {
    "agents": {
      "coding": {
        "systemPrompt": "You are an expert coding assistant. Be concise and precise.",
        "model": "claude-opus-4-5",
        "maxIterations": 50
      },
      "quick": {
        "model": "claude-haiku-3-5",
        "maxIterations": 5
      }
    },
    "rules": [
      { "channel": "telegram", "match": "code|debug|fix|build", "agent": "coding" },
      { "match": "\\bhi\\b|hello|hey", "agent": "quick" }
    ]
  }
}
```

### routing.agents

Each key is an agent name. Agent configs override the defaults for matched messages.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `systemPrompt` | `string` | global prompt | Custom system prompt for this agent. |
| `model` | `string` | `agent.model` | LLM model override. |
| `maxIterations` | `number` | `20` | Max agent loop iterations. |
| `toolExclude` | `string[]` | `[]` | Additional tool names to exclude for this agent. |

### routing.rules

An array of routing rules evaluated in order. First match wins.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | `string` | No | Channel ID to match (e.g. `"telegram"`, `"discord"`). Omit or `"*"` to match any channel. |
| `match` | `string` | No | Case-insensitive regex tested against message text. Omit to match any message on the given channel. |
| `agent` | `string` | Yes | Name of the agent in `routing.agents` to dispatch to. |

If no rule matches, the default agent configuration is used.

---

## agent.workerPool

Heavyweight tools (`web_fetch`, `browser`) run inside isolated worker threads when the
worker pool is enabled. This prevents blocking the main agent loop during long-running
HTTP requests or browser operations.

The worker pool is enabled automatically when the `@ch4p/agent` package has been built
(`corepack pnpm -r build`). No config is required — the gateway detects the compiled
worker script at startup and logs `Workers: enabled (max 4 threads)` in the banner.

### x402 limitation in worker context

`x402Signer` is a function and cannot be serialised across worker thread boundaries.
When `web_fetch` runs in the worker and encounters an HTTP 402 Payment Required response,
it returns `{ success: false, x402Required: true }`. The agent then uses the `x402_pay`
tool to construct the payment header and retries manually.

This fallback is transparent to the end user — the agent handles it automatically in the
next tool call. Auto-payment (transparent 402 handling without model intervention) only
works when `web_fetch` runs inline on the main thread, which happens when the worker
script is not yet built.

---

## logging

Logging configuration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `level` | `string` | `"info"` | Log level: `"debug"`, `"info"`, `"warn"`, `"error"`. |
| `format` | `string` | `"text"` | Output format: `"text"`, `"json"`. |
| `file` | `string` | `null` | Log file path. `null` = stdout only. |
| `maxSize` | `string` | `"10mb"` | Max log file size before rotation. |
| `maxFiles` | `number` | `5` | Number of rotated log files to keep. |
