# How to Use the Browser Tool

This guide explains how to set up and use the Playwright-based browser tool for web automation.

---

## Prerequisites

- Node.js 18+
- `playwright-core` installed (optional dependency)

---

## Step 1: Install Playwright

```bash
# Install playwright-core (the lightweight version without bundled browsers)
corepack pnpm add -w playwright-core

# Install a browser (Chromium is recommended)
npx playwright install chromium
```

The browser tool uses `playwright-core` as an optional dependency. If it's not installed, the tool gracefully degrades and reports that browser capabilities are unavailable.

---

## Step 2: Use It

Once Playwright is installed, the agent can use the `browser` tool. Available actions:

| Action | Description |
|--------|-------------|
| `navigate` | Navigate to a URL |
| `click` | Click an element by CSS selector |
| `type` | Type text into an input field |
| `screenshot` | Take a screenshot of the page |
| `evaluate` | Execute JavaScript in the page context |
| `scroll` | Scroll the page |
| `get_text` | Extract text content from the page |

### Example Prompts

```
> Open https://example.com and take a screenshot
> Fill in the search box with "TypeScript" and click the search button
> Navigate to the docs page and extract all headings
```

---

## Security

The browser tool includes several security measures:

- **SSRF protection**: Private IP blocking, DNS resolution checks, and cloud metadata endpoint guards prevent the browser from accessing internal network resources
- **Shared SSRF guards**: The same `ssrf-guards.ts` module is used by both `web-fetch` and `browser` tools
- **No credential storage**: The browser tool does not store cookies or credentials between sessions

---

## Limitations

- The browser tool requires `playwright-core` to be installed; without it, the tool is unavailable
- Each browser session starts fresh (no persistent state)
- The tool operates in headless mode by default
