# How to Use Web Search

This guide explains how to configure and use the built-in web search tool backed by the Brave Search API.

---

## Prerequisites

- A [Brave Search API](https://brave.com/search/api/) key (free tier available)

---

## Step 1: Get a Brave Search API Key

1. Visit [brave.com/search/api](https://brave.com/search/api/)
2. Sign up for a free or paid plan
3. Copy your API key from the dashboard

---

## Step 2: Set the Environment Variable

```bash
export BRAVE_SEARCH_API_KEY=BSA_xxxxxxxxxxxxxxxxxxxxxxxx
```

Or add it to your `~/.ch4p/.env` file:

```
BRAVE_SEARCH_API_KEY=BSA_xxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Step 3: Enable in Config

Add a `search` section to `~/.ch4p/config.json`:

```json
{
  "search": {
    "enabled": true,
    "provider": "brave",
    "apiKey": "${BRAVE_SEARCH_API_KEY}",
    "maxResults": 5,
    "country": "US"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable the web search tool. |
| `provider` | `string` | `"brave"` | Search provider (only Brave is supported). |
| `apiKey` | `string` | `null` | API key (supports `${ENV_VAR}` syntax). |
| `maxResults` | `number` | `5` | Default results per query. |
| `country` | `string` | `null` | Country code for localized results. |
| `searchLang` | `string` | `null` | Search language code. |

---

## Step 4: Use It

Once enabled, the agent can use the `web_search` tool automatically when it needs current information. You can also ask explicitly:

```
> Search the web for the latest TypeScript release
```

The tool supports:
- **Freshness filters**: `pd` (past day), `pw` (past week), `pm` (past month), `py` (past year)
- **Pagination**: offset-based for fetching more results
- **Country/language filtering**

---

## Security Notes

- The web search tool only contacts the Brave Search API endpoint (`api.search.brave.com`)
- No user-controlled URLs are constructed
- The tool is disabled by default (security-first)
- API keys are never included in tool output or agent responses
