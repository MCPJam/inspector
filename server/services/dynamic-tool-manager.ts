import { z } from "zod";
import { dynamicTool } from "ai";

export interface DynamicToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, any>; // JSON Schema
  executionType: 'http' | 'javascript';
  implementation: {
    url?: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    code?: string;
  };
}

export class DynamicToolManager {
  private dynamicTools: Map<string, DynamicToolDefinition> = new Map();

  // Create a dynamic tool from definition
  createDynamicTool(definition: DynamicToolDefinition) {
    return dynamicTool({
      description: definition.description,
      inputSchema: z.object({}), // We'll enhance this later
      execute: async (input) => {
        switch (definition.executionType) {
          case 'http':
            return await this.executeHttpTool(definition, input);
          case 'javascript':
            return await this.executeJavaScriptTool(definition, input);
          default:
            throw new Error(`Unsupported execution type: ${definition.executionType}`);
        }
      }
    });
  }

  // Execute HTTP-based tool (simplest to implement)
  async executeHttpTool(definition: DynamicToolDefinition, input: any) {
    const { url, method = 'POST', headers = {} } = definition.implementation;
    
    if (!url) throw new Error('HTTP tool requires URL');

    try {
      console.log(`[DynamicTool] Executing HTTP tool: ${definition.name}`, { url, method, input });
      
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MCPJam-Inspector/1.0',
          ...headers
        },
        body: method !== 'GET' ? JSON.stringify(input) : undefined
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      console.log(`[DynamicTool] HTTP tool success:`, { tool: definition.name, result });
      return result;
    } catch (error) {
      console.error(`[DynamicTool] HTTP tool failed:`, { tool: definition.name, error });
      throw new Error(`HTTP request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Execute JavaScript-based tool (for later)
  private async executeJavaScriptTool(_definition: DynamicToolDefinition, _input: any) {
    // TODO: Implement sandboxed JavaScript execution
    throw new Error('JavaScript tools not yet implemented');
  }

  // Tool management
  registerTool(definition: DynamicToolDefinition) {
    this.dynamicTools.set(definition.id, definition);
  }

  getTool(id: string): DynamicToolDefinition | undefined {
    return this.dynamicTools.get(id);
  }

  getAllTools(): DynamicToolDefinition[] {
    return Array.from(this.dynamicTools.values());
  }

  deleteTool(id: string): boolean {
    return this.dynamicTools.delete(id);
  }
}
