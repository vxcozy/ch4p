# ch4p — Task Tracking

## Completed: Phase 1 — Foundation ✅

### Plan
- [x] Set up monorepo with pnpm workspaces
- [x] Define all 10 trait interfaces in @ch4p/core (9 original + IIdentityProvider)
- [x] Define shared types, errors, utilities
- [x] Implement @ch4p/security (filesystem scoping, command allowlist, secrets, audit, output sanitizer, input validator)
- [x] Implement @ch4p/supervisor (OTP-inspired supervision trees)
- [x] Implement @ch4p/agent (session, agent-loop, context, steering, worker-pool)
- [x] Implement @ch4p/providers (Anthropic, OpenAI, Ollama)
- [x] Implement @ch4p/tools (bash, file-read, file-write, file-edit, grep, glob, mcp-client)
- [x] Implement @ch4p/memory (SQLite hybrid search)
- [x] Implement @ch4p/observability (console, file, multi, noop)
- [x] Implement @ch4p/engines (native, echo, registry)
- [x] Implement @ch4p/cli (onboard wizard, agent command, config loading)
- [x] Install dependencies and verify build (13 packages compile clean)
- [x] Write test suite (32 files, 915 tests passing)
- [x] Create Diataxis documentation (20+ docs)
- [x] AWM integration (MCP client, mandatory validation, named strategies, state snapshots, verifier)
- [x] Documentation audit — all reference docs match source code
- [x] README header image (Chappie-inspired SVG)
- [x] First commit and push to GitHub
- [x] ERC-8004 research — analysis complete, IIdentityProvider trait added to core

### Verification
- [x] `ch4p agent -m "..."` wired to real NativeEngine → Provider (API key required)
- [x] Security audit passes all checks
- [x] Test coverage > 90% — gateway (61), channels (54), CLI (69+12=81 tests)

### Stats
- **First commit**: `14d4c10` — 2026-02-15
- **Repo**: https://github.com/vxcozy/ch4p
- **15 packages**, 46 test files, **1299 tests passing**

---

## Current: Phase 2 — Integration

### 1. Concrete IVerifier ✅
- [x] `FormatVerifier` — 5 built-in rules, custom rule support, configurable thresholds
- [x] `LLMVerifier` — LLM-as-a-judge wrapping FormatVerifier, structured JSON parsing
- [x] Tests: 24 format + 19 LLM = 43 verifier tests
- [x] Exported from @ch4p/agent

### 2. State Snapshots on File Tools ✅
- [x] `file-write.ts` — `getStateSnapshot()` via `captureFileState()` utility
- [x] `file-edit.ts` — `getStateSnapshot()` via `captureFileState()` utility
- [x] `bash.ts` — `getStateSnapshot()` capturing cwd state + entry count
- [x] `snapshot-utils.ts` — shared utility with SHA-256 content hashing
- [x] Tests: 8 snapshot-utils + 4 file-write snapshot = 12 new tests

### 3. Real Engine Integration ✅
- [x] CLI `createEngine()` wires NativeEngine → ProviderRegistry → real provider
- [x] Graceful fallback to stub when API key missing or provider creation fails
- [x] Ollama works without API key (local server)
- [x] Event translation already complete in NativeEngine (StreamEvent → EngineEvent)

### 4. Memory Integration ✅
- [x] `AgentLoopOpts.memoryBackend` — optional injection point
- [x] `executeTool()` spreads memoryBackend onto ToolContext
- [x] Memory tools (`memory_store`, `memory_recall`) access it via MemoryToolContext cast
- [x] `createMemoryBackend()` factory supports sqlite, markdown, noop backends
- [x] End-to-end test: agent loop with memory tools (6 tests: store→recall→answer, metadata tracking, empty recall, no-backend error, backend persistence, observer notification)

### 5. End-to-End Flow ✅
- [x] CLI now routes through full AgentLoop (Session → AgentLoop → Engine → Tools)
- [x] Old direct-engine path replaced with `handleAgentEvent()` for AgentEvent stream
- [x] `createToolRegistry()` creates default tool set, respects readonly autonomy
- [x] `createAgentLoop()` wires Session, Engine, Tools, NoopObserver
- [x] REPL `/tools` command now lists registered tools with weight + description
- [x] 12 E2E integration tests: text streaming, tool execution, validation, snapshots, observer, errors, lifecycle
- [x] Smoke test via claude-cli subprocess engine (`ch4p agent -m "What is 2+2?"` → "Four")

### 6. Gateway Expansion ✅
- [x] PairingManager — one-time pairing codes, token exchange, SHA-256 hashing, LRU eviction
- [x] GatewayServer enhanced — CORS, auth middleware, POST /pair, POST /sessions, GET /sessions/:id
- [x] CLI gateway command wired — real server startup, --port override, pairing code display
- [x] CLI pairing command wired — generate, list, revoke, status subcommands
- [x] 61 gateway tests: SessionManager, MessageRouter, PairingManager, HTTP routes, auth flow, lifecycle

### 7. Channel Adapters ✅
- [x] TelegramChannel — Bot API, long-polling + webhook, user allowlisting, attachments, MarkdownV2
- [x] DiscordChannel — Gateway WebSocket + REST API, heartbeat/reconnection, guild/user filtering, typing
- [x] SlackChannel — Web API + Socket Mode/Events API, thread support, HMAC signature verification
- [x] ChannelRegistry — register, list, createFromConfig
- [x] 54 channel tests: CLI, Telegram, Discord, Slack, Registry

### 8. Remaining Tests ✅
- [x] Gateway package tests (61 tests)
- [x] Channels package tests (54 tests)
- [x] CLI package tests — config module (33 tests) + commands (36 tests) = 69 tests

---

## Plugins (build when needed, opt-in by design)

### @ch4p/plugin-erc8004 — On-Chain Agent Identity
Implements `IIdentityProvider` using ERC-8004 Trustless Agents contracts.
Analysis: `tasks/erc-8004-analysis.md`

- [ ] `EthIdentityProvider` — concrete implementation using `viem` or `ethers.js`
- [ ] Agent registration (ERC-721 mint via Identity Registry)
- [ ] Service discovery (`.well-known/agent.json` via gateway route)
- [ ] Reputation queries and feedback submission
- [ ] Validation request/response flow
- [ ] Trust assessment (reputation-gated delegation and MCP connections)
- [ ] `IObserver` extension — `onIdentityEvent()` for on-chain event tracking
- [ ] `ISecurityPolicy` extension — `checkAgentTrust()` for reputation gating
- [ ] `IVerifier` wrapper — `OnChainVerifier` for attestation submission
- [ ] CLI commands: `ch4p identity register`, `ch4p identity status`
- [ ] Config section: `identity.enabled`, chain/contract addresses, trust thresholds

---

## Completed: Stretch Goals ✅

### 1. Additional Providers ✅
- [x] `GoogleProvider` — Gemini API (v1beta), SSE streaming, function calling, AIza key validation
- [x] `OpenRouterProvider` — OpenAI-compatible API, HTTP-Referer/X-Title headers, sk-or- key validation
- [x] `BedrockProvider` — Converse API, manual AWS Signature V4, session token support
- [x] `ProviderRegistry` updated — 6 providers (anthropic, openai, google, openrouter, ollama, bedrock)
- [x] Tests: 22 Google + 22 OpenRouter + 25 Bedrock = 69 new provider tests

### 2. CLI Engine Wrappers ✅
- [x] `SubprocessEngine` — generic CLI wrapper, 3 prompt modes (arg/stdin/flag), cancellation via SIGTERM
- [x] `createClaudeCliEngine()` — pre-configured for `claude --print`
- [x] `createCodexCliEngine()` — pre-configured for `codex --quiet`
- [x] Tests: 13 subprocess engine tests

### 3. Tunnel Providers ✅
- [x] `@ch4p/tunnels` package — new package in monorepo
- [x] `CloudflareTunnel` — wraps cloudflared, Quick Tunnel + named tunnel support
- [x] `TailscaleTunnel` — wraps tailscale funnel, hostname via status --json
- [x] `NgrokTunnel` — wraps ngrok, polls local API for public URL
- [x] `createTunnelProvider()` factory function
- [x] Tests: 17 tunnel tests

### Stats
- **15 packages**, 46 test files, **1299 tests passing**

---

### 4. Single-File Distribution ✅
- [x] Bun installed as build tool for standalone binary compilation
- [x] `apps/cli/build.ts` — bun build script with compile-time version injection, cross-compilation support
- [x] `bun build --compile` produces 58 MB standalone binary (embeds Bun runtime)
- [x] `CH4P_VERSION` define baked in at compile time, filesystem fallback preserved
- [x] `better-sqlite3` externalized (only native module, not wired in CLI)
- [x] Scripts: `build:bundle` (CLI), `bundle` (root)
- [x] Binary verified: `--help`, `--version`, error handling all work

### Stats
- **15 packages**, 46 test files, **1299 tests passing**

---

## Completed: Skills System ✅

### @ch4p/skills Package
- [x] `SkillManifest`, `Skill`, `ParseResult` types, `SkillParseError` class
- [x] Zero-dependency YAML frontmatter parser (key-value, block scalars, arrays, nested objects)
- [x] Skill loader — filesystem discovery, tilde expansion, source classification, dir-name validation
- [x] `SkillRegistry` — register/get/list/unregister, `getDescriptions()`, `getSkillContext()`, `createFromPaths()`
- [x] Config: `Ch4pConfig.skills` section (enabled, paths, autoLoad, contextBudget)
- [x] CLI: `ch4p skills list`, `ch4p skills show <name>`, `ch4p skills verify`
- [x] Agent integration: skills loaded into system prompt, `/skills` REPL command
- [x] Tests: 35 tests (parser, loader, registry)
- [x] OpenClaw/Agent Skills specification compatible (SKILL.md format, directory conventions)

### Stats
- **15 packages**, 46 test files, **1299 tests passing**

---

## All Stretch Goals Complete ✅

- [x] ~~Single-file distribution — Node SEA or bun compile~~ (done via bun compile)
- [x] ~~Skills system — TOML manifests, skill loader, OpenClaw compatibility~~ (done via @ch4p/skills)
