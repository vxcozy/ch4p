# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.2] - 2026-02-25

### Fixed

- **Eviction timer crash** — `router` was not in scope inside the eviction `setInterval`; corrected to `messageRouter`

## [0.1.1] - 2026-02-25

### Fixed

- **Gateway memory leak** — conversation contexts, sessions, and routes now evict after 1 hour of inactivity, preventing V8 heap OOM crashes during long-running gateway operation
- **Canvas session leak** — CanvasSessionManager tracks `lastActiveAt` and evicts idle sessions
- **Teams serviceUrls unbounded growth** — capped at 10,000 entries with FIFO eviction

## [0.1.0] - 2026-02-24

Initial public release.

### Added

- **Agent runtime** — session management, context window, steering, and worker pool with OTP-style supervision
- **16 messaging channels** — CLI, Telegram, Discord, Slack, Matrix, WhatsApp, Signal, iMessage, BlueBubbles, Teams, Google Chat, Zalo OA, Zalo Personal, IRC, WebChat, macOS Native
- **6 LLM providers** — Anthropic, OpenAI, Google, OpenRouter, Ollama, Bedrock
- **3 execution engines** — native LLM, echo (testing), CLI subprocess
- **Agent tools** — bash, file read/write, grep, glob, web fetch/search, browser (Playwright), memory, delegate, mesh, MCP client
- **Hybrid memory** — SQLite FTS5 full-text search + cosine vector similarity with configurable blend
- **Canvas workspace** — spatial tldraw interface with 11 A2UI component types and bidirectional interaction
- **Gateway server** — HTTP server on port 18789, session routing, WebSocket bridge, cron scheduler, webhook triggers
- **9 security layers** — filesystem scope, command allowlist, encrypted secrets, output sanitization, input validation, autonomy levels, SSRF protection, secure permissions, pairing token expiration
- **Hybrid verification** — FormatVerifier + LLMVerifier two-phase check with state snapshots
- **Skills system** — curated instruction sets with YAML frontmatter and OpenClaw-compatible registry
- **Mesh orchestration** — swarm-style parallel sub-agents with bounded concurrency and partial failure tolerance
- **Config-driven routing** — named agents with per-agent system prompt, model, tools, and channel dispatch rules
- **Voice integration** — STT (Whisper, Deepgram), TTS (ElevenLabs), always-on voice wake with VAD
- **Tunnel providers** — Cloudflare, Tailscale, ngrok
- **x402 micropayments** — server 402 enforcement + client auto-pay on Base/USDC
- **Daemon installer** — `ch4p install` for zero-sudo systemd (Linux) or launchd (macOS) with auto-restart
- **Standalone binary** — `pnpm bundle` via bun compile

[0.1.2]: https://github.com/ch4p-labs/ch4p/releases/tag/v0.1.2
[0.1.1]: https://github.com/ch4p-labs/ch4p/releases/tag/v0.1.1
[0.1.0]: https://github.com/ch4p-labs/ch4p/releases/tag/v0.1.0
