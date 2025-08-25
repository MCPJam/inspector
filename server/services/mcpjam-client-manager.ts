import { MCPClient, MastraMCPServerDefinition } from "@mastra/mcp";
import {
  validateServerConfig,
  normalizeServerConfigName,
} from "../utils/mcp-utils";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: any;
  outputSchema?: any;
  serverId: string;
}

export interface DiscoveredResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverId: string;
}

export interface DiscoveredPrompt {
  name: string;
  description?: string;
  arguments?: Record<string, any>;
  serverId: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatResponse {
  text?: string;
  toolCalls?: any[];
  toolResults?: any[];
}

export interface ToolResult {
  result: any;
}

export interface ElicitationRequest {
  message: string;
  requestedSchema: any;
}

export interface ElicitationResponse {
  [key: string]: unknown;
  action: "accept" | "decline" | "cancel";
  content?: any;
  _meta?: any;
}

export interface ResourceContent {
  contents: any[];
}

export interface PromptResult {
  content: any;
}

function normalizeServerId(serverId: string) {
  return serverId
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

class MCPJamClientManager {
  private mcpClients: Map<string, MCPClient> = new Map();
  private statuses: Map<string, ConnectionStatus> = new Map();
  private configs: Map<string, MastraMCPServerDefinition> = new Map();

  private toolRegistry: Map<string, DiscoveredTool> = new Map();
  private resourceRegistry: Map<string, DiscoveredResource> = new Map();
  private promptRegistry: Map<string, DiscoveredPrompt> = new Map();

  // Store for pending elicitation requests with Promise resolvers
  private pendingElicitations: Map<
    string,
    {
      resolve: (response: ElicitationResponse) => void;
      reject: (error: any) => void;
    }
  > = new Map();

  // Optional callback for handling elicitation requests
  private elicitationCallback?: (request: {
    requestId: string;
    message: string;
    schema: any;
  }) => Promise<ElicitationResponse>;

  async connectToServer(serverId: string, serverConfig: any): Promise<void> {
    const id = normalizeServerId(serverId);

    // Check if already connected
    if (this.mcpClients.has(id)) return;

    // Validate server configuration
    const validation = validateServerConfig(serverConfig);
    if (!validation.success) {
      this.statuses.set(id, "error");
      throw new Error(validation.error!.message);
    }

    this.configs.set(id, validation.config!);
    this.statuses.set(id, "connecting");

    const client = new MCPClient({
      id: `mcpjam-${id}`,
      servers: { [id]: validation.config! },
    });

    try {
      // touch the server to verify connection
      await client.getTools();
      this.mcpClients.set(id, client);
      this.statuses.set(id, "connected");

      // Register elicitation handler for this server
      if (client.elicitation?.onRequest) {
        const normalizedName = normalizeServerConfigName(serverId);
        client.elicitation.onRequest(
          normalizedName,
          async (elicitationRequest: ElicitationRequest) => {
            return await this.handleElicitationRequest(elicitationRequest);
          },
        );
      }

      await this.discoverServerResources(id);
    } catch (err) {
      this.statuses.set(id, "error");
      try {
        await client.disconnect();
      } catch {}
      this.mcpClients.delete(id);
      throw err;
    }
  }

  async disconnectFromServer(serverId: string): Promise<void> {
    const id = normalizeServerId(serverId);
    const client = this.mcpClients.get(id);
    if (client) {
      try {
        await client.disconnect();
      } catch {}
    }
    this.mcpClients.delete(id);
    this.statuses.set(id, "disconnected");
    // purge registries for this server
    for (const key of Array.from(this.toolRegistry.keys())) {
      const item = this.toolRegistry.get(key)!;
      if (item.serverId === id) this.toolRegistry.delete(key);
    }
    for (const key of Array.from(this.resourceRegistry.keys())) {
      const item = this.resourceRegistry.get(key)!;
      if (item.serverId === id) this.resourceRegistry.delete(key);
    }
    for (const key of Array.from(this.promptRegistry.keys())) {
      const item = this.promptRegistry.get(key)!;
      if (item.serverId === id) this.promptRegistry.delete(key);
    }
  }

  getConnectionStatus(serverId: string): ConnectionStatus {
    const id = normalizeServerId(serverId);
    return this.statuses.get(id) || "disconnected";
  }

  getConnectedServers(): Record<
    string,
    { status: ConnectionStatus; config?: any }
  > {
    const servers: Record<string, { status: ConnectionStatus; config?: any }> =
      {};

    for (const [serverId, status] of this.statuses.entries()) {
      servers[serverId] = {
        status,
        config: this.configs.get(serverId),
      };
    }

    return servers;
  }

  async discoverAllResources(): Promise<void> {
    const serverIds = Array.from(this.mcpClients.keys());
    await Promise.all(serverIds.map((id) => this.discoverServerResources(id)));
  }

  private async discoverServerResources(serverId: string): Promise<void> {
    const id = normalizeServerId(serverId);
    const client = this.mcpClients.get(id);
    if (!client) return;

    // Tools
    const tools = await client.getTools();
    for (const [name, tool] of Object.entries<any>(tools)) {
      this.toolRegistry.set(`${id}:${name}`, {
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: (tool as any).outputSchema,
        serverId: id,
      });
    }

    // Resources
    try {
      const res = await client.resources.list();
      for (const [group, list] of Object.entries<any>(res)) {
        for (const r of list as any[]) {
          this.resourceRegistry.set(`${id}:${r.uri}`, {
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
            serverId: id,
          });
        }
      }
    } catch {}

    // Prompts
    try {
      const prompts = await client.prompts.list();
      for (const [group, list] of Object.entries<any>(prompts)) {
        for (const p of list as any[]) {
          this.promptRegistry.set(`${id}:${p.name}`, {
            name: p.name,
            description: p.description,
            arguments: p.arguments,
            serverId: id,
          });
        }
      }
    } catch {}
  }

  getAvailableTools(): DiscoveredTool[] {
    return Array.from(this.toolRegistry.values());
  }

  async getToolsetsForServer(serverId: string): Promise<Record<string, any>> {
    const id = normalizeServerId(serverId);
    const client = this.mcpClients.get(id);
    if (!client) {
      throw new Error(`No MCP client available for server: ${serverId}`);
    }

    // Get toolsets like in the chat route - this gives us server-prefixed tools
    const toolsets = await client.getToolsets();

    // Flatten toolsets to get un-prefixed tool names like in chat route
    const flattenedTools: Record<string, any> = {};
    Object.values(toolsets).forEach((serverTools: any) => {
      Object.assign(flattenedTools, serverTools);
    });

    return flattenedTools;
  }
  getAvailableResources(): DiscoveredResource[] {
    return Array.from(this.resourceRegistry.values());
  }
  getAvailablePrompts(): DiscoveredPrompt[] {
    return Array.from(this.promptRegistry.values());
  }

  async executeToolDirect(
    toolName: string,
    parameters: Record<string, any>,
  ): Promise<ToolResult> {
    // toolName may include server prefix "serverId:tool"
    let serverId = "";
    let name = toolName;

    if (toolName.includes(":")) {
      const [sid, n] = toolName.split(":", 2);
      serverId = normalizeServerId(sid);
      name = n;
    } else {
      // Find which server has this tool by checking un-prefixed name
      for (const [key, tool] of this.toolRegistry.entries()) {
        if (tool.name === toolName) {
          serverId = tool.serverId;
          name = toolName;
          break;
        }
      }
    }

    // If not found in registry, try to find it using toolsets from all connected servers
    if (!serverId) {
      for (const [clientServerId, client] of this.mcpClients.entries()) {
        try {
          const toolsets = await client.getToolsets();
          // Flatten toolsets to check for the tool
          const flattenedTools: Record<string, any> = {};
          Object.values(toolsets).forEach((serverTools: any) => {
            Object.assign(flattenedTools, serverTools);
          });

          if (flattenedTools[toolName]) {
            serverId = clientServerId;
            name = toolName;
            break;
          }
        } catch {
          // Continue to next server if this one fails
        }
      }
    }

    if (!serverId) {
      throw new Error(`Tool not found in any connected server: ${toolName}`);
    }

    const client = this.mcpClients.get(serverId);
    if (!client)
      throw new Error(`No MCP client available for server: ${serverId}`);

    // Use toolsets to get the actual tool (since tools might be prefixed in getTools())
    const toolsets = await client.getToolsets();
    const flattenedTools: Record<string, any> = {};
    Object.values(toolsets).forEach((serverTools: any) => {
      Object.assign(flattenedTools, serverTools);
    });

    const tool = flattenedTools[name];
    if (!tool)
      throw new Error(`Tool '${name}' not found in server '${serverId}'`);

    const result = await tool.execute({ context: parameters || {} });
    return { result };
  }

  async getResource(resourceUri: string): Promise<ResourceContent> {
    // resourceUri may include server prefix
    let serverId = "";
    let uri = resourceUri;
    if (resourceUri.includes(":")) {
      const [sid, rest] = resourceUri.split(":", 2);
      serverId = normalizeServerId(sid);
      uri = rest;
    }
    const client = serverId
      ? this.mcpClients.get(serverId)
      : this.pickAnyClient();
    if (!client) throw new Error("No MCP client available");
    const content = await client.resources.read(serverId, uri);
    return { contents: content?.contents || [] };
  }

  async getPrompt(
    promptName: string,
    args?: Record<string, any>,
  ): Promise<PromptResult> {
    let serverId = "";
    let name = promptName;
    if (promptName.includes(":")) {
      const [sid, rest] = promptName.split(":", 2);
      serverId = normalizeServerId(sid);
      name = rest;
    }
    const client = serverId
      ? this.mcpClients.get(serverId)
      : this.pickAnyClient();
    if (!client) throw new Error("No MCP client available");
    const content = await client.prompts.get({
      serverName: serverId,
      name,
      args: args || {},
    });
    return { content };
  }

  private pickAnyClient(): MCPClient | undefined {
    for (const c of this.mcpClients.values()) return c;
    return undefined;
  }

  /**
   * Handles elicitation requests from MCP servers during direct tool execution
   */
  private async handleElicitationRequest(
    elicitationRequest: ElicitationRequest,
  ): Promise<ElicitationResponse> {
    const requestId = `elicit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Create a promise that will be resolved when the user responds
    return new Promise<ElicitationResponse>((resolve, reject) => {
      this.pendingElicitations.set(requestId, { resolve, reject });

      // If there's an active elicitation callback, use it
      if (this.elicitationCallback) {
        this.elicitationCallback({
          requestId,
          message: elicitationRequest.message,
          schema: elicitationRequest.requestedSchema,
        })
          .then(resolve)
          .catch(reject);
      } else {
        // If no callback is set, reject with details for the tools route to handle
        const error = new Error("ELICITATION_REQUIRED");
        (error as any).elicitationRequest = {
          requestId,
          message: elicitationRequest.message,
          schema: elicitationRequest.requestedSchema,
        };
        reject(error);
      }
    });
  }

  /**
   * Responds to a pending elicitation request
   */
  respondToElicitation(
    requestId: string,
    response: ElicitationResponse,
  ): boolean {
    const pending = this.pendingElicitations.get(requestId);
    if (!pending) {
      return false;
    }

    pending.resolve(response);
    this.pendingElicitations.delete(requestId);
    return true;
  }

  /**
   * Gets the pending elicitations map for external access
   */
  getPendingElicitations(): Map<
    string,
    {
      resolve: (response: ElicitationResponse) => void;
      reject: (error: any) => void;
    }
  > {
    return this.pendingElicitations;
  }

  /**
   * Sets a callback to handle elicitation requests
   */
  setElicitationCallback(
    callback: (request: {
      requestId: string;
      message: string;
      schema: any;
    }) => Promise<ElicitationResponse>,
  ): void {
    this.elicitationCallback = callback;
  }

  /**
   * Clears the elicitation callback
   */
  clearElicitationCallback(): void {
    this.elicitationCallback = undefined;
  }
}

// Export the class directly instead of singleton
export { MCPJamClientManager };
export default MCPJamClientManager;
