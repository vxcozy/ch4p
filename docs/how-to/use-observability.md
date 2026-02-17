# How to Use Observability

This guide explains how to configure the observer pattern for logging, monitoring, and debugging your ch4p agent.

---

## Prerequisites

- A working ch4p installation

---

## Overview

ch4p uses an observer pattern (`IObserver` interface) that emits structured events for all major subsystems:

- **Session events**: session start/end, message received/sent
- **Tool events**: tool calls, results, validation errors
- **LLM events**: API requests, responses, token usage
- **Security events**: policy violations, blocked actions, audit logs

Observers receive events and can log, store, or forward them as needed.

---

## Built-in Observers

### Console Observer

Prints formatted events to the terminal. Active by default.

### File Observer

Writes structured JSONL logs to disk with secure file permissions (`0o600` for files, `0o700` for directories).

---

## Configuration

```json
{
  "logging": {
    "level": "info",
    "format": "text",
    "file": "~/.ch4p/logs/agent.log",
    "maxSize": "10mb",
    "maxFiles": 5
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `level` | `string` | `"info"` | Log level: `"debug"`, `"info"`, `"warn"`, `"error"`. |
| `format` | `string` | `"text"` | Output format: `"text"` or `"json"`. |
| `file` | `string` | `null` | Log file path. `null` = stdout only. |
| `maxSize` | `string` | `"10mb"` | Max log file size before rotation. |
| `maxFiles` | `number` | `5` | Number of rotated log files to keep. |

---

## Creating a Custom Observer

Implement the `IObserver` interface:

```typescript
import type { IObserver, ObserverEvent } from '@ch4p/core';

export class MyObserver implements IObserver {
  readonly id = 'my-observer';

  async onEvent(event: ObserverEvent): Promise<void> {
    switch (event.type) {
      case 'session:start':
        console.log(`Session started: ${event.sessionId}`);
        break;
      case 'tool:call':
        console.log(`Tool called: ${event.toolName}`);
        break;
      case 'security:violation':
        // Send alert to monitoring system
        await this.sendAlert(event);
        break;
    }
  }

  private async sendAlert(event: ObserverEvent): Promise<void> {
    // Your alerting logic here
  }
}
```

---

## Multi-Observer Support

Multiple observers can be active simultaneously. The `ObserverRegistry` broadcasts events to all registered observers:

```typescript
import { ObserverRegistry } from '@ch4p/observability';

const registry = new ObserverRegistry();
registry.register(new ConsoleObserver());
registry.register(new FileObserver({ path: '~/.ch4p/logs' }));
registry.register(new MyObserver());
```

---

## Security Events

The observer system captures security-related events that are critical for audit trails:

- File access attempts outside allowed paths
- Blocked command executions
- Output sanitization actions (credentials redacted)
- Input validation rejections
- SSRF protection blocks

These events are logged with full context for forensic analysis.
