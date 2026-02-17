# Reference: CLI Commands

All ch4p CLI commands, their flags, and expected output.

---

## Global Flags

These flags are available on all commands.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--config` | `string` | `~/.ch4p/config.json` | Path to configuration file. |
| `--verbose` | `boolean` | `false` | Enable debug-level logging. |
| `--quiet` | `boolean` | `false` | Suppress all output except errors. |
| `--version` | `boolean` | `false` | Print version and exit. |
| `--help` | `boolean` | `false` | Print help for the command. |

---

## ch4p agent

Start the agent in interactive mode.

```
ch4p agent [flags]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--provider` | `string` | from config | Override the LLM provider. |
| `--model` | `string` | from config | Override the model. |
| `--autonomy` | `string` | from config | Override autonomy level. |
| `--no-memory` | `boolean` | `false` | Disable memory for this session. |
| `--system-prompt` | `string` | from config | Override the system prompt. |

**Example:**

```bash
ch4p agent --provider ollama --model llama3 --autonomy supervised
```

**Output:** Interactive prompt with `<agent-name>` prefix.

---

## ch4p onboard

Run the interactive setup wizard to create or update `~/.ch4p/config.json`.

```
ch4p onboard
```

The wizard adapts to your environment. If CLI engines (Claude Code, Codex, Ollama) are detected on your PATH, it offers them as alternatives to API key setup. The core steps are:

1. **Engine setup** — choose between detected CLI engines or API key setup
2. **API keys** — Anthropic and OpenAI keys (skipped for CLI engine users)
3. **Preferred model** — pick from available models (skipped for CLI engine users)
4. **Autonomy level** — read-only, supervised, or full
5. **Additional features** — ~20 individually skippable categories in 4 groups:
   - **Providers** — Google/Gemini, OpenRouter, AWS Bedrock
   - **Channels** — multi-select from 14 messaging channels with per-channel config
   - **Services** — web search, browser, voice STT/TTS, MCP servers, cron jobs
   - **System** — memory, verification, gateway, security, commands, tunnel, canvas, observability, skills
6. **Save** — writes config and runs a security audit

Every category defaults to skip. Pressing Enter through everything produces the same default configuration.

---

## ch4p gateway

Start the gateway for external channel connections.

```
ch4p gateway [flags]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--production` | `boolean` | `false` | Enable production mode (structured logging, auto-restart). |
| `--tunnel` | `boolean` | `false` | Establish a tunnel for public webhook access. |
| `--port` | `number` | from config | Override the gateway port. |
| `--channels` | `string` | all enabled | Comma-separated list of channels to start. |

**Example:**

```bash
ch4p gateway --production --tunnel --channels telegram,slack
```

**Output:** Gateway boot log showing connected channels and tunnel URL (if enabled).

---

## ch4p audit

Run a security audit on the current configuration.

```
ch4p audit [flags]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--full` | `boolean` | `false` | Run all checks including optional ones. |
| `--output` | `string` | stdout | Write report to file (JSON format). |
| `--check-path` | `string` | `null` | Test if a specific path is allowed or blocked. |
| `--check-command` | `string` | `null` | Test if a specific command is allowed or blocked. |
| `--fix` | `boolean` | `false` | Automatically fix issues where possible. |

**Example:**

```bash
ch4p audit --full --output audit.json
```

**Output:** List of PASS, WARN, FAIL items with a summary line.

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | All checks passed. |
| `1` | Warnings present, no failures. |
| `2` | One or more failures. |

---

## ch4p doctor

Diagnose the ch4p installation and provider connections.

```
ch4p doctor [flags]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--provider` | `string` | `null` | Test a specific provider connection. |
| `--channel` | `string` | `null` | Test a specific channel connection. |
| `--compact-memory` | `boolean` | `false` | Run SQLite VACUUM on the memory database. |
| `--repair-memory` | `boolean` | `false` | Rebuild FTS and vector indexes. |

**Example:**

```bash
ch4p doctor --provider anthropic
```

**Output:**

```
  ch4p Doctor
  ────────────────────────────────────────────────────

  + Node.js version      Node.js v22.x detected.
  + Config file          Valid config at ~/.ch4p/config.json
  + Data directory       Exists at ~/.ch4p
  + Memory database      Data directory accessible.
  + API keys             Anthropic API key configured.
  + Security audit       All 10 checks passed.

  ────────────────────────────────────────────────────
  OK 6  WARN 0  FAIL 0  (6 checks)

  All checks passed. ch4p is healthy.
```

---

## ch4p status

Show the current status of the agent and gateway.

```
ch4p status [flags]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--memory` | `boolean` | `false` | Include memory statistics. |
| `--json` | `boolean` | `false` | Output as JSON. |

**Example:**

```bash
ch4p status --memory
```

**Output:**

```
  ch4p Status
  ────────────────────────────────────────────────────

  Version        0.1.0
  Config         ~/.ch4p/config.json
  Data dir       ~/.ch4p
  Provider       anthropic
  Model          claude-sonnet-4-20250514
  Engine         native
  Autonomy       supervised
  Memory         sqlite (auto-save: on)
  Gateway        port 18789 (pairing: required)
  Channels       telegram, discord
  Tunnel         disabled
  Observers      console
  Secrets        encrypted
  API Keys       anthropic configured
```

---

## ch4p tools

List or test registered tools.

```
ch4p tools [flags]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--test` | `string` | `null` | Run a specific tool by name. |
| `--input` | `string` | `null` | JSON input for `--test`. |
| `--run` | `string` | `null` | Execute a tool outside a conversation. |
| `--json` | `boolean` | `false` | Output as JSON. |

**Example:**

```bash
ch4p tools
```

**Output:**

```
  ch4p Tools
  ────────────────────────────────────────────────────

  bash            Execute a shell command...
                  weight: heavyweight
  file_read       Read the contents of a file...
                  weight: lightweight
  file_write      Write content to a file...
                  weight: lightweight
  file_edit       Perform exact string replacements...
                  weight: lightweight
  grep            Search file contents using regex...
                  weight: lightweight
  glob            Find files matching a glob pattern...
                  weight: lightweight
  web_fetch       Fetch content from a URL...
                  weight: heavyweight
  memory_store    Store content in persistent memory...
                  weight: lightweight
  memory_recall   Query persistent memory...
                  weight: lightweight

  ────────────────────────────────────────────────────
  12 tools (7 lightweight, 5 heavyweight)
```

---

## ch4p pairing

Manage channel pairing and authentication.

```
ch4p pairing [flags]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--channel` | `string` | **required** | Channel to pair. |
| `--generate-code` | `boolean` | `false` | Generate a one-time pairing code. |
| `--revoke` | `string` | `null` | Revoke a user's access by platform ID. |
| `--list` | `boolean` | `false` | List all paired users. |

**Example:**

```bash
ch4p pairing --channel telegram --list
```

**Output:**

```
Paired users (telegram):
  98765432  @username  paired 2024-01-15
```

---

## ch4p message

Send a single message to the agent without entering interactive mode.

```
ch4p message [flags] <text>
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--tool` | `string` | `null` | Execute a specific tool directly. |
| `--input` | `string` | `null` | JSON input for `--tool`. |
| `--json` | `boolean` | `false` | Output response as JSON. |
| `--no-tools` | `boolean` | `false` | Disable tool use for this message. |

**Example:**

```bash
ch4p message "What is the current date?"
```

**Output:** The agent's response printed to stdout.

```bash
ch4p message --tool file.read --input '{"path": "./README.md"}' --json
```

**Output:** JSON object with the tool result.

---

## ch4p canvas

Start the interactive canvas workspace. Opens a browser-based spatial canvas where the agent renders A2UI components (cards, charts, forms, tables, code blocks, etc.) and communicates via WebSocket.

```
ch4p canvas [flags]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--port` | `number` | from config | Override the canvas server port. |
| `--no-open` | `boolean` | `false` | Don't auto-open the browser. |

**Example:**

```bash
ch4p canvas                 # start canvas + open browser
ch4p canvas --port 4800     # custom port
ch4p canvas --no-open       # don't auto-open browser
```

**Output:**

```
  ch4p Canvas
  ────────────────────────────────────────────────────

  Server listening on 127.0.0.1:4800
  Session       a1b2c3d4e5f6g7h8
  Engine        native
  Static dir    /path/to/apps/web/dist

  Routes:
    WS     /ws/:sessionId       - WebSocket canvas connection
    GET    /health               - liveness probe
    GET    /*                    - static files (web UI)

  Canvas URL: http://127.0.0.1:4800/?session=a1b2c3d4e5f6g7h8

  Browser opened.
  Press Ctrl+C to stop.
```

The canvas provides:
- **11 A2UI component types** — card, chart, form, button, text field, data table, code block, markdown, image, progress, status
- **Bidirectional interaction** — click buttons, submit forms, drag components
- **Real-time streaming** — agent text responses stream into the chat panel as they generate
- **Spatial layout** — components are placed at (x, y) positions and can be connected with directional edges

---

## ch4p skills

Manage agent skills (curated instruction sets loaded on-demand).

```
ch4p skills [subcommand]
```

| Subcommand | Description |
|------------|-------------|
| (none) | List installed skills. |
| `show <name>` | Display full skill content. |
| `verify` | Validate all skill manifests. |

**Example:**

```bash
ch4p skills              # List installed skills
ch4p skills show <name>  # Display full skill content
ch4p skills verify       # Validate all manifests
```
