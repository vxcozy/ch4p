# How to Use MCP (Model Context Protocol)

This guide explains how to connect your ch4p agent to external MCP servers to discover and use their tools.

---

## Prerequisites

- A running MCP server (any implementation that follows the [Model Context Protocol](https://modelcontextprotocol.io/) specification)

---

## Overview

The built-in MCP client tool connects to any Model Context Protocol server, discovering and proxying its tools via `list_tools` + `call_tool`. This lets your agent use tools provided by external services without any code changes.

---

## Step 1: Start an MCP Server

MCP servers can be any process that implements the MCP specification. For example:

```bash
# Example: Start a filesystem MCP server
npx @modelcontextprotocol/server-filesystem /path/to/directory

# Example: Start a database MCP server
npx @modelcontextprotocol/server-sqlite mydb.sqlite
```

---

## Step 2: Configure the MCP Connection

The agent can connect to MCP servers via the `mcp_connect` tool. Simply ask the agent to connect:

```
> Connect to the MCP server at stdio://npx @modelcontextprotocol/server-filesystem /tmp
```

Or configure it in your agent's system prompt or skill file.

---

## Step 3: Use MCP Tools

Once connected, the agent can:

1. **Discover tools**: List all available tools from the MCP server
2. **Call tools**: Execute any tool provided by the MCP server
3. **Proxy results**: Tool results are returned to the agent as if they were native tools

The agent treats MCP tools the same as built-in tools. They go through the same validation and verification pipeline.

---

## How It Works

1. The MCP client tool establishes a connection to the MCP server
2. It calls `list_tools` to discover available tools and their schemas
3. When the agent needs an MCP tool, it calls `call_tool` with the tool name and arguments
4. Results are returned through the standard tool result pipeline

---

## Security Notes

- MCP tool calls go through the same security policy as built-in tools
- SSRF protections apply to any network requests made by MCP tools
- The agent's autonomy level controls what MCP tools can do without confirmation
