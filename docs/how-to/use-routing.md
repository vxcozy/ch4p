# How to Use Multi-Agent Routing

Config-driven routing lets the gateway dispatch inbound messages to different named agents based on the originating channel and/or message text patterns. Each named agent can have its own system prompt, model, and tool configuration.

This is useful for:
- Using a fast/cheap model for simple messages and a powerful model for technical tasks
- Giving each channel a specialized persona (e.g. a strict coding assistant on Discord)
- Restricting tool access per-agent (e.g. read-only for public-facing channels)

---

## Configuration

Add a `routing` section to `~/.ch4p/config.json`:

```json
{
  "routing": {
    "agents": {
      "coding": {
        "systemPrompt": "You are an expert software engineer. Provide concise, correct code. Always explain your reasoning.",
        "model": "claude-opus-4-5",
        "maxIterations": 50
      },
      "quick": {
        "model": "claude-haiku-3-5",
        "maxIterations": 5
      },
      "readonly": {
        "systemPrompt": "You are a helpful assistant. You can read and analyze files but cannot modify them.",
        "toolExclude": ["bash", "file_write", "file_edit", "delegate", "mesh"]
      }
    },
    "rules": [
      { "channel": "discord", "match": "code|debug|fix|build|test|deploy", "agent": "coding" },
      { "channel": "telegram", "match": "\\bhi\\b|hello|hey|thanks", "agent": "quick" },
      { "channel": "webchat", "agent": "readonly" }
    ]
  }
}
```

---

## How Routing Works

Rules are evaluated in order. The **first matching rule wins**.

A rule matches when:
- **`channel`** matches the message's channel ID (case-insensitive, exact match). Omit or use `"*"` for any channel.
- **`match`** is a case-insensitive regex tested against the message text. Omit to match any text.

If no rule matches, the default agent configuration is used (`agent.model`, `agent.provider`, global system prompt).

### Rule evaluation order

```
For each rule (in order):
  1. If rule.channel is set and ≠ "*":
       skip if msg.channelId doesn't match
  2. If rule.match is set:
       skip if msg.text doesn't match the regex
  3. Look up rule.agent in routing.agents
       if not found, skip this rule (continue to next)
  4. Return routing decision for this agent
Fall back to default if no rule matched.
```

---

## Agent Configuration Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `systemPrompt` | `string` | global prompt | Custom system prompt for messages routed to this agent. |
| `model` | `string` | `agent.model` | LLM model. Useful for routing heavy tasks to Opus and casual messages to Haiku. |
| `maxIterations` | `number` | `20` | Max agent loop iterations. Increase for deep research tasks; decrease for quick replies. |
| `toolExclude` | `string[]` | `[]` | Tools to disable for this agent, merged with global exclusions. |

---

## Examples

### Route by channel only

All messages from a specific channel go to one agent:

```json
{
  "routing": {
    "agents": {
      "discord-agent": {
        "systemPrompt": "You are a helpful Discord bot for the Acme Engineering team.",
        "model": "claude-sonnet-4-6"
      }
    },
    "rules": [
      { "channel": "discord", "agent": "discord-agent" }
    ]
  }
}
```

### Catch-all fallback agent

Use a rule with no `channel` or `match` as a catch-all after more specific rules:

```json
{
  "routing": {
    "agents": {
      "coder": { "model": "claude-opus-4-5", "maxIterations": 50 },
      "fallback": { "model": "claude-haiku-3-5", "maxIterations": 5 }
    },
    "rules": [
      { "match": "code|debug|fix|build", "agent": "coder" },
      { "agent": "fallback" }
    ]
  }
}
```

### Read-only public channel

Restrict tool access for a public-facing channel:

```json
{
  "routing": {
    "agents": {
      "public": {
        "systemPrompt": "You are a public-facing assistant. Be friendly and helpful. Do not execute code or modify files.",
        "toolExclude": ["bash", "file_write", "file_edit", "delegate", "mesh", "browser"]
      }
    },
    "rules": [
      { "channel": "webchat", "agent": "public" }
    ]
  }
}
```

---

## Context Isolation

Each user+channel combination has its own conversation context. Routing decisions affect the **system prompt and model** for each message, but do not cross conversation boundaries — user A's history never bleeds into user B's context.

If you route user A's first message to `coding` and their second message matches no rules (fallback to default), the conversation history is preserved but the agent configuration changes for that message. For stable personas, use rules that are broad enough to consistently match a user's messages.

---

## Combine with Mesh Orchestration

Routing rules and mesh orchestration complement each other:
- **Routing rules** dispatch gateway messages to the right top-level agent
- **Mesh / delegate tools** let that agent spawn sub-agents for parallelizable work

For example, route coding questions to a powerful agent (`claude-opus-4-5`) which then uses `mesh` to spawn multiple sub-agents for different parts of a complex task.
