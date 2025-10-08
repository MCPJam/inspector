import { MCPClient, MastraMCPServerDefinition } from "@mastra/mcp";
import { validateServerConfig } from "../utils/mcp-utils";
import { DynamicArgument } from "@mastra/core/base";
import { ToolsInput } from "@mastra/core/agent";

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

function generateUniqueServerId(serverId: string) {
  // Generate unique server ID that avoids collisions
  const normalizedBase = serverId
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${normalizedBase}_${timestamp}_${random}`;
}

class MCPJamClientManager {
  private mcpClients: Map<string, MCPClient> = new Map();
  private statuses: Map<string, ConnectionStatus> = new Map();
  private configs: Map<string, MastraMCPServerDefinition> = new Map();

  // Map original server names to unique IDs
  private serverIdMapping: Map<string, string> = new Map();

  // Track in-flight connections to avoid duplicate concurrent connects
  private pendingConnections: Map<string, Promise<void>> = new Map();

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

  // Centralized server ID resolution - handles both original names and unique IDs
  private resolveServerId(serverIdentifier: string): string | undefined {
    if (this.mcpClients.has(serverIdentifier)) {
      return serverIdentifier;
    }
    return this.serverIdMapping.get(serverIdentifier);
  }

  // Public method to get server ID for external use (like frontend)
  getServerIdForName(serverName: string): string | undefined {
    return this.serverIdMapping.get(serverName);
  }

  // Reverse lookup: get server name from internal server ID
  getServerNameForId(serverId: string): string | undefined {
    for (const [name, id] of this.serverIdMapping.entries()) {
      if (id === serverId) {
        return name;
      }
    }
    return undefined;
  }

  private flattenToolsets(toolsets: Record<string, any>): Record<string, any> {
    const flattenedTools: Record<string, any> = {};
    Object.values(toolsets).forEach((serverTools: any) => {
      Object.assign(flattenedTools, serverTools);
    });
    return flattenedTools;
  }

  async getToolsetsWithServerIds(
    serverNameFilter?: string[],
  ): Promise<Record<string, Record<string, any>>> {
    const toolsetsByServer: Record<string, Record<string, any>> = {};
    const allServerIdsFromFilter = serverNameFilter?.map((serverName) =>
      this.getServerIdForName(serverName),
    );

    for (const [serverId, client] of this.mcpClients.entries()) {
      if (serverNameFilter && !allServerIdsFromFilter?.includes(serverId))
        continue;
      if (this.getConnectionStatus(serverId) !== "connected") continue;
      try {
        const toolsets = await client.getToolsets();
        const flattenedTools = this.flattenToolsets(toolsets);

        // Use server name instead of internal ID
        const serverName = this.getServerNameForId(serverId) || serverId;
        toolsetsByServer[serverName] = flattenedTools;
      } catch (error) {
        console.warn(`Failed to get tools from server ${serverId}:`, error);
      }
    }

    return toolsetsByServer;
  }

  async getFlattenedToolsetsForEnabledServers(
    serverNameFilter?: string[],
  ): Promise<DynamicArgument<ToolsInput>> {
    const allFlattenedTools: Record<string, any> = {};
    const allServerIdsFromFilter = serverNameFilter?.map((serverName) =>
      this.getServerIdForName(serverName),
    ); // Optional filter by servers selected

    for (const [serverId, client] of this.mcpClients.entries()) {
      if (serverNameFilter && !allServerIdsFromFilter?.includes(serverId))
        continue;
      if (this.getConnectionStatus(serverId) !== "connected") continue;
      try {
        const toolsets = await client.getToolsets();
        const flattenedTools = this.flattenToolsets(toolsets);
        Object.assign(allFlattenedTools, flattenedTools);
      } catch (error) {
        console.warn(`Failed to get tools from server ${serverId}:`, error);
      }
    }

    return allFlattenedTools as DynamicArgument<ToolsInput>;
  }

  async getToolsetsForServer(
    serverId: string,
  ): Promise<DynamicArgument<ToolsInput>> {
    const id = this.resolveServerId(serverId);
    if (!id) {
      throw new Error(`No MCP client available for server: ${serverId}`);
    }
    const client = this.mcpClients.get(id);
    if (!client) {
      throw new Error(`No MCP client available for server: ${serverId}`);
    }

    // Get toolsets and flatten them
    const toolsets = await client.getToolsets();
    return this.flattenToolsets(toolsets) as DynamicArgument<ToolsInput>;
  }

  async connectToServer(serverId: string, serverConfig: any): Promise<void> {
    // If a connection is already in-flight for this server name, wait for it
    const pending = this.pendingConnections.get(serverId);
    if (pending) {
      await pending;
      return;
    }

    const connectPromise = (async () => {
      // Reuse existing unique ID for this server name if present; otherwise generate and map one
      let id = this.serverIdMapping.get(serverId);
      if (!id) {
        id = generateUniqueServerId(serverId);
        this.serverIdMapping.set(serverId, id);
      }

      // If already connected, no-op
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
          client.elicitation.onRequest(
            id,
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
    })().finally(() => {
      this.pendingConnections.delete(serverId);
    });

    this.pendingConnections.set(serverId, connectPromise);
    await connectPromise;
  }

  async disconnectFromServer(serverId: string): Promise<void> {
    const id = this.resolveServerId(serverId);
    if (!id) return; // Server not found

    const client = this.mcpClients.get(id);
    if (client) {
      try {
        await client.disconnect();
      } catch {}
    }
    this.mcpClients.delete(id);
    this.statuses.set(id, "disconnected");
    this.serverIdMapping.delete(serverId); // Clean up the mapping

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
    const id = this.resolveServerId(serverId);
    return id ? this.statuses.get(id) || "disconnected" : "disconnected";
  }

  getConnectedServers(): Record<
    string,
    { status: ConnectionStatus; config?: MastraMCPServerDefinition }
  > {
    const servers: Record<
      string,
      { status: ConnectionStatus; config?: MastraMCPServerDefinition }
    > = {};

    // Return data keyed by the original server names provided by callers
    for (const [originalName, uniqueId] of this.serverIdMapping.entries()) {
      servers[originalName] = {
        status: this.statuses.get(uniqueId) || "disconnected",
        config: this.configs.get(uniqueId),
      };
    }
    return servers;
  }

  async discoverAllResources(): Promise<void> {
    const serverIds = Array.from(this.mcpClients.keys());
    await Promise.all(serverIds.map((id) => this.discoverServerResources(id)));
  }

  private async discoverServerResources(serverId: string): Promise<void> {
    // serverId is already the unique ID when called from connectToServer
    const client = this.mcpClients.get(serverId);
    if (!client) return;

    // Tools - use toolsets instead of getTools for consistency
    const toolsets = await client.getToolsets();
    const flattenedTools = this.flattenToolsets(toolsets);

    for (const [name, tool] of Object.entries<any>(flattenedTools)) {
      this.toolRegistry.set(`${serverId}:${name}`, {
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: (tool as any).outputSchema,
        serverId: serverId,
      });
    }

    // Resources
    try {
      const res = await client.resources.list();
      for (const [, list] of Object.entries<any>(res)) {
        for (const r of list as any[]) {
          this.resourceRegistry.set(`${serverId}:${r.uri}`, {
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
            serverId: serverId,
          });
        }
      }
    } catch {}

    // Prompts
    try {
      const prompts = await client.prompts.list();
      for (const [, list] of Object.entries<any>(prompts)) {
        for (const p of list as any[]) {
          this.promptRegistry.set(`${serverId}:${p.name}`, {
            name: p.name,
            description: p.description,
            arguments: p.arguments,
            serverId: serverId,
          });
        }
      }
    } catch {}
  }

  getAvailableTools(): DiscoveredTool[] {
    return Array.from(this.toolRegistry.values());
  }

  getAvailableResources(): DiscoveredResource[] {
    return Array.from(this.resourceRegistry.values());
  }

  getResourcesForServer(serverId: string): DiscoveredResource[] {
    const id = this.resolveServerId(serverId);
    if (!id) return [];
    return Array.from(this.resourceRegistry.values()).filter(
      (r) => r.serverId === id,
    );
  }

  getAvailablePrompts(): DiscoveredPrompt[] {
    return Array.from(this.promptRegistry.values());
  }

  getPromptsForServer(serverId: string): DiscoveredPrompt[] {
    const id = this.resolveServerId(serverId);
    if (!id) return [];
    return Array.from(this.promptRegistry.values()).filter(
      (p) => p.serverId === id,
    );
  }

  async executeToolDirect(
    toolName: string,
    parameters: Record<string, any> = {},
  ): Promise<ToolResult> {
    // toolName may include server prefix "serverId:tool"
    let serverId = "";
    let name = toolName;

    if (toolName.includes(":")) {
      const [sid, n] = toolName.split(":", 2);
      serverId = this.resolveServerId(sid) || "";
      name = n;
    } else {
      // Find which server has this tool by checking un-prefixed name
      for (const tool of this.toolRegistry.values()) {
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
          const flattenedTools = this.flattenToolsets(toolsets);

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

    // Use toolsets to get the actual tool
    const toolsets = await client.getToolsets();
    const flattenedTools = this.flattenToolsets(toolsets);

    const tool = flattenedTools[name];
    if (!tool)
      throw new Error(`Tool '${name}' not found in server '${serverId}'`);

    // Always wrap parameters in context object (matching Chat behavior)
    const result = await tool.execute({ context: parameters || {} });

    // Check if the result indicates an error
    if (result && result.isError) {
      const errorText =
        result.content && result.content[0] && result.content[0].text
          ? result.content[0].text
          : "Unknown error";
      throw new Error(errorText);
    }

    return { result };
  }

  async getResource(
    resourceUri: string,
    serverId: string,
  ): Promise<ResourceContent> {
    // resourceUri may include server prefix
    let uri = resourceUri;
    const resolvedServerId = this.resolveServerId(serverId);

    if (!resolvedServerId) {
      throw new Error(`No MCP client available for server: ${serverId}`);
    }

    const client = this.mcpClients.get(resolvedServerId);
    if (!client) throw new Error("No MCP client available");
    const content = await client.resources.read(resolvedServerId, uri);
    return { contents: content?.contents || [] };
  }

  async getPrompt(
    promptName: string,
    serverId: string,
    args?: Record<string, any>,
  ): Promise<PromptResult> {
    const resolvedServerId = this.resolveServerId(serverId);

    if (!resolvedServerId) {
      throw new Error(`No MCP client available for server: ${serverId}`);
    }

    const client = this.mcpClients.get(resolvedServerId);
    if (!client) throw new Error("No MCP client available");
    const content = await client.prompts.get({
      serverName: resolvedServerId,
      name: promptName,
      args: args || {},
    });
    return { content };
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
