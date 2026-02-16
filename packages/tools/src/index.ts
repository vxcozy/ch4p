/**
 * @ch4p/tools — built-in tool implementations for ch4p.
 *
 * Provides the core tool set: filesystem operations, shell execution,
 * content search, web fetching, memory management, sub-agent delegation,
 * and MCP server connectivity. All tools implement the ITool interface
 * from @ch4p/core.
 */

// Individual tools
export { BashTool } from './bash.js';
export { FileReadTool } from './file-read.js';
export { FileWriteTool } from './file-write.js';
export { FileEditTool } from './file-edit.js';
export { GrepTool } from './grep.js';
export { GlobTool } from './glob.js';
export { WebFetchTool } from './web-fetch.js';
export { MemoryStoreTool } from './memory-store.js';
export { MemoryRecallTool } from './memory-recall.js';
export { DelegateTool } from './delegate.js';
export { McpClientTool } from './mcp-client.js';
export { LoadSkillTool } from './load-skill.js';

// Registry
export { ToolRegistry } from './registry.js';

// Snapshot utilities
export { captureFileState } from './snapshot-utils.js';

// Extended context types
export type { MemoryToolContext } from './memory-store.js';
export type { DelegateToolContext } from './delegate.js';
export type { McpServerConfig, McpTransport } from './mcp-client.js';
export type { SkillProvider } from './load-skill.js';
