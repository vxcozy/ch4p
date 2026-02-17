# ch4p Documentation

ch4p is a personal AI assistant platform. A play on "chap" — slang for friend — ch4p gives you a programmable, security-first AI agent that speaks across 16 messaging channels.

Built in TypeScript on Node.js, ch4p combines BEAM-inspired concurrency, a zero-dependency hybrid memory system, multi-engine LLM architecture, and 10 trait interfaces that make every component replaceable.

---

## Where to Start

**New to ch4p?** Begin with the [Getting Started tutorial](tutorials/getting-started.md). You will install ch4p, run the onboard wizard, send your first message, and watch a tool execute — all in about ten minutes.

**Want a visual workspace?** Run `ch4p canvas` to launch the interactive canvas — a browser-based spatial workspace where the agent renders cards, charts, forms, and more on an infinite tldraw canvas. See the [Use Canvas](how-to/use-canvas.md) guide.

**Want to connect a channel?** The [First Channel tutorial](tutorials/first-channel.md) walks you through wiring up Telegram.

**Already comfortable?** Jump to whichever section matches your need.

---

## Documentation Structure

This documentation follows the [Diataxis](https://diataxis.fr/) framework. Each section serves a distinct purpose.

### Tutorials — Learning-Oriented

Step-by-step lessons that teach by doing. Start here if you are new.

- [Getting Started](tutorials/getting-started.md) — Install, configure, send your first message
- [First Channel](tutorials/first-channel.md) — Connect Telegram and receive messages externally

### How-to Guides — Goal-Oriented

Practical recipes for specific tasks. Assumes you already understand the basics.

- [Add a Provider](how-to/add-provider.md) — Implement IProvider for a new LLM
- [Add a Channel](how-to/add-channel.md) — Implement IChannel for a new messaging surface
- [Add a Tool](how-to/add-tool.md) — Create a custom tool with ITool
- [Add a Verifier](how-to/add-verifier.md) — Implement IVerifier for custom task-level verification
- [Configure Security](how-to/configure-security.md) — Filesystem scoping, command allowlists, autonomy levels
- [Deploy the Gateway](how-to/deploy-gateway.md) — Run the gateway with a tunnel for external access
- [Use Memory](how-to/use-memory.md) — Store, recall, and forget with hybrid search
- [Use Canvas](how-to/use-canvas.md) — Launch the interactive canvas workspace and render A2UI components
- [Use Web Search](how-to/use-web-search.md) — Configure Brave Search API for web search
- [Use Browser](how-to/use-browser.md) — Set up Playwright-based browser automation
- [Use Skills](how-to/use-skills.md) — Create and manage agent skills
- [Use MCP](how-to/use-mcp.md) — Connect to Model Context Protocol servers
- [Use Cron & Webhooks](how-to/use-cron-webhooks.md) — Schedule recurring tasks and webhook triggers
- [Set Up Voice](how-to/setup-voice.md) — Configure STT (Whisper, Deepgram) and TTS (ElevenLabs)
- [Use Observability](how-to/use-observability.md) — Logging, monitoring, and debugging
- [Alternative LLM Setups](how-to/alternative-llm-setups.md) — Ollama, LiteLLM proxy, CLI passthrough
- [Use Mesh Orchestration](how-to/use-mesh.md) — Swarm-style multi-agent delegation across engines

### Reference — Information-Oriented

Precise, complete descriptions of ch4p's machinery. Look things up here.

- [Interfaces](reference/interfaces.md) — All 10 trait interfaces: methods, types, fields
- [Configuration](reference/configuration.md) — Every config.json field, type, and default
- [CLI Commands](reference/cli.md) — Every command, flag, and output format
- [Security Subsystem](reference/security.md) — Blocked paths, guards, sanitization, audit items

### Explanation — Understanding-Oriented

The reasoning behind ch4p's design. Read when you want to understand "why."

- [Architecture](explanation/architecture.md) — Gateway + Agent + Engine and why TypeScript
- [Concurrency](explanation/concurrency.md) — BEAM-inspired supervision, workers, backpressure
- [Security Model](explanation/security-model.md) — Layered defense and why everything is on by default
- [Memory](explanation/memory.md) — Hybrid search in SQLite and the trade-offs involved

---

## Quick Facts

| Aspect | Detail |
|---|---|
| Language | TypeScript (Node.js) |
| Channels | 16 (Telegram, Discord, Slack, Matrix, IRC, Google Chat, BlueBubbles, WebChat, and more) + interactive canvas |
| LLM Providers | 6 built-in (Anthropic, OpenAI, Google/Gemini, OpenRouter, Ollama, Bedrock) |
| Memory | SQLite with FTS5 + vector hybrid search |
| Concurrency | BEAM-inspired supervision trees with worker threads |
| Security | On by default. Filesystem scoping, command allowlists, audit |
| Interfaces | 10 trait interfaces for full component replacement |
| Verification | AWM-inspired step-level validation and task-level outcome verification |
| MCP | Universal tool connectivity via Model Context Protocol |
| Dependencies (memory) | Zero external services required |
