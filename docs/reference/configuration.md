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
| `model` | `string` | provider default | Model identifier (e.g., `"claude-sonnet-4-20250514"`, `"gpt-4o"`). |
| `maxTokens` | `number` | `4096` | Maximum tokens in completion response. |
| `temperature` | `number` | `0.7` | Sampling temperature (0.0 - 2.0). |
| `topP` | `number` | `1.0` | Nucleus sampling parameter. |
| `timeout` | `number` | `30000` | API request timeout in ms. |
| `retries` | `number` | `3` | Number of retry attempts on transient failures. |
| `retryDelay` | `number` | `1000` | Base delay in ms between retries (exponential backoff). |

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
| `pollInterval` | `number` | `1000` | Polling interval in ms (polling mode only). |
| `parseMode` | `string` | `"Markdown"` | Message format: `"Markdown"`, `"HTML"`, `"MarkdownV2"`. |

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
| `wakeWord` | `string` | `null` | Optional wake word (e.g., `"hey chappie"`). Omit for push-to-talk style. |
| `energyThreshold` | `number` | `500` | VAD energy threshold — lower values = more sensitive. |
| `silenceDurationMs` | `number` | `800` | Silence duration in ms before end-of-speech detection. |

Requires SoX (`rec` command) for microphone capture. On macOS: `brew install sox`. On Linux: `apt install sox`.

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
| `enabled` | `boolean` | `true` | Enable persistent memory. |
| `path` | `string` | `"~/.ch4p/memory.db"` | SQLite database path. |
| `search.ftsWeight` | `number` | `0.4` | Weight for FTS5/BM25 results (0-1). |
| `search.vectorWeight` | `number` | `0.6` | Weight for vector similarity results (0-1). |
| `search.minScore` | `number` | `0.2` | Minimum combined score threshold. |
| `search.maxResults` | `number` | `20` | Maximum results per query. |
| `embedding.provider` | `string` | `"local"` | Embedding provider: `"local"`, `"openai"`. |
| `embedding.model` | `string` | `"all-MiniLM-L6-v2"` | Embedding model name. |
| `embedding.dimensions` | `number` | `384` | Embedding vector dimensions. |

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

## logging

Logging configuration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `level` | `string` | `"info"` | Log level: `"debug"`, `"info"`, `"warn"`, `"error"`. |
| `format` | `string` | `"text"` | Output format: `"text"`, `"json"`. |
| `file` | `string` | `null` | Log file path. `null` = stdout only. |
| `maxSize` | `string` | `"10mb"` | Max log file size before rotation. |
| `maxFiles` | `number` | `5` | Number of rotated log files to keep. |
