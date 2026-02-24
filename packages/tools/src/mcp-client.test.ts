import { vi } from 'vitest';
import { McpClientTool } from './mcp-client.js';
import type { McpServerConfig, McpTransport } from './mcp-client.js';
import type { ToolContext, ISecurityPolicy } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    sessionId: 'test-session',
    cwd: '/tmp',
    securityPolicy: null as unknown as ISecurityPolicy,
    abortSignal: new AbortController().signal,
    onProgress: vi.fn(),
    ...overrides,
  };
}

const sseConfig: McpServerConfig = {
  transport: 'sse',
  url: 'http://localhost:3001/mcp',
  timeout: 5000,
};

const stdioConfig: McpServerConfig = {
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
};

/**
 * Sets up globalThis.fetch to return sequential JSON-RPC responses.
 * Each entry in `responses` corresponds to one fetch call in order.
 */
function mockFetchForSSE(
  responses: Array<{ result?: unknown; error?: { code: number; message: string } }>,
) {
  let callIndex = 0;
  globalThis.fetch = vi.fn().mockImplementation(async () => {
    const responseData = responses[callIndex++] ?? { result: {} };
    return {
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: Date.now(),
        ...responseData,
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Restore after each test
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Validation
// ---------------------------------------------------------------------------

describe('McpClientTool.validate', () => {
  const tool = new McpClientTool(sseConfig);

  it('accepts { action: "list_tools" }', () => {
    const result = tool.validate({ action: 'list_tools' });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('accepts { action: "call_tool", tool: "my_tool" }', () => {
    const result = tool.validate({ action: 'call_tool', tool: 'my_tool' });
    expect(result.valid).toBe(true);
  });

  it('accepts { action: "call_tool", tool: "my_tool", args: { x: 1 } }', () => {
    const result = tool.validate({ action: 'call_tool', tool: 'my_tool', args: { x: 1 } });
    expect(result.valid).toBe(true);
  });

  it('rejects a non-object argument (string)', () => {
    const result = tool.validate('not an object');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Arguments must be an object.');
  });

  it('rejects an invalid action', () => {
    const result = tool.validate({ action: 'invalid' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('action must be "list_tools" or "call_tool".');
  });

  it('rejects call_tool without a tool name', () => {
    const result = tool.validate({ action: 'call_tool' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('tool must be a non-empty string when action is "call_tool".');
  });

  it('rejects call_tool with an empty tool name', () => {
    const result = tool.validate({ action: 'call_tool', tool: '' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('tool must be a non-empty string when action is "call_tool".');
  });

  it('rejects args that are not an object (string)', () => {
    const result = tool.validate({ action: 'call_tool', tool: 'x', args: 'string' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('args must be an object.');
  });

  it('rejects null', () => {
    const result = tool.validate(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Arguments must be an object.');
  });

  it('rejects an empty object (missing action)', () => {
    const result = tool.validate({});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('action must be "list_tools" or "call_tool".');
  });
});

// ---------------------------------------------------------------------------
// 2. Constructor
// ---------------------------------------------------------------------------

describe('McpClientTool constructor', () => {
  it('creates with stdio config', () => {
    const tool = new McpClientTool(stdioConfig);
    expect(tool).toBeInstanceOf(McpClientTool);
  });

  it('creates with sse config', () => {
    const tool = new McpClientTool(sseConfig);
    expect(tool).toBeInstanceOf(McpClientTool);
  });

  it('SSE transport throws when url is not provided on connect', async () => {
    const badConfig: McpServerConfig = { transport: 'sse' };
    // The error is thrown when the connection is created (inside execute),
    // because SseConnection constructor validates config.url.
    const tool = new McpClientTool(badConfig);
    const ctx = createToolContext();
    const result = await tool.execute({ action: 'list_tools' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires a url/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Properties
// ---------------------------------------------------------------------------

describe('McpClientTool properties', () => {
  const tool = new McpClientTool(sseConfig);

  it('has name "mcp_client"', () => {
    expect(tool.name).toBe('mcp_client');
  });

  it('has weight "heavyweight"', () => {
    expect(tool.weight).toBe('heavyweight');
  });

  it('has a non-empty description', () => {
    expect(tool.description).toBeDefined();
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('has a parameters schema defined', () => {
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties).toBeDefined();
    expect((tool.parameters.properties as Record<string, unknown>).action).toBeDefined();
    expect((tool.parameters.properties as Record<string, unknown>).tool).toBeDefined();
    expect((tool.parameters.properties as Record<string, unknown>).args).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. getCachedToolDefinitions
// ---------------------------------------------------------------------------

describe('McpClientTool.getCachedToolDefinitions', () => {
  it('returns empty array initially', () => {
    const tool = new McpClientTool(sseConfig);
    expect(tool.getCachedToolDefinitions()).toEqual([]);
  });

  it('returns mapped tool defs with "mcp:" prefix after list_tools', async () => {
    const tool = new McpClientTool(sseConfig);

    mockFetchForSSE([
      // 1. initialize
      { result: {} },
      // 2. notifications/initialized
      { result: {} },
      // 3. tools/list
      {
        result: {
          tools: [
            { name: 'calculator', description: 'Does math', inputSchema: { type: 'object' } },
            { name: 'translator', description: 'Translates text' },
          ],
        },
      },
    ]);

    const ctx = createToolContext();
    await tool.execute({ action: 'list_tools' }, ctx);

    const defs = tool.getCachedToolDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs[0].name).toBe('mcp:calculator');
    expect(defs[0].description).toBe('Does math');
    expect(defs[0].parameters).toEqual({ type: 'object' });
    expect(defs[1].name).toBe('mcp:translator');
    expect(defs[1].description).toBe('Translates text');
    expect(defs[1].parameters).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 5. abort
// ---------------------------------------------------------------------------

describe('McpClientTool.abort', () => {
  it('disconnects and nullifies the connection', async () => {
    const tool = new McpClientTool(sseConfig);

    // Establish a connection first
    mockFetchForSSE([{ result: {} }, { result: {} }, { result: { tools: [] } }]);
    const ctx = createToolContext();
    await tool.execute({ action: 'list_tools' }, ctx);

    // Abort should not throw
    expect(() => tool.abort('test abort')).not.toThrow();

    // After abort, a new execute should re-establish the connection (new fetch calls)
    vi.restoreAllMocks();
    mockFetchForSSE([{ result: {} }, { result: {} }, { result: { tools: [] } }]);
    const result = await tool.execute({ action: 'list_tools' }, createToolContext());
    expect(result.success).toBe(true);
    // initialize should have been called again (proves connection was nullified)
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. disconnect
// ---------------------------------------------------------------------------

describe('McpClientTool.disconnect', () => {
  it('clears connection and cached tools', async () => {
    const tool = new McpClientTool(sseConfig);

    // Establish connection and populate cache
    mockFetchForSSE([
      { result: {} },
      { result: {} },
      {
        result: {
          tools: [{ name: 'calc', description: 'Does math' }],
        },
      },
    ]);
    const ctx = createToolContext();
    await tool.execute({ action: 'list_tools' }, ctx);
    expect(tool.getCachedToolDefinitions()).toHaveLength(1);

    // Disconnect
    await tool.disconnect();

    // Cached tools should be empty
    expect(tool.getCachedToolDefinitions()).toEqual([]);

    // Next execute should reconnect (new fetch calls)
    vi.restoreAllMocks();
    mockFetchForSSE([{ result: {} }, { result: {} }, { result: { tools: [] } }]);
    const result = await tool.execute({ action: 'list_tools' }, createToolContext());
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. execute - list_tools via SSE
// ---------------------------------------------------------------------------

describe('McpClientTool.execute - list_tools via SSE', () => {
  it('connects, initializes, then returns the tool list as JSON', async () => {
    const tool = new McpClientTool(sseConfig);

    mockFetchForSSE([
      // 1. initialize
      { result: {} },
      // 2. notifications/initialized
      { result: {} },
      // 3. tools/list
      {
        result: {
          tools: [
            { name: 'calculator', description: 'Does math' },
          ],
        },
      },
    ]);

    const ctx = createToolContext();
    const result = await tool.execute({ action: 'list_tools' }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('calculator');
    expect(result.output).toContain('Does math');

    const parsed = JSON.parse(result.output);
    expect(parsed).toEqual([
      { name: 'calculator', description: 'Does math' },
    ]);

    expect(result.metadata).toEqual({
      toolCount: 1,
      tools: ['calculator'],
    });

    // Verify fetch was called 3 times (init, notification, tools/list)
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 8. execute - call_tool via SSE
// ---------------------------------------------------------------------------

describe('McpClientTool.execute - call_tool via SSE', () => {
  it('calls the remote tool and returns text content', async () => {
    const tool = new McpClientTool(sseConfig);

    mockFetchForSSE([
      // 1. initialize
      { result: {} },
      // 2. notifications/initialized
      { result: {} },
      // 3. tools/call
      {
        result: {
          content: [{ type: 'text', text: 'Result: 42' }],
        },
      },
    ]);

    const ctx = createToolContext();
    const result = await tool.execute(
      { action: 'call_tool', tool: 'calculator', args: { expression: '6*7' } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('Result: 42');
    expect(result.metadata).toEqual({
      mcpTool: 'calculator',
      contentBlocks: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// 9. execute - call_tool error from MCP server
// ---------------------------------------------------------------------------

describe('McpClientTool.execute - call_tool error from MCP server', () => {
  it('returns error when the MCP tool responds with isError: true', async () => {
    const tool = new McpClientTool(sseConfig);

    mockFetchForSSE([
      // 1. initialize
      { result: {} },
      // 2. notifications/initialized
      { result: {} },
      // 3. tools/call with isError
      {
        result: {
          content: [{ type: 'text', text: 'Error occurred' }],
          isError: true,
        },
      },
    ]);

    const ctx = createToolContext();
    const result = await tool.execute(
      { action: 'call_tool', tool: 'bad_tool', args: {} },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.output).toBe('Error occurred');
    expect(result.error).toBe('Error occurred');
    expect(result.metadata).toEqual({
      mcpTool: 'bad_tool',
      contentBlocks: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// 10. execute - connection failure
// ---------------------------------------------------------------------------

describe('McpClientTool.execute - connection failure', () => {
  it('returns error when fetch throws on first call', async () => {
    const tool = new McpClientTool(sseConfig);

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network unreachable'));

    const ctx = createToolContext();
    const result = await tool.execute({ action: 'list_tools' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to connect to MCP server/);
    expect(result.error).toMatch(/Network unreachable/);
  });
});

// ---------------------------------------------------------------------------
// 11. execute - aborted signal
// ---------------------------------------------------------------------------

describe('McpClientTool.execute - aborted signal', () => {
  it('returns error immediately when signal is already aborted', async () => {
    const tool = new McpClientTool(sseConfig);

    // Mock fetch so connection succeeds
    mockFetchForSSE([{ result: {} }, { result: {} }]);

    const abortController = new AbortController();
    abortController.abort();

    const ctx = createToolContext({
      abortSignal: abortController.signal,
    });

    const result = await tool.execute({ action: 'list_tools' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Request aborted.');
  });
});

// ---------------------------------------------------------------------------
// 12. execute - reuses existing connection
// ---------------------------------------------------------------------------

describe('McpClientTool.execute - reuses existing connection', () => {
  it('does not re-initialize when called a second time', async () => {
    const tool = new McpClientTool(sseConfig);

    mockFetchForSSE([
      // First execute: init + notification + tools/list
      { result: {} },
      { result: {} },
      { result: { tools: [{ name: 'a', description: 'A' }] } },
      // Second execute: only tools/list (no re-init)
      { result: { tools: [{ name: 'b', description: 'B' }] } },
    ]);

    const ctx = createToolContext();

    const result1 = await tool.execute({ action: 'list_tools' }, ctx);
    expect(result1.success).toBe(true);

    const result2 = await tool.execute({ action: 'list_tools' }, createToolContext());
    expect(result2.success).toBe(true);

    // Total fetch calls: 3 (init, notification, first list) + 1 (second list) = 4
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);

    // The second result should reflect the second mock response
    const parsed = JSON.parse(result2.output);
    expect(parsed).toEqual([{ name: 'b', description: 'B' }]);
  });
});
