# Explanation: Architecture

This document explains why ch4p is structured the way it is. It covers the Gateway + Agent + Engine pattern, the choice of TypeScript, and the lineage from three prior projects.

---

## The Three-Layer Pattern

ch4p separates concerns into three distinct layers:

```
Channels --> Gateway --> Agent --> Engine (LLM)
                           |
                         Tools
                         Memory
                         Security
```

**Gateway** handles the outside world. It manages connections to messaging platforms, normalizes incoming messages into a common format, and routes outgoing responses back to the right channel. The gateway knows nothing about LLMs, tools, or memory. Its only job is I/O with the external world.

**Agent** is the orchestration layer. It receives normalized messages from the gateway, decides what to do (respond, use a tool, store a memory), manages the conversation loop, and enforces security boundaries. The agent is the only component that coordinates between all the others.

**Engine** is the LLM abstraction. It takes a conversation and returns a completion. It knows nothing about channels, tools, or memory. The agent feeds it context and interprets its output.

This separation exists for a practical reason: each layer changes at a different rate and for different reasons. Messaging platform APIs change frequently. LLM provider APIs evolve rapidly. Security requirements shift with context. By keeping them isolated behind interfaces, any layer can change without rippling through the others.

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

## Lineage: What We Took and Why

ch4p draws from three prior projects, each of which solved one part of the problem well but had limitations that ch4p addresses.

### From OpenClaw: The Multi-Engine Approach

OpenClaw demonstrated that an AI assistant should not be locked to a single LLM provider. It introduced the idea of a provider abstraction layer where multiple engines could be used interchangeably.

ch4p adopted this through the IProvider interface. But where OpenClaw treated providers as nearly identical, ch4p acknowledges that providers have different capabilities (tool calling support, streaming behavior, context window sizes) and surfaces these differences through the ModelInfo type. The agent can make routing decisions based on what a provider actually supports.

### From Lemon: The Channel Mesh

Lemon pioneered connecting a single AI agent to multiple messaging channels simultaneously. Its insight was that the agent should not care where a message comes from -- the channel layer should normalize everything.

ch4p adopted the channel abstraction and the gateway pattern from Lemon. The key difference is that ch4p's gateway is a separate process from the agent. In Lemon, channels ran in the same process as the AI logic, which meant a crash in a channel adapter could take down the entire system. ch4p's process separation provides fault isolation.

### From ZeroClaw: Security Discipline

ZeroClaw was built around the principle that an AI agent connected to the internet is an attack surface, and every capability it has is a potential vulnerability. ZeroClaw's contribution was the idea that security should be on by default, not opt-in.

ch4p adopted ZeroClaw's filesystem scoping, command allowlisting, and output sanitization. But ch4p went further by adding the autonomy level system (locked/supervised/autonomous) and the formal audit command. ZeroClaw's security was effective but opaque -- you could not easily verify that the configuration was correct. ch4p's audit system makes security posture visible and verifiable.

---

## Agent World Model (AWM) Integration

ch4p integrates ideas from the Agent World Model research (Snowflake Labs) to improve agent reliability. AWM demonstrated that agents benefit from three key capabilities:

**Step-level validation.** Every tool call is validated before execution. When the LLM generates malformed arguments, the error is fed back as a tool error message so the LLM can self-correct without wasting a tool execution. This is implemented as mandatory validation in the agent loop — even tools without a `validate()` method get basic structural checks.

**State snapshots and diff-based verification.** Tools that modify external state (files, databases, APIs) can implement `getStateSnapshot()` to capture observable state before and after execution. The agent loop captures these snapshots automatically and makes them available to the IVerifier interface for outcome verification.

**Task-level verification.** The optional IVerifier interface runs after the agent loop completes to assess whether the task was accomplished correctly. Verification is a two-phase process: a fast code-based format check, followed by an optional LLM-based semantic check. This mirrors AWM's code-augmented LLM-as-a-Judge pattern.

Additionally, the context window manager supports named truncation strategies with configurable parameters: compaction targets, keep ratios, tool-call pair preservation, and task description pinning. This implements AWM's finding that history-aware truncation dramatically improves task completion rates.

---

## The I/O Boundary Principle

A concept that runs through ch4p's architecture is the I/O boundary principle, which came from a project called Bagman. The principle states: every point where data crosses a trust boundary must be explicitly guarded.

In ch4p, the trust boundaries are:

1. **Channel to Gateway** — Untrusted external input enters the system. Input validation happens here.
2. **Agent to Engine** — Conversation context leaves the system for a third-party API. Nothing sensitive should leak.
3. **Agent to Tools** — The agent executes actions in the real world. Security controls gate this boundary.
4. **Tools to Agent** — Tool output returns. Output sanitization catches leaked secrets before they reach channels.
5. **Agent to Channel** — Responses leave the system. Final sanitization pass.

Every boundary has an explicit guard. No data crosses a boundary without passing through a validation or sanitization layer. This is not paranoia -- it is the minimum viable security model for a system that simultaneously reads your files, executes commands, talks to external APIs, and broadcasts to messaging platforms.
