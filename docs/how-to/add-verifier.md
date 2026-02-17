# How to Add a Custom Verifier

This guide walks you through implementing the `IVerifier` interface to create custom task-level verification.

---

## Prerequisites

- A working ch4p development environment
- Understanding of the verification pipeline (format checks + semantic checks)

---

## Overview

ch4p uses a hybrid verification system inspired by the Agent World Model (AWM) research:

1. **FormatVerifier** (structural/rule-based) -- always runs
2. **LLMVerifier** (semantic, LLM-as-a-judge) -- runs when `verification.semantic: true`

You can add custom verifiers that implement the same `IVerifier` interface.

---

## Step 1: Create the Verifier File

Create a new file in `packages/agent/src/`:

```bash
touch packages/agent/src/my-verifier.ts
```

---

## Step 2: Implement IVerifier

```typescript
import type { IVerifier, VerificationResult, VerificationContext } from '@ch4p/core';

export class MyVerifier implements IVerifier {
  readonly id = 'my-verifier';

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check tool error ratio
    const totalCalls = context.toolCalls?.length ?? 0;
    const failedCalls = context.toolCalls?.filter(tc => !tc.result.success).length ?? 0;

    if (totalCalls > 0 && failedCalls / totalCalls > 0.5) {
      errors.push(`High tool failure rate: ${failedCalls}/${totalCalls} calls failed`);
    }

    // Custom domain-specific checks
    if (context.taskDescription?.includes('deploy') && !context.finalResponse?.includes('success')) {
      warnings.push('Deployment task did not explicitly confirm success');
    }

    return {
      passed: errors.length === 0,
      errors,
      warnings,
      metadata: {
        verifier: this.id,
        totalToolCalls: totalCalls,
        failedToolCalls: failedCalls,
      },
    };
  }
}
```

---

## Step 3: Register the Verifier

Wire your verifier into the agent loop, following the same pattern as the built-in `FormatVerifier` and `LLMVerifier`:

```typescript
import { MyVerifier } from './my-verifier.js';

const verifier = new MyVerifier();
// Pass to AgentLoop configuration
```

---

## Built-in Verifiers

### FormatVerifier

Structural checks that always run:
- Tool call success/failure ratio
- Empty response detection
- Response length validation
- Required fields presence

### LLMVerifier

Semantic checks using the AI engine as a judge:
- Task completion assessment
- Response quality evaluation
- Instruction adherence verification
- Active when `verification.semantic: true` (default)

---

## Configuration

```json
{
  "verification": {
    "enabled": true,
    "semantic": true,
    "maxToolErrorRatio": 0.5
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable task-level verification. |
| `semantic` | `boolean` | `true` | Enable LLM-based semantic checks. |
| `maxToolErrorRatio` | `number` | `0.5` | Max allowed ratio of failed tool calls. |
