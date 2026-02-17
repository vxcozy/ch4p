/**
 * Tool registry — manages tool instances and provides LLM-ready definitions.
 *
 * The registry maps tool names to ITool instances, supports registration,
 * lookup, listing, and conversion to ToolDefinition[] for LLM consumption.
 * A factory method creates the default tool set with all built-in tools.
 */

import type { ITool, ToolDefinition } from '@ch4p/core';
import { ToolError } from '@ch4p/core';
import { BashTool } from './bash.js';
import { FileReadTool } from './file-read.js';
import { FileWriteTool } from './file-write.js';
import { FileEditTool } from './file-edit.js';
import { GrepTool } from './grep.js';
import { GlobTool } from './glob.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';
import { MemoryStoreTool } from './memory-store.js';
import { MemoryRecallTool } from './memory-recall.js';
import { DelegateTool } from './delegate.js';
import { BrowserTool } from './browser.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ITool>();

  /**
   * Register a tool. Throws if a tool with the same name is already registered.
   */
  register(tool: ITool): void {
    if (this.tools.has(tool.name)) {
      throw new ToolError(
        `Tool "${tool.name}" is already registered.`,
        tool.name,
      );
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Get a tool by name. Returns undefined if not found.
   */
  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check whether a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * List all registered tools.
   */
  list(): ITool[] {
    return Array.from(this.tools.values());
  }

  /**
   * List tool names.
   */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get tools filtered by weight classification.
   */
  byWeight(weight: 'lightweight' | 'heavyweight'): ITool[] {
    return this.list().filter((t) => t.weight === weight);
  }

  /**
   * Unregister a tool by name. Returns true if removed, false if not found.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Convert all registered tools to ToolDefinition[] for LLM consumption.
   * This is the format expected by provider stream/complete calls.
   */
  getToolDefinitions(filterNames?: string[]): ToolDefinition[] {
    const tools = filterNames
      ? this.list().filter((t) => filterNames.includes(t.name))
      : this.list();

    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    }));
  }

  /**
   * Get the count of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Create a registry with the default set of built-in tools.
   *
   * Options:
   * - exclude: tool names to exclude from the default set
   * - include: if provided, only these tools are included (overrides exclude)
   */
  static createDefault(opts?: {
    exclude?: string[];
    include?: string[];
  }): ToolRegistry {
    const registry = new ToolRegistry();
    const allTools: ITool[] = [
      new BashTool(),
      new FileReadTool(),
      new FileWriteTool(),
      new FileEditTool(),
      new GrepTool(),
      new GlobTool(),
      new WebFetchTool(),
      new WebSearchTool(),
      new MemoryStoreTool(),
      new MemoryRecallTool(),
      new DelegateTool(),
      new BrowserTool(),
    ];

    for (const tool of allTools) {
      if (opts?.include) {
        if (opts.include.includes(tool.name)) {
          registry.register(tool);
        }
      } else if (opts?.exclude) {
        if (!opts.exclude.includes(tool.name)) {
          registry.register(tool);
        }
      } else {
        registry.register(tool);
      }
    }

    return registry;
  }
}
