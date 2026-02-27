# Explanation: Architecture

This document explains why ch4p is structured the way it is. It covers the six-layer stack, the choice of TypeScript, and the research that informed its design.

---

## The Six-Layer Stack

ch4p separates concerns into six layers. Each layer has a single job, talks only to its immediate neighbors, and can be swapped without disturbing the rest of the stack.

```
┌─────────────────────────────────────────────────────────────────┐
│  Channels (CLI, Telegram, Discord, …)   Canvas (tldraw, A2UI)  │  ← Surface
├─────────────────────────────────────────────────────────────────┤
│  Gateway (HTTP server, WS upgrade, session routing)             │  ← Routing
├─────────────────────────────────────────────────────────────────┤
│  Agent Runtime (session, context, steering, tool dispatch)      │  ← Orchestration
├─────────────────────────────────────────────────────────────────┤
│  Engine (native LLM, echo, CLI subprocess)                      │  ← LLM abstraction
├─────────────────────────────────────────────────────────────────┤
│  Provider (Anthropic, OpenAI, Google/Gemini, OpenRouter, …)     │  ← LLM transport
├─────────────────────────────────────────────────────────────────┤
│  Tools / Memory / Security                                      │  ← Capabilities
└─────────────────────────────────────────────────────────────────┘
```

### Channels (Surface)

Channels are the user-facing endpoints. Each channel implements the IChannel interface: receive messages from a platform, normalize them into a common InboundMessage format, and send responses back. The CLI terminal, Telegram, Discord, Slack, Matrix, and 12 other adapters all sit here. So does the Canvas, which translates spatial interactions (button clicks, form submissions) into the same message format.

Channels know nothing about LLMs, tools, or memory. They convert platform-specific I/O into a common shape and hand it to the gateway.

### Gateway (Routing)

The gateway is the HTTP and WebSocket server that sits between channels and the agent runtime. It manages connections to messaging platforms, maps incoming messages to sessions, and routes outgoing responses back to the right channel. It also serves static files for the canvas web UI and handles WebSocket upgrades for real-time streaming.

The gateway knows nothing about LLMs, tools, or memory. Its only job is I/O routing and session management.

### Agent Runtime (Orchestration)

The agent is the only layer that talks to everything else. It receives normalized messages from the gateway, decides what to do (respond, call a tool, store a memory), manages the conversation loop, enforces security boundaries, and coordinates verification. The agent loop runs tools, feeds results back into context, and repeats until the task is done or a limit is hit.

### Engine (LLM Abstraction)

The engine takes a conversation and returns a completion. It knows nothing about channels, tools, or memory. The agent feeds it context and interprets its output. Three engine implementations exist: NativeEngine (direct API calls via a provider), SubprocessEngine (spawns `claude --print` as a child process), and EchoEngine (deterministic responses for testing).

### Provider (LLM Transport)

Providers handle the HTTP transport to a specific LLM vendor. Each implements the IProvider interface with `chatCompletion()` and `streamCompletion()` methods. Anthropic, OpenAI, Google/Gemini, OpenRouter, Ollama, and AWS Bedrock are supported. The engine picks a provider; the provider handles auth, request formatting, and response parsing for that vendor's API.

Separating Engine from Provider means the agent can switch between "run Claude natively" and "run Claude through a subprocess" without touching any provider code, and a provider can update its API handling without affecting how the engine manages conversations.

### Tools / Memory / Security (Capabilities)

The bottom layer provides everything the agent can *do* beyond generating text. Tools implement the ITool interface (bash, file operations, web search, browser, MCP bridges, canvas rendering, delegation). Memory provides hybrid search over past conversations (SQLite FTS5 + vector embeddings). Security enforces filesystem scoping, command allowlisting, output sanitization, and the autonomy level system.

These capabilities are registered with the agent at startup and dispatched through the tool execution pipeline, which handles validation, state snapshots, and result sanitization.

### Why six layers?

Each layer changes at a different rate and for different reasons. Messaging platform APIs change frequently. LLM provider APIs evolve rapidly. Security requirements shift with context. Tool implementations grow as new capabilities are added. By keeping them isolated behind interfaces, any layer can change without rippling through the others.

---

## Why Ten Interfaces

ch4p defines ten trait interfaces: IProvider, IChannel, ITool, IVerifier, IMemoryBackend, IEngine, ISecurityPolicy, IObserver, ITunnelProvider, and IIdentityProvider. This is more than most similar projects, and the reason is deliberate.

Each interface represents a boundary where a different person might want to make a different choice. You might want Anthropic instead of OpenAI. Telegram instead of Discord. SQLite memory instead of PostgreSQL. A permissive security policy instead of a strict one. A code-based verifier instead of an LLM-as-a-judge. On-chain identity via ERC-8004 or no identity at all. By making each of these a formal interface, the system communicates exactly what contract each component must fulfill, and swapping one implementation for another is a matter of implementing the interface and registering it.

This is the trait pattern from Rust and the interface pattern from Go applied to TypeScript. It trades a bit of upfront ceremony for long-term flexibility.

---

## Why TypeScript

Three reasons drove the choice of TypeScript over alternatives:

**Async I/O is the dominant workload.** ch4p spends most of its time waiting: waiting for LLM responses, waiting for channel messages, waiting for tool executions. Node.js's event loop handles this naturally. A language optimized for CPU computation (Rust, Go) would spend most of its time in the same async I/O patterns but with more complex concurrency primitives.

**The ecosystem aligns.** Most messaging platform SDKs have high-quality JavaScript/TypeScript libraries. LLM provider SDKs are JavaScript-first. SQLite bindings (better-sqlite3) are mature. Fighting the ecosystem to use a different language would mean maintaining more code for the same result.

**Type safety without compilation overhead.** TypeScript's structural type system catches interface contract violations at compile time. The 10-interface architecture depends on the compiler verifying that implementations are complete and correct. JavaScript alone would not provide this.

The tradeoff is that CPU-intensive work (embedding generation, large-scale text processing) is slower in Node.js. ch4p addresses this by offloading such work to worker threads (see [Concurrency](concurrency.md)).

---

## Research Foundations

ch4p was built from scratch, but its architecture was informed by studying several existing projects and research papers. Each of these shaped a specific design decision.

### Multi-Engine Approach (studied: OpenClaw)

Research on OpenClaw showed that an AI assistant should not be locked to a single LLM provider. OpenClaw introduced the idea of a provider abstraction layer where multiple engines could be used interchangeably.

ch4p implements this idea through the IProvider interface. Where OpenClaw treated providers as nearly identical, ch4p acknowledges that providers have different capabilities (tool calling support, streaming behavior, context window sizes) and surfaces these differences through the ModelInfo type. The agent can make routing decisions based on what a provider actually supports.

### Channel Mesh (studied: Lemon)

Research on Lemon showed that connecting a single AI agent to multiple messaging channels simultaneously requires a normalization layer. Lemon's insight was that the agent should not care where a message comes from -- the channel layer should handle the differences.

ch4p builds on this insight with its own channel abstraction and gateway pattern, designed from scratch. A key difference: ch4p's gateway is a separate process from the agent. In Lemon, channels ran in the same process as the AI logic, meaning a crash in a channel adapter could take down the entire system. ch4p's process separation provides fault isolation.

### Security-First Defaults (studied: ZeroClaw)

Research on ZeroClaw showed that an AI agent connected to the internet is an attack surface, and every capability it has is a potential vulnerability. ZeroClaw established the principle that security should be on by default, not opt-in.

ch4p's security subsystem was built from scratch with this principle at its core. It implements filesystem scoping, command allowlisting, and output sanitization, and goes further by adding the autonomy level system (locked/supervised/autonomous) and a formal audit command that makes security posture visible and verifiable.

---

## Agent World Model (AWM) Integration

ch4p integrates ideas from the Agent World Model research (Snowflake Labs) to improve agent reliability. AWM demonstrated that agents benefit from three key capabilities:

**Step-level validation.** Every tool call is validated before execution. When the LLM generates malformed arguments, the error is fed back as a tool error message so the LLM can self-correct without wasting a tool execution. This is implemented as mandatory validation in the agent loop — even tools without a `validate()` method get basic structural checks.

**State snapshots and diff-based verification.** Tools that modify external state (files, databases, APIs) can implement `getStateSnapshot()` to capture observable state before and after execution. The agent loop captures these snapshots automatically and makes them available to the IVerifier interface for outcome verification.

**Task-level verification.** The optional IVerifier interface runs after the agent loop completes to assess whether the task was accomplished correctly. Verification is a two-phase process: a fast code-based format check, followed by an optional LLM-based semantic check. This mirrors AWM's code-augmented LLM-as-a-Judge pattern.

Additionally, the context window manager supports named truncation strategies with configurable parameters: compaction targets, keep ratios, tool-call pair preservation, and task description pinning. This implements AWM's finding that history-aware truncation dramatically improves task completion rates.

---

## The Canvas: A2UI as a Second Output Surface

The canvas workspace (`ch4p canvas`) introduces a second output surface alongside text-based channels. Where channels produce linear text responses, the canvas produces spatial, interactive UI components on an infinite tldraw canvas.

The canvas reuses the existing architecture rather than creating a parallel stack. It plugs into the same gateway, agent runtime, and engine layers through two new components:

**CanvasTool** — An ITool implementation named `canvas_render`. When the agent decides to show something visually, it calls this tool with a component type (card, chart, form, etc.), data, and position. The tool writes to a server-side CanvasState object, which emits change events. This is the agent's only way to affect the canvas — it goes through the same tool validation and security pipeline as every other tool.

**CanvasChannel** — An IChannel implementation that translates user interactions (button clicks, form submissions, drag events) into the same InboundMessage format that Telegram or Discord would produce. The agent does not know or care whether a message came from a chat panel or a button click on a card — it is all normalized text.

The transport layer is WebSocket rather than HTTP webhooks. The gateway upgrades `/ws/:sessionId` connections and creates a WebSocketBridge that wires the CanvasState change events to the browser and routes browser interactions back to the CanvasChannel. Agent events (text streaming, tool execution status) are also pushed to the browser in real-time.

This design means the canvas adds zero special cases to the agent runtime. The agent loop, context management, security boundaries, and verification pipeline all work identically whether the session is text-only or canvas-enabled.

---

## The I/O Boundary Principle

A concept that runs through ch4p's architecture is the I/O boundary principle, informed by research on a project called Bagman. The principle states: every point where data crosses a trust boundary must be explicitly guarded.

In ch4p, the trust boundaries are:

1. **Channel to Gateway** — Untrusted external input enters the system. Input validation happens here.
2. **Canvas WebSocket to Gateway** — Browser interactions enter via WebSocket. The CanvasChannel normalizes them into the same message format as any other channel.
3. **Agent to Engine** — Conversation context leaves the system for a third-party API. Nothing sensitive should leak.
4. **Agent to Tools** — The agent executes actions in the real world. Security controls gate this boundary. This includes `canvas_render`, which modifies the visual canvas state.
5. **Tools to Agent** — Tool output returns. Output sanitization catches leaked secrets before they reach channels.
6. **Agent to Channel** — Responses leave the system. Final sanitization pass.

Every boundary has an explicit guard. No data crosses a boundary without passing through a validation or sanitization layer. This is not paranoia -- it is the minimum viable security model for a system that simultaneously reads your files, executes commands, talks to external APIs, and broadcasts to messaging platforms.
