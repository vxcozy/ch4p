# How to Use Skills

Skills are curated instruction sets that give your agent specialized knowledge. They're loaded on-demand via progressive disclosure.

---

## Prerequisites

- A working ch4p installation

---

## Step 1: Create a Skill

Skills are Markdown files with YAML frontmatter. Create a directory under one of the skill search paths:

```bash
mkdir -p ~/.ch4p/skills/my-skill
```

Create the skill file `~/.ch4p/skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: Short description of what this skill does.
license: MIT
compatibility: ["claude", "copilot"]
metadata:
  author: your-name
  version: "1.0.0"
---

# My Skill Instructions

Detailed instructions for the agent when this skill is loaded.

## Guidelines

- Be specific about what the agent should do
- Include examples of expected behavior
- Reference tools or APIs the agent should use
```

---

## Step 2: Skill Discovery Paths

Skills are searched in these directories (later paths override earlier):

1. `~/.ch4p/skills/` -- User-level skills
2. `.ch4p/skills/` -- Project-level skills
3. `.agents/skills/` -- OpenClaw-compatible location

The directory name must match the `name` field in the YAML frontmatter.

---

## Step 3: Name Rules

Skill names must follow this pattern: `^[a-z0-9]+(-[a-z0-9]+)*$`

- Lowercase alphanumeric with hyphens
- 1-64 characters
- Examples: `code-review`, `deploy-helper`, `data-analysis`

---

## Step 4: Managing Skills

```bash
# List installed skills
ch4p skills

# Show a specific skill's content
ch4p skills show my-skill

# Validate all skill manifests
ch4p skills verify
```

---

## How Progressive Disclosure Works

1. The agent sees skill **names and descriptions** in its system prompt
2. When a skill is relevant, the agent calls `load_skill` to fetch the full body
3. The loaded skill instructions are then available for the current conversation

This keeps the agent's context lean while giving it access to detailed knowledge on-demand.

---

## Configuration

```json
{
  "skills": {
    "enabled": true,
    "paths": ["~/.ch4p/skills", ".ch4p/skills", ".agents/skills"],
    "autoLoad": true,
    "contextBudget": 16000
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable the skills system. |
| `paths` | `string[]` | see above | Directories to search for skills. |
| `autoLoad` | `boolean` | `true` | Auto-inject skill descriptions into system prompt. |
| `contextBudget` | `number` | `16000` | Max characters for skill context injection. |

---

## Compatibility

Skills follow the Agent Skills specification and are compatible with the OpenClaw skill format. Skills authored for other platforms can be placed in the search paths and used directly.
