<p align="center">
  <img src="docs/assets/ch4p-header.svg" alt="ch4p — personal AI assistant platform" width="800" />
</p>

Personal AI assistant platform. Security-first, multi-channel, programmable.

Built on four pillars:

- **Broad connectivity** — 16 messaging channels, tunnel exposure, and a skills system. Compatible with OpenClaw channel adapters, skills, and plugins.
- **Resilient concurrency** — OTP-style supervision trees, process isolation, backpressure, and live steering for long-running agent sessions.
- **Security-first defaults** — trait-based architecture where every defense layer is on by default, hybrid memory search, and encrypted secrets at rest.
- **Agent reliability** — mandatory tool call validation, state snapshots with diff-based verification, and LLM-as-a-judge outcome assessment. Inspired by the [Agent World Model](https://arxiv.org/abs/2602.10090) research.

## Quick Start

```bash
# Clone and install (pnpm is managed via corepack)
git clone https://github.com/vxcozy/ch4p.git && cd ch4p
corepack pnpm install
corepack pnpm -r build

# Run the onboarding wizard
node apps/cli/dist/index.js onboard

# Start the agent (shows Chappie splash, then interactive REPL)
node apps/cli/dist/index.js agent

# Start the interactive canvas workspace (opens browser)
node apps/cli/dist/index.js canvas
```

Or set your API key directly:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node apps/cli/dist/index.js agent
```

A standalone binary is also available:

```bash
corepack pnpm bundle    # ~58 MB binary via bun compile
./dist/ch4p agent
```

Or run in Docker:

```bash
# Start the gateway (mounts ~/.ch4p/config.json read-only)
docker compose up -d
```

Or install as a system daemon (auto-start on login, no sudo needed):

```bash
ch4p install               # macOS (launchd) or Linux (systemd)
ch4p install --status      # check status
ch4p install --logs        # tail logs
ch4p install --uninstall   # remove
```

## Architecture

```
Channels (CLI, Telegram, Discord, Slack, Teams, Zalo, IRC, WebChat, ...)   Canvas (tldraw, WebSocket, A2UI)
    |                                                              |
Gateway (HTTP server, session routing, cron, webhooks)   Gateway (WS upgrade, static files)
    |                                                              |
Agent Runtime (session, context, steering queue, canvas_render tool)
    |
Engine (native LLM, echo, CLI subprocess)
    |
Provider (Anthropic, OpenAI, Google/Gemini, OpenRouter, Ollama, Bedrock)
```

Three modes of interaction:
- **`ch4p agent`** — interactive chat REPL with teal-branded UI, Chappie mascot banner, bordered tool-call rendering, and optional `--voice` wake mode
- **`ch4p gateway`** — multi-channel server with voice (Telegram, Discord, Slack, etc.)
- **`ch4p canvas`** — interactive browser workspace with an infinite spatial canvas

Every subsystem is defined by a trait interface — swap any component via config, zero code changes.

### 10 Trait Interfaces

| Interface | Purpose |
|---|---|
| `IProvider` | LLM API abstraction (stream, complete, list models) |
| `IChannel` | Messaging surface (start, stop, send, onMessage) |
| `IMemoryBackend` | Persistent memory (store, recall, forget) |
| `ITool` | Agent tool (execute, validate, abort, state snapshots) |
| `IEngine` | Execution engine (startRun, resume) |
| `ISecurityPolicy` | Security enforcement (path/command validation, audit) |
| `IObserver` | Observability (session, tool, LLM, security events) |
| `ITunnelProvider` | Public URL exposure (start, stop, getPublicUrl) |
| `IVerifier` | Task-level outcome verification (format + semantic checks) |
| `IIdentityProvider` | On-chain agent identity and reputation (plugin-ready) |

## Packages

```
packages/
  core/           # Trait interfaces, types, errors, utilities
  agent/          # Agent runtime: session, context, steering, worker pool
  providers/      # LLM providers: Anthropic, OpenAI, Google, OpenRouter, Ollama, Bedrock
  engines/        # Execution engines: native (LLM), echo (testing), subprocess (CLI wrappers)
  channels/       # Messaging: CLI, Telegram, Discord, Slack, Matrix, WhatsApp, Signal, iMessage, Teams, Zalo, IRC, BlueBubbles, Google Chat, WebChat, Zalo Personal, macOS Native
  canvas/         # A2UI components, canvas state, WS protocol, CanvasTool, CanvasChannel
  gateway/        # HTTP server, session routing, WebSocket bridge, pairing, stream handler, cron scheduler, webhooks
  tools/          # Built-in tools: bash, file ops, grep, glob, web fetch, web search, browser, memory, delegate, mesh, MCP client
  memory/         # Hybrid search: SQLite FTS5 + vector embeddings
  security/       # Filesystem scope, command allowlist, secrets, I/O sanitization
  supervisor/     # OTP-style supervision trees, health monitoring
  observability/  # Console, file, multi-observer logging
  skills/         # Skill discovery, YAML frontmatter parsing, registry (OpenClaw compatible)
  voice/          # Voice pipeline: STT (Whisper, Deepgram), TTS (ElevenLabs), always-on voice wake
  tunnels/        # Tunnel providers: Cloudflare, Tailscale, ngrok
  plugin-x402/    # x402 HTTP micropayment plugin: gateway middleware + x402_pay agent tool
apps/
  cli/            # Command-line interface (standalone binary via bun compile)
  web/            # Canvas workspace: React + tldraw SPA with 11 custom A2UI shape types
```

## Skills

Skills are curated instruction sets loaded on-demand via progressive disclosure:

```bash
ch4p skills              # List installed skills
ch4p skills show <name>  # Display full skill content
ch4p skills verify       # Validate all manifests
```

Skills are SKILL.md files with YAML frontmatter, stored in `~/.ch4p/skills/`, `.ch4p/skills/`, or `.agents/skills/`. Compatible with the Agent Skills specification and the OpenClaw skill format.

## Canvas

The interactive canvas workspace (`ch4p canvas`) gives the agent a spatial, visual interface powered by [tldraw](https://tldraw.dev). The agent renders rich UI components on an infinite canvas via the `canvas_render` tool, and user interactions flow back in real-time over WebSocket.

**11 A2UI component types:** card, chart, form, button, text field, data table, code block, markdown, image, progress, status. Components can be connected with directional edges to show relationships.

```bash
ch4p canvas                # start canvas + open browser
ch4p canvas --port 4800    # custom port
ch4p canvas --no-open      # don't auto-open browser
```

The canvas is fully bidirectional — click a button on a card, submit a form, or drag components to rearrange the workspace. Every interaction reaches the agent as a structured event.

## Security

Security is on by default with nine defense layers:

1. **Filesystem scoping** — all file operations constrained to workspace root, symlink escape detection
2. **Command allowlist** — only approved commands execute, shell metacharacter injection blocked
3. **Encrypted secrets** — AES-256-GCM with PBKDF2 key derivation
4. **Output sanitization** — 25 regex patterns strip API keys, tokens, credentials from responses
5. **Input validation** — prompt injection, jailbreak, and data exfiltration detection
6. **Autonomy levels** — `readonly` / `supervised` / `full` control over what the agent can do without confirmation
7. **SSRF protection** — private IP blocking, DNS resolution checks, and cloud metadata endpoint guards in web fetch
8. **Secure file permissions** — JSONL transcripts written with `0o600`, log directories `0o700`
9. **Pairing token expiration** — all authentication tokens expire (default 30 days), with automatic eviction

## Agent Reliability (AWM)

Inspired by the Agent World Model research, ch4p implements several techniques for improving agent task completion:

- **Mandatory tool call validation** — every tool call is validated before execution. Malformed arguments are fed back to the LLM as error messages for self-correction, avoiding wasted tool executions.
- **State snapshots** — tools that modify external state capture observable state before and after execution. These diffs enable automated verification of tool outcomes.
- **Hybrid verification (default on)** — the `IVerifier` interface runs a two-phase check after each task: `FormatVerifier` (structural/rule-based) followed by `LLMVerifier` (semantic assessment using the AI engine). Both layers are active by default.
- **Auto-memory hooks** — `autoRecallHook` retrieves relevant memories before the agent processes each message; `autoSummarizeHook` stores key learnings after each run completes. Active by default when memory is enabled.
- **Named context strategies** — configurable truncation strategies with tunable parameters: compaction targets, keep ratios, tool-call pair preservation, and task description pinning.
- **MCP tool connectivity** — the built-in MCP client tool connects to any Model Context Protocol server, discovering and proxying tools via `list_tools` + `call_tool`.
- **Browser control** — Playwright-based browser tool for page navigation, clicking, typing, screenshots, and JS evaluation with SSRF protection.
- **Mesh orchestration** — swarm-style multi-agent delegation: spawn parallel sub-agents across engines, bounded concurrency, partial failure tolerance. Sub-agents accept optional parent context injection via the `context` field.
- **Config-driven routing** — define named agents (own system prompt, model, tool exclusions) and routing rules that dispatch gateway messages to the right agent based on channel ID and/or message text regex patterns.
- **Voice wake** — opt-in always-on microphone listening with energy-based VAD, wake word filtering, and STT transcription into the agent loop.

## Memory

Hybrid search combining two retrieval strategies:

- **SQLite FTS5** — BM25 keyword ranking for exact term matches
- **Vector embeddings** — cosine similarity for semantic search
- **Weighted merge** — configurable blend (default 70% vector, 30% keyword)

Three backends: `sqlite` (primary), `markdown` (portable), `noop` (disabled).

## Cron & Webhooks

The gateway includes a built-in scheduler and webhook receiver for automated workflows:

- **Cron jobs** — schedule recurring agent tasks using standard 5-field cron expressions (minute, hour, dom, month, dow). Zero external dependencies.
- **Webhooks** — `POST /webhooks/:name` accepts inbound triggers with `{ message, userId? }` payloads, routed through the agent pipeline.

Both features create synthetic inbound messages and process them through the same agent loop as channel messages.

## Development

```bash
# Build all 18 packages
corepack pnpm -r build

# Run all tests
corepack pnpm test

# Build a single package
corepack pnpm --filter @ch4p/core build
```

### Project Structure

- 19 packages in a pnpm monorepo (use `corepack pnpm` — pnpm is not on PATH)
- TypeScript strict mode, ES2023 target, NodeNext module resolution
- ESM-only (all imports use `.js` extension)
- Zero required external runtime dependencies for core, security, and CLI packages (`playwright-core` is optional for browser tool)
- `tsup` for bundling, `vitest` for testing, `vite` for web frontend (code-split with lazy loading)
- 83 test files, 2384 tests

## Configuration

Configuration lives in `~/.ch4p/config.json`. The onboarding wizard (`ch4p onboard`) creates it with ~20 configurable categories covering engines, providers, channels, services, and system settings. Each category defaults to skip — pressing Enter through everything produces the same default config. You can also write it manually:

```json
{
  "agent": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6"
  },
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}"
    }
  },
  "autonomy": {
    "level": "supervised"
  },
  "memory": {
    "backend": "sqlite"
  }
}
```

Environment variables referenced as `${VAR_NAME}` are resolved at load time. ch4p automatically loads `~/.ch4p/.env` at startup — no manual sourcing required. Shell environment variables take precedence over `.env` values.

### Alternative LLM Setups

ch4p works with any LLM, not just direct API keys. Three paths for using existing subscriptions or local models:

- **Ollama** — run open-source models locally with zero API keys. Free, private, offline-capable.
- **LiteLLM proxy** — unified OpenAI-compatible endpoint for 100+ providers with fallbacks and load balancing.
- **CLI passthrough** — route through Claude Code, Codex CLI, or any LLM CLI via the SubprocessEngine.

See [Alternative LLM Setups](docs/how-to/alternative-llm-setups.md) for configuration details.

## Documentation

Full Diataxis-style documentation in [`docs/`](docs/index.md):

- **[Tutorials](docs/tutorials/)** — [getting-started](docs/tutorials/getting-started.md), [first-channel](docs/tutorials/first-channel.md)
- **[How-to Guides](docs/how-to/)** — [add-tool](docs/how-to/add-tool.md), [add-channel](docs/how-to/add-channel.md), [add-provider](docs/how-to/add-provider.md), [add-verifier](docs/how-to/add-verifier.md), [configure-security](docs/how-to/configure-security.md), [deploy-gateway](docs/how-to/deploy-gateway.md), [use-memory](docs/how-to/use-memory.md), [use-canvas](docs/how-to/use-canvas.md), [use-web-search](docs/how-to/use-web-search.md), [use-browser](docs/how-to/use-browser.md), [use-skills](docs/how-to/use-skills.md), [use-mcp](docs/how-to/use-mcp.md), [use-cron-webhooks](docs/how-to/use-cron-webhooks.md), [setup-voice](docs/how-to/setup-voice.md), [use-observability](docs/how-to/use-observability.md), [alternative-llm-setups](docs/how-to/alternative-llm-setups.md), [use-mesh](docs/how-to/use-mesh.md)
- **[Reference](docs/reference/)** — [interfaces](docs/reference/interfaces.md), [configuration](docs/reference/configuration.md), [CLI](docs/reference/cli.md), [security](docs/reference/security.md)
- **[Explanation](docs/explanation/)** — [architecture](docs/explanation/architecture.md), [concurrency](docs/explanation/concurrency.md), [security-model](docs/explanation/security-model.md), [memory](docs/explanation/memory.md)

## License

MIT
