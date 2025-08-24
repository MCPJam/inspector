import { MCPClient, MastraMCPServerDefinition } from "@mastra/mcp";
import { validateServerConfig } from "../utils/mcp-utils";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

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

export interface ResourceContent {
	contents: any[];
}

export interface PromptResult {
	content: any;
}

function normalizeServerId(serverId: string) {
	return serverId.toLowerCase().replace(/[\s\-]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

class MCPJamAgent {
	private mcpClients: Map<string, MCPClient> = new Map();
	private statuses: Map<string, ConnectionStatus> = new Map();
	private configs: Map<string, MastraMCPServerDefinition> = new Map();

	private toolRegistry: Map<string, DiscoveredTool> = new Map();
	private resourceRegistry: Map<string, DiscoveredResource> = new Map();
	private promptRegistry: Map<string, DiscoveredPrompt> = new Map();

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
			servers: { [id]: validation.config! }
		});
		
		try {
			// touch the server to verify connection
			await client.getTools();
			this.mcpClients.set(id, client);
			this.statuses.set(id, "connected");
			await this.discoverServerResources(id);
		} catch (err) {
			this.statuses.set(id, "error");
			try { await client.disconnect(); } catch {}
			this.mcpClients.delete(id);
			throw err;
		}
	}

	async disconnectFromServer(serverId: string): Promise<void> {
		const id = normalizeServerId(serverId);
		const client = this.mcpClients.get(id);
		if (client) {
			try { await client.disconnect(); } catch {}
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
	getAvailableResources(): DiscoveredResource[] {
		return Array.from(this.resourceRegistry.values());
	}
	getAvailablePrompts(): DiscoveredPrompt[] {
		return Array.from(this.promptRegistry.values());
	}

	async executeToolDirect(toolName: string, parameters: Record<string, any>): Promise<ToolResult> {
		// toolName may include server prefix "serverId:tool"
		let serverId = "";
		let name = toolName;
		if (toolName.includes(":")) {
			const [sid, n] = toolName.split(":", 2);
			serverId = normalizeServerId(sid);
			name = n;
		}
		const client = serverId ? this.mcpClients.get(serverId) : this.pickAnyClient();
		if (!client) throw new Error("No MCP client available");
		const tools = await client.getTools();
		const tool = tools[name];
		if (!tool) throw new Error(`Tool not found: ${toolName}`);
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
		const client = serverId ? this.mcpClients.get(serverId) : this.pickAnyClient();
		if (!client) throw new Error("No MCP client available");
		const content = await client.resources.read(serverId || Object.keys(client.servers)[0], uri);
		return { contents: content?.contents || [] };
	}

	async getPrompt(promptName: string, args?: Record<string, any>): Promise<PromptResult> {
		let serverId = "";
		let name = promptName;
		if (promptName.includes(":")) {
			const [sid, rest] = promptName.split(":", 2);
			serverId = normalizeServerId(sid);
			name = rest;
		}
		const client = serverId ? this.mcpClients.get(serverId) : this.pickAnyClient();
		if (!client) throw new Error("No MCP client available");
		const content = await client.prompts.get({ serverName: serverId || Object.keys(client.servers)[0], name, args: args || {} });
		return { content };
	}

	async executeConversational(messages: ChatMessage[]): Promise<ChatResponse> {
		// Placeholder: actual conversational orchestration remains in chat route for streaming.
		// This method is reserved for future integration where streaming is managed centrally.
		return { text: "" };
	}

	private pickAnyClient(): MCPClient | undefined {
		for (const c of this.mcpClients.values()) return c;
		return undefined;
	}
}

// Export the class directly instead of singleton
export { MCPJamAgent };
export default MCPJamAgent;