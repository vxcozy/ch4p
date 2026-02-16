# Reference: Security Subsystem

Complete reference for ch4p's security subsystem. This covers every defense mechanism, its behavior, and its configuration.

---

## Filesystem Scoping

Restricts agent file access to declared paths.

### Path Resolution

All paths are resolved to absolute form before evaluation. The resolution order is:

1. Expand `~` to the user's home directory.
2. Resolve `.` and `..` segments.
3. Resolve symlinks (if `followSymlinks` is `true`).
4. Compare the resolved path against `allowedPaths` and `blockedPaths`.

### Evaluation Rules

| Condition | Result |
|-----------|--------|
| Path is under an entry in `blockedPaths` | **BLOCKED** |
| Path is under an entry in `allowedPaths` | **ALLOWED** |
| Path is not under any entry in `allowedPaths` | **BLOCKED** |
| `filesystem.enabled` is `false` | **ALLOWED** (all paths) |

`blockedPaths` always takes precedence over `allowedPaths`.

### Default Blocked Paths

```
~/.ssh
~/.gnupg
~/.ch4p/config.json
~/.aws
~/.env
/etc/shadow
/etc/passwd
/etc/sudoers
```

---

## Symlink Detection

When `followSymlinks` is `false` (the default), ch4p detects and blocks symlinks that resolve to paths outside the allowed scope.

### Detection Method

1. Call `lstat()` on the target path.
2. If the path is a symbolic link, call `readlink()` to get the real target.
3. Resolve the real target to an absolute path.
4. Evaluate the resolved target against `allowedPaths` and `blockedPaths`.
5. If the resolved target is blocked or outside allowed paths, reject the operation.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Symlink within allowed scope pointing to allowed scope | Allowed |
| Symlink within allowed scope pointing outside | Blocked |
| Symlink chain (link to link) | Fully resolved before evaluation |
| Broken symlink | Blocked (cannot verify target) |
| Symlink in a parent directory of the path | Each component checked |

---

## Null Byte Guards

Null bytes (`\0`) in file paths are a common injection vector. ch4p strips or rejects them.

### Behavior

When `inputValidation.stripNullBytes` is `true`:

1. All incoming file paths are scanned for `\0` characters.
2. If found, the null byte and everything after it are removed.
3. The sanitized path is then re-evaluated by filesystem scoping.
4. An audit log entry is created noting the null byte removal.

When `inputValidation.stripNullBytes` is `false`:

1. Paths containing `\0` are rejected entirely.
2. The tool returns an error: `"Path contains null bytes"`.

---

## Output Sanitization

Scans agent output for sensitive patterns before delivery to any channel.

### Default Patterns

| Pattern | Replacement | Matches |
|---------|-------------|---------|
| `sk-[a-zA-Z0-9]{20,}` | `[REDACTED_API_KEY]` | Anthropic, Stripe-style API keys |
| `ghp_[a-zA-Z0-9]{36}` | `[REDACTED_TOKEN]` | GitHub personal access tokens |
| `gho_[a-zA-Z0-9]{36}` | `[REDACTED_TOKEN]` | GitHub OAuth tokens |
| `xoxb-[a-zA-Z0-9-]+` | `[REDACTED_TOKEN]` | Slack bot tokens |
| `xoxp-[a-zA-Z0-9-]+` | `[REDACTED_TOKEN]` | Slack user tokens |
| `AKIA[0-9A-Z]{16}` | `[REDACTED_AWS_KEY]` | AWS access key IDs |
| `-----BEGIN.*PRIVATE KEY-----` | `[REDACTED_PRIVATE_KEY]` | PEM private keys |
| `\b\d{3}-\d{2}-\d{4}\b` | `[REDACTED_SSN]` | US Social Security Numbers |
| `\d{8,10}:[A-Za-z0-9_-]{35,}` | `[REDACTED_TELEGRAM_TOKEN]` | Telegram bot tokens |
| `[\w-]{24}\.[\w-]{6}\.[\w-]{27,}` | `[REDACTED_DISCORD_TOKEN]` | Discord bot tokens |
| `(sk\|pk\|rk)_live_[A-Za-z0-9]{20,}` | `[REDACTED_STRIPE_KEY]` | Stripe live API keys |
| `SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{20,}` | `[REDACTED_SENDGRID_KEY]` | SendGrid API keys |
| `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` | `[REDACTED_JWT]` | JSON Web Tokens |
| `(postgres\|mysql\|mongodb(\+srv)?\|redis)://[^\s]+` | `[REDACTED_DB_URL]` | Database connection strings |
| `np_[a-zA-Z0-9]{36,}` | `[REDACTED_TOKEN]` | npm publish tokens |

### Processing Order

1. Apply all regex patterns in order (default patterns first, then custom).
2. Each pattern is applied globally (all occurrences).
3. Sanitized text is passed to the channel for delivery.
4. Original (unsanitized) text is never stored or logged.

### Custom Patterns

Custom patterns are defined in `security.sanitization.patterns`:

```json
{
  "regex": "MY_SECRET_[A-Z0-9]+",
  "replacement": "[REDACTED_MY_SECRET]"
}
```

Each pattern object requires:

| Field | Type | Description |
|-------|------|-------------|
| `regex` | `string` | Regular expression (without delimiters). |
| `replacement` | `string` | Replacement text. |

---

## Input Validation

Validates and sanitizes all incoming messages before processing.

### Validation Layers

Applied in order:

| Layer | Field | Behavior |
|-------|-------|----------|
| Length check | `maxMessageLength` | Rejects messages exceeding the limit. |
| Null byte strip | `stripNullBytes` | Removes `\0` characters. |
| Control char strip | `stripControlChars` | Removes ASCII 0x00-0x1F except `\n`, `\r`, `\t`. |
| Pattern rejection | `rejectPatterns` | Rejects messages containing any listed string (case-insensitive). |

### Rejection Behavior

When a message is rejected:

1. The agent does not process it.
2. The channel receives a generic rejection: `"Message could not be processed."`.
3. An audit entry is logged with the rejection reason (but not the full message content).

---

## Command Execution Controls

Governs which shell commands the agent can execute.

### Allowlist Mode

Only commands whose binary name matches an entry in `commands.allowed` can execute.

```
Evaluation: extract binary name -> check against allowed list -> allow or reject
```

### Blocklist Mode

All commands can execute except those matching entries in `commands.blocked`.

```
Evaluation: extract binary name -> check against blocked list -> allow or reject
```

### Command Parsing

The binary name is extracted by:

1. Splitting the command string on whitespace.
2. Taking the first token.
3. Resolving to a basename (stripping path prefixes).

For piped commands (`a | b`), each segment is evaluated independently. All segments must pass.

### Timeout Enforcement

Commands are killed after `maxExecutionTime` milliseconds. The tool receives:

```json
{
  "success": false,
  "error": "Command timed out after 30000ms"
}
```

---

## SSRF Protection

The `web_fetch` tool includes Server-Side Request Forgery (SSRF) guards to prevent the agent from accessing internal network resources.

### Blocked IP Ranges

| Range | Description |
|-------|-------------|
| `127.0.0.0/8` | Loopback (localhost) |
| `10.0.0.0/8` | Private network |
| `172.16.0.0/12` | Private network |
| `192.168.0.0/16` | Private network |
| `169.254.0.0/16` | Link-local (includes AWS/GCP/Azure metadata at `169.254.169.254`) |
| `0.0.0.0` | Unspecified address |
| `100.64.0.0/10` | Shared address space (CGN) |
| `224.0.0.0/4` | Multicast |
| `240.0.0.0/4` | Reserved |

### Blocked Hostnames

- `localhost` — loopback hostname
- `metadata.google.internal` — GCP metadata endpoint
- `metadata.internal` — generic cloud metadata

### DNS Resolution Check

Even if a hostname appears public, the tool resolves it via DNS before fetching and blocks the request if the resolved IP falls in a private range. This prevents DNS rebinding attacks where a public hostname resolves to an internal IP.

### Redirect Validation

HTTP redirects are followed manually (up to 5 hops). Each redirect target is validated against the same SSRF rules before following. This prevents open-redirect attacks that bounce through a public URL to an internal one.

---

## Secure File Permissions

JSONL transcript files and log directories are created with restricted permissions to prevent other system users from reading agent session data.

| Resource | Permission | Description |
|----------|------------|-------------|
| Log directories | `0o700` | Owner read/write/execute only |
| JSONL transcript files | `0o600` | Owner read/write only |

Permissions are enforced in the `FileObserver` on directory creation (`ensureDir`), file writes (`flushSync`), and log rotation (`rotateIfNeeded`).

---

## Pairing Token Expiration

Authentication tokens issued during the gateway pairing flow have a configurable time-to-live (default: 30 days). Expired tokens are automatically evicted during validation.

| Setting | Default | Description |
|---------|---------|-------------|
| `tokenTtlMs` | 30 days | Token lifetime in milliseconds |

The `PairingManager` stores an `expiresAt` timestamp with each paired client. On `validateToken()`, if the token is expired, it is removed from the store and the request is rejected.

---

## Audit Checklist

The `ch4p audit` command evaluates these items:

| # | Check | Severity |
|---|-------|----------|
| 1 | Filesystem scoping enabled | FAIL if disabled |
| 2 | `blockedPaths` includes `~/.ssh` | FAIL if missing |
| 3 | `blockedPaths` includes `~/.gnupg` | FAIL if missing |
| 4 | `blockedPaths` includes `~/.env` | FAIL if missing |
| 5 | `blockedPaths` includes config file | FAIL if missing |
| 6 | Symlink following disabled | WARN if enabled |
| 7 | Command controls enabled | FAIL if disabled |
| 8 | Command mode is `allowlist` | WARN if `blocklist` |
| 9 | `sudo` is not in allowed commands | FAIL if present |
| 10 | `rm -rf` is not in allowed commands | FAIL if present |
| 11 | Output sanitization enabled | WARN if disabled |
| 12 | At least 1 sanitization pattern defined | WARN if none |
| 13 | Input validation enabled | WARN if disabled |
| 14 | Null byte stripping enabled | FAIL if disabled |
| 15 | Autonomy level is not `autonomous` | WARN if autonomous |
| 16 | Config file permissions are 600 | WARN if more open |
| 17 | Memory database permissions are 600 | WARN if more open |
| 18 | No API keys in environment variables | WARN if found |
| 19 | Max execution time is 60s or less | WARN if higher |
| 20 | `allowedUsers` set for each channel | WARN if empty |
