# Reference: Configuration

ch4p is configured via `~/.ch4p/config.json`. This document lists every field, its type, default value, and valid options.

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

### channels.irc

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `server` | `string` | **required** | IRC server hostname. |
| `port` | `number` | `6697` | Server port. |
| `ssl` | `boolean` | `true` | Use TLS. |
| `nick` | `string` | agent name | Bot nickname. |
| `channels` | `string[]` | `[]` | Channels to join. |

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
