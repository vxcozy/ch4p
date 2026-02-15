<p align="center">
  <img src="docs/assets/ch4p-header.svg" alt="ch4p — personal AI assistant platform" width="800" />
</p>

Personal AI assistant platform. Security-first, multi-channel, programmable.

Built on four pillars:

- **Broad connectivity** — 14+ messaging channels, tunnel exposure, and a skills system. Compatible with OpenClaw channel adapters, skills, and plugins.
- **Resilient concurrency** — OTP-style supervision trees, process isolation, backpressure, and live steering for long-running agent sessions.
- **Security-first defaults** — trait-based architecture where every defense layer is on by default, hybrid memory search, and encrypted secrets at rest.
- **Agent reliability** — mandatory tool call validation, state snapshots with diff-based verification, and LLM-as-a-judge outcome assessment. Inspired by the [Agent World Model](https://arxiv.org/abs/2602.10090) research.

## Quick Start

```bash
# Clone and install
git clone <repo-url> ch4p && cd ch4p
pnpm install

# Run the onboarding wizard
pnpm --filter @ch4p/cli start -- onboard

# Start the agent
pnpm --filter @ch4p/cli start -- agent
```

Set your API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Architecture

```
Channels (CLI, Telegram, Discord, Slack, ...)
    |
Gateway (HTTP server, session routing)
    |
Agent Runtime (session, context, steering queue)
    |
Engine (native LLM, echo, CLI subprocess)
    |
Provider (Anthropic, OpenAI, Ollama)
```

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
  channels/       # Messaging: CLI, Telegram, Discord, Slack
  gateway/        # HTTP server, session routing, pairing authentication
  tools/          # Built-in tools: bash, file ops, grep, glob, web fetch, memory, delegate, MCP client
  memory/         # Hybrid search: SQLite FTS5 + vector embeddings
  security/       # Filesystem scope, command allowlist, secrets, I/O sanitization
  supervisor/     # OTP-style supervision trees, health monitoring
  observability/  # Console, file, multi-observer logging
  skills/         # Skill discovery, YAML frontmatter parsing, registry (OpenClaw compatible)
  tunnels/        # Tunnel providers: Cloudflare, Tailscale, ngrok
apps/
  cli/            # Command-line interface (standalone binary via bun compile)
```

## Skills

Skills are curated instruction sets loaded on-demand via progressive disclosure:

```bash
ch4p skills              # List installed skills
ch4p skills show <name>  # Display full skill content
ch4p skills verify       # Validate all manifests
```

Skills are SKILL.md files with YAML frontmatter, stored in `~/.ch4p/skills/`, `.ch4p/skills/`, or `.agents/skills/`. Compatible with the Agent Skills specification and the OpenClaw skill format.

## Security

Security is on by default with six defense layers:

1. **Filesystem scoping** — all file operations constrained to workspace root, symlink escape detection
2. **Command allowlist** — only approved commands execute, shell metacharacter injection blocked
3. **Encrypted secrets** — AES-256-GCM with PBKDF2 key derivation
4. **Output sanitization** — 16 regex patterns strip API keys, tokens, credentials from responses
5. **Input validation** — prompt injection, jailbreak, and data exfiltration detection
6. **Autonomy levels** — `readonly` / `supervised` / `full` control over what the agent can do without confirmation

## Agent Reliability (AWM)

Inspired by the Agent World Model research, ch4p implements several techniques for improving agent task completion:

- **Mandatory tool call validation** — every tool call is validated before execution. Malformed arguments are fed back to the LLM as error messages for self-correction, avoiding wasted tool executions.
- **State snapshots** — tools that modify external state capture observable state before and after execution. These diffs enable automated verification of tool outcomes.
- **Task-level verification** — the optional `IVerifier` interface runs a two-phase check (format + semantic) after the agent completes a task, assessing whether the result is correct.
- **Named context strategies** — configurable truncation strategies with tunable parameters: compaction targets, keep ratios, tool-call pair preservation, and task description pinning.
- **MCP tool connectivity** — the built-in MCP client tool connects to any Model Context Protocol server, discovering and proxying tools via `list_tools` + `call_tool`.

## Memory

Hybrid search combining two retrieval strategies:

- **SQLite FTS5** — BM25 keyword ranking for exact term matches
- **Vector embeddings** — cosine similarity for semantic search
- **Weighted merge** — configurable blend (default 70% vector, 30% keyword)

Three backends: `sqlite` (primary), `markdown` (portable), `noop` (disabled).

## Development

```bash
# Build all packages
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck

# Build a single package
pnpm --filter @ch4p/core build
```

### Project Structure

- TypeScript strict mode, ES2023 target, NodeNext module resolution
- ESM-only (all imports use `.js` extension)
- Zero external runtime dependencies for core, security, and CLI packages
- `tsup` for bundling, `vitest` for testing

## Configuration

Configuration lives in `~/.ch4p/config.json`. The onboarding wizard creates it, or you can write it manually:

```json
{
  "agent": {
    "name": "ch4p",
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-20250514"
  },
  "providers": {
    "anthropic": {
      "type": "anthropic",
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

Environment variables referenced as `${VAR_NAME}` are resolved at load time.

## Documentation

Full Diataxis-style documentation in `docs/`:

- **Tutorials** — getting-started, first-channel
- **How-to Guides** — add-tool, add-channel, add-provider, configure-security, deploy-gateway, use-memory
- **Reference** — interfaces, configuration, CLI, security
- **Explanation** — architecture, concurrency, security-model, memory

## License

MIT
