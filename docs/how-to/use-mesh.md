# How to Use Mesh Orchestration

Mesh orchestration enables swarm-style multi-agent delegation. The agent can spawn multiple sub-agents in parallel, each running on a different engine or model, and collect their results as a structured aggregate.

---

## Prerequisites

- At least one working engine configured (native API, claude-cli, codex-cli, or Ollama)
- Mesh enabled in configuration

---

## Configuration

Enable mesh in `~/.ch4p/config.json`:

```json
{
  "mesh": {
    "enabled": true,
    "maxConcurrency": 3,
    "defaultTimeout": 120000
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable the mesh tool. |
| `maxConcurrency` | `number` | `3` | Maximum parallel sub-agents (1-10). |
| `defaultTimeout` | `number` | `120000` | Per-task timeout in milliseconds. |

Or enable it via the onboard wizard under **Services > Enable mesh orchestration**.

---

## How It Works

The `mesh` tool accepts an array of tasks and spawns sub-agents in parallel:

1. Each task can optionally specify a target engine and model
2. Sub-agents run concurrently up to the `maxConcurrency` limit
3. A semaphore ensures bounded parallelism
4. Results are collected via `Promise.allSettled` — partial failures don't block other tasks
5. The agent receives a structured result with per-task outcomes

---

## Example Usage

When the agent decides to use mesh orchestration, it calls the `mesh` tool with a task array:

```json
{
  "tasks": [
    { "task": "Research the latest TypeScript 5.x features" },
    { "task": "Analyze the performance of our API endpoints", "engine": "claude-cli" },
    { "task": "Summarize the project README" }
  ],
  "concurrency": 3
}
```

Each task spawns an independent sub-agent. Results are returned as:

```json
{
  "results": [
    { "task": "Research the latest TypeScript 5.x features", "status": "fulfilled", "result": "..." },
    { "task": "Analyze the performance of our API endpoints", "status": "fulfilled", "result": "..." },
    { "task": "Summarize the project README", "status": "fulfilled", "result": "..." }
  ],
  "summary": "3/3 tasks completed successfully"
}
```

---

## Partial Failures

If a sub-agent fails (engine error, timeout, abort), the mesh tool still returns results for all other tasks. Failed tasks include an error message:

```json
{
  "task": "Analyze endpoints",
  "status": "rejected",
  "error": "Task timed out after 120000ms"
}
```

---

## Multi-Engine Delegation

Mesh works across engines. Each task can target a different engine:

```json
{
  "tasks": [
    { "task": "Quick analysis", "engine": "native", "model": "claude-sonnet-4-20250514" },
    { "task": "Deep research", "engine": "claude-cli" },
    { "task": "Local inference", "engine": "native", "model": "llama3.3" }
  ]
}
```

---

## Future: P2P Mesh

The current swarm delegation is Layer 1 of the mesh architecture. It establishes the parallel execution foundation. A future Layer 2 will add:

- Agent discovery and registration
- Bidirectional communication between sub-agents
- Shared context and memory across the swarm
- Dynamic task redistribution

The swarm layer becomes the transport for the future P2P mesh — they are sequential, not competing architectures.
