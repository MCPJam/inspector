import type { Tool, OpenAIAction } from './types.js';

/**
 * Tool Registry - Manages tool registration and execution
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool with id "${tool.id}" is already registered`);
    }
    this.tools.set(tool.id, tool);
    console.log(`✓ Tool registered: ${tool.name} (${tool.id})`);
  }

  /**
   * Get a tool by ID
   */
  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  /**
   * Get all registered tools
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Check if a tool exists
   */
  has(id: string): boolean {
    return this.tools.has(id);
  }

  /**
   * Unregister a tool
   */
  unregister(id: string): void {
    const tool = this.tools.get(id);
    if (tool) {
      this.tools.delete(id);
      console.log(`✓ Tool unregistered: ${tool.name} (${id})`);
    }
  }

  /**
   * Execute a tool
   */
  async execute(id: string, params: Record<string, any>): Promise<any> {
    const tool = this.get(id);
    if (!tool) {
      throw new Error(`Tool with id "${id}" not found`);
    }
    return await tool.handler(params);
  }

  /**
   * Get OpenAI Actions format for registered tools
   */
  getOpenAIActions(): OpenAIAction[] {
    return this.getAll().map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.id,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
}

