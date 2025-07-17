# Mastra MCP Documentation - Complete API Reference

## Overview

Mastra's Model Context Protocol (MCP) implementation provides a standardized way for AI agents to discover and interact with external tools and resources. The `@mastra/mcp` package offers a comprehensive client implementation that handles multiple server connections, tool discovery, and resource management.

## Package Installation

```bash
npm install @mastra/mcp
# or
pnpm add @mastra/mcp
# or
yarn add @mastra/mcp
```

## Core Classes

### MCPClient

The `MCPClient` class is the primary interface for managing multiple MCP server connections. It handles connection lifecycle, tool namespacing, and provides access to tools and resources across all configured servers.

#### Constructor

```typescript
import { MCPClient } from '@mastra/mcp';

const mcp = new MCPClient({
  servers: {
    [serverName: string]: ServerConfig
  }
});
```

#### Server Configuration Types

**Stdio Server Configuration:**
```typescript
interface StdioServerConfig {
  command: string;           // Command to execute
  args?: string[];          // Command arguments
  env?: Record<string, string>; // Environment variables
}
```

**HTTP Server Configuration:**
```typescript
interface HttpServerConfig {
  url: URL;                 // Server endpoint URL
  requestInit?: RequestInit; // Additional fetch options
}
```

#### Basic Usage Examples

**Stdio Server Setup:**
```typescript
const mcp = new MCPClient({
  servers: {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/username/Downloads"],
    },
    stockPrice: {
      command: 'npx',
      args: ['tsx', 'stock-price.ts'],
      env: {
        API_KEY: 'your-api-key',
      },
    },
  },
});
```

**HTTP Server Setup:**
```typescript
const mcp = new MCPClient({
  servers: {
    weather: {
      url: new URL('http://localhost:8080/mcp'),
      requestInit: {
        headers: {
          'X-Api-Key': 'weather-key',
          'Authorization': 'Bearer your-token'
        },
      },
    },
    remoteApi: {
      url: new URL('https://your-mcp-server.com/mcp'),
      requestInit: {
        headers: { 
          Authorization: 'Bearer your-token' 
        }
      }
    }
  },
});
```

**Mixed Server Configuration:**
```typescript
const mcp = new MCPClient({
  servers: {
    // Local stdio server
    localFiles: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "./workspace"],
    },
    // Remote HTTP server
    webSearch: {
      url: new URL('https://search-api.example.com/mcp'),
      requestInit: {
        headers: { 'API-Key': 'search-key' }
      }
    },
    // Another stdio server with custom environment
    database: {
      command: 'python',
      args: ['-m', 'my_database_server'],
      env: {
        DB_CONNECTION_STRING: 'postgresql://...',
        LOG_LEVEL: 'debug'
      }
    }
  },
});
```

## Core Methods

### getTools()

**Static Configuration Approach** - Retrieves all tools from all configured servers with namespaced names. Best for applications where tool configuration is static and shared across all users.

```typescript
async getTools(): Promise<Record<string, Tool>>
```

**Usage with Agents:**
```typescript
import { Agent } from '@mastra/core/agent';

const mcp = new MCPClient({
  servers: {
    stockPrice: {
      command: 'npx',
      args: ['tsx', 'stock-price.ts'],
    },
    weather: {
      url: new URL('http://localhost:8080/mcp'),
    }
  }
});

// Get all tools from all servers (namespaced)
const tools = await mcp.getTools();

// Tools will be namespaced like:
// {
//   "stockPrice.getStockPrice": Tool,
//   "stockPrice.getStockHistory": Tool,
//   "weather.getCurrentWeather": Tool,
//   "weather.getWeatherForecast": Tool
// }

const agent = new Agent({
  name: 'Trading Assistant',
  instructions: 'Help users with stock prices and weather data',
  model: openai('gpt-4'),
  tools: tools, // All tools available to agent
});

const response = await agent.generate('What is the current price of AAPL?');
```

### getToolsets()

**Dynamic Configuration Approach** - Returns tool implementations mapped by server. Designed for scenarios where configuration might change per request or per user (e.g., multi-tenant applications).

```typescript
async getToolsets(): Promise<Record<string, Record<string, Tool>>>
```

**Usage with Dynamic Configuration:**
```typescript
// Function to create user-specific MCP client
function createUserMCPClient(userId: string, userApiKeys: Record<string, string>) {
  return new MCPClient({
    servers: {
      stockPrice: {
        command: 'npx',
        args: ['tsx', 'stock-price.ts'],
        env: {
          API_KEY: userApiKeys.stockApi, // User-specific API key
          USER_ID: userId,
        },
      },
      weather: {
        url: new URL('http://localhost:8080/mcp'),
        requestInit: {
          headers: {
            'X-User-Id': userId,
            'X-Api-Key': userApiKeys.weatherApi, // User-specific API key
          }
        }
      }
    },
  });
}

// Per-request tool configuration
async function handleUserRequest(userId: string, query: string) {
  const userApiKeys = await getUserApiKeys(userId);
  const mcp = createUserMCPClient(userId, userApiKeys);
  
  // Get tools grouped by server
  const toolsets = await mcp.getToolsets();
  
  // Toolsets structure:
  // {
  //   stockPrice: {
  //     getStockPrice: Tool,
  //     getStockHistory: Tool
  //   },
  //   weather: {
  //     getCurrentWeather: Tool,
  //     getWeatherForecast: Tool
  //   }
  // }

  const agent = new Agent({
    name: 'Personal Assistant',
    instructions: 'Help the user with their specific requests',
    model: openai('gpt-4'),
  });

  // Pass toolsets dynamically during generation
  const response = await agent.generate(query, {
    toolsets: toolsets,
  });
  
  await mcp.disconnect();
  return response;
}
```

### Resources Management

The `MCPClient` provides resource management capabilities through the `resources` property:

```typescript
interface ResourcesManager {
  list(): Promise<Record<string, Resource[]>>;
  templates(): Promise<Record<string, ResourceTemplate[]>>;
  read(uri: string): Promise<ResourceContent>;
}
```

**Usage Examples:**
```typescript
const mcp = new MCPClient({
  servers: {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "./workspace"],
    },
    database: {
      url: new URL('http://localhost:8080/mcp'),
    }
  }
});

// List all resources from all servers
const allResources = await mcp.resources.list();
// Returns:
// {
//   filesystem: [
//     { uri: "file://./workspace/config.json", name: "config.json" },
//     { uri: "file://./workspace/data.csv", name: "data.csv" }
//   ],
//   database: [
//     { uri: "db://users", name: "Users Table" },
//     { uri: "db://products", name: "Products Table" }
//   ]
// }

// Get resource templates
const templates = await mcp.resources.templates();

// Read specific resource
const configContent = await mcp.resources.read("file://./workspace/config.json");
```

### Prompts Management

Access to server prompts through the `prompts` property:

```typescript
interface PromptsManager {
  list(): Promise<Record<string, Prompt[]>>;
  get(name: string, args?: Record<string, any>): Promise<PromptContent>;
}
```

**Usage Examples:**
```typescript
// List all prompts from all servers
const allPrompts = await mcp.prompts.list();

// Get specific prompt with arguments
const promptContent = await mcp.prompts.get("code-review", {
  language: "typescript",
  severity: "high"
});
```

### Connection Management

```typescript
// Connect to all configured servers
await mcp.connect();

// Disconnect from all servers and cleanup
await mcp.disconnect();
```

## Advanced Configuration Patterns

### Multi-Tenant Architecture

```typescript
class TenantMCPManager {
  private clients = new Map<string, MCPClient>();

  async getClientForTenant(tenantId: string): Promise<MCPClient> {
    if (!this.clients.has(tenantId)) {
      const tenantConfig = await this.getTenantConfig(tenantId);
      
      const client = new MCPClient({
        servers: {
          tenantSpecificService: {
            url: new URL(`https://api.example.com/tenant/${tenantId}/mcp`),
            requestInit: {
              headers: {
                'X-Tenant-Id': tenantId,
                'Authorization': `Bearer ${tenantConfig.apiKey}`
              }
            }
          },
          sharedService: {
            command: 'npx',
            args: ['tsx', 'shared-service.ts'],
            env: {
              TENANT_ID: tenantId,
              CONFIG_PATH: `/configs/${tenantId}.json`
            }
          }
        }
      });
      
      this.clients.set(tenantId, client);
    }
    
    return this.clients.get(tenantId)!;
  }

  async cleanup(tenantId: string) {
    const client = this.clients.get(tenantId);
    if (client) {
      await client.disconnect();
      this.clients.delete(tenantId);
    }
  }
}
```

### Environment-Specific Configuration

```typescript
function createEnvironmentMCPClient(env: 'dev' | 'staging' | 'prod') {
  const baseConfig = {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "./workspace"],
    }
  };

  const envConfigs = {
    dev: {
      apiService: {
        url: new URL('http://localhost:8080/mcp'),
        requestInit: {
          headers: { 'X-Environment': 'development' }
        }
      }
    },
    staging: {
      apiService: {
        url: new URL('https://staging-api.example.com/mcp'),
        requestInit: {
          headers: { 
            'X-Environment': 'staging',
            'Authorization': `Bearer ${process.env.STAGING_API_KEY}`
          }
        }
      }
    },
    prod: {
      apiService: {
        url: new URL('https://api.example.com/mcp'),
        requestInit: {
          headers: { 
            'X-Environment': 'production',
            'Authorization': `Bearer ${process.env.PROD_API_KEY}`
          }
        }
      }
    }
  };

  return new MCPClient({
    servers: {
      ...baseConfig,
      ...envConfigs[env]
    }
  });
}
```

## Agent Integration Patterns

### Static Tool Configuration

```typescript
import { Agent } from '@mastra/core/agent';

// Best for single-user applications or shared tool configurations
class StaticAgentService {
  private agent: Agent;
  
  constructor() {
    this.initializeAgent();
  }

  private async initializeAgent() {
    const mcp = new MCPClient({
      servers: {
        codeAnalysis: {
          command: 'npx',
          args: ['tsx', 'code-analysis-server.ts'],
        },
        documentation: {
          url: new URL('https://docs-api.example.com/mcp'),
        }
      }
    });

    const tools = await mcp.getTools();

    this.agent = new Agent({
      name: 'Code Assistant',
      instructions: 'Help developers with code analysis and documentation',
      model: openai('gpt-4'),
      tools: tools, // Static tool configuration
    });
  }

  async processQuery(query: string) {
    return await this.agent.generate(query);
  }
}
```

### Dynamic Tool Configuration

```typescript
// Best for multi-user applications with per-user configurations
class DynamicAgentService {
  async processUserQuery(userId: string, query: string) {
    const userPreferences = await this.getUserPreferences(userId);
    const userCredentials = await this.getUserCredentials(userId);

    const mcp = new MCPClient({
      servers: this.buildUserServerConfig(userId, userPreferences, userCredentials)
    });

    const toolsets = await mcp.getToolsets();

    const agent = new Agent({
      name: 'Personal Assistant',
      instructions: `Help ${userPreferences.name} with their tasks`,
      model: openai('gpt-4'),
    });

    try {
      const response = await agent.generate(query, {
        toolsets: toolsets, // Dynamic tool configuration
      });
      
      return response;
    } finally {
      await mcp.disconnect(); // Cleanup per-request
    }
  }

  private buildUserServerConfig(userId: string, preferences: any, credentials: any) {
    const servers: any = {};

    // Add servers based on user preferences
    if (preferences.enableCodeAnalysis) {
      servers.codeAnalysis = {
        command: 'npx',
        args: ['tsx', 'code-analysis-server.ts'],
        env: {
          USER_ID: userId,
          ANALYSIS_LEVEL: preferences.analysisLevel
        }
      };
    }

    if (preferences.enableWebSearch) {
      servers.webSearch = {
        url: new URL('https://search-api.example.com/mcp'),
        requestInit: {
          headers: {
            'X-User-Id': userId,
            'Authorization': `Bearer ${credentials.searchApiKey}`
          }
        }
      };
    }

    return servers;
  }
}
```

## Error Handling and Best Practices

### Connection Error Handling

```typescript
class RobustMCPClient {
  private client: MCPClient;
  
  constructor(config: any) {
    this.client = new MCPClient(config);
  }

  async withRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        if (attempt === maxRetries) {
          throw new Error(`Operation failed after ${maxRetries} attempts: ${lastError.message}`);
        }
        
        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
    
    throw lastError!;
  }

  async getToolsSafely() {
    return this.withRetry(async () => {
      return await this.client.getTools();
    });
  }

  async getResourcesSafely() {
    return this.withRetry(async () => {
      return await this.client.resources.list();
    });
  }
}
```

### Resource Cleanup

```typescript
class ManagedMCPClient {
  private client: MCPClient;
  private isConnected = false;

  constructor(config: any) {
    this.client = new MCPClient(config);
  }

  async connect() {
    if (!this.isConnected) {
      await this.client.connect();
      this.isConnected = true;
    }
  }

  async disconnect() {
    if (this.isConnected) {
      await this.client.disconnect();
      this.isConnected = false;
    }
  }

  async withConnection<T>(operation: (client: MCPClient) => Promise<T>): Promise<T> {
    await this.connect();
    try {
      return await operation(this.client);
    } finally {
      await this.disconnect();
    }
  }
}

// Usage
const managedClient = new ManagedMCPClient({
  servers: { /* config */ }
});

const result = await managedClient.withConnection(async (client) => {
  const tools = await client.getTools();
  const resources = await client.resources.list();
  return { tools, resources };
});
```

## TypeScript Types and Interfaces

```typescript
// Core types used by MCPClient
interface ServerConfig {
  // Stdio configuration
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  
  // HTTP configuration
  url?: URL;
  requestInit?: RequestInit;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute: (args: any) => Promise<any>;
}

interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface Prompt {
  name: string;
  description?: string;
  arguments?: PromptArgument[];
}

interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

// MCPClient configuration
interface MCPClientConfig {
  servers: Record<string, ServerConfig>;
}
```

## Integration with Mastra Workflows

```typescript
import { Workflow } from '@mastra/core/workflow';

// Create workflow that uses MCP tools
const analysisWorkflow = new Workflow({
  name: 'Code Analysis Workflow',
  steps: [
    {
      id: 'analyze',
      action: async ({ inputs, context }) => {
        const mcp = new MCPClient({
          servers: {
            codeAnalysis: {
              command: 'npx',
              args: ['tsx', 'code-analysis-server.ts'],
            }
          }
        });

        const toolsets = await mcp.getToolsets();
        
        const agent = new Agent({
          name: 'Code Analyzer',
          instructions: 'Analyze the provided code',
          model: openai('gpt-4'),
        });

        const result = await agent.generate(
          `Analyze this code: ${inputs.code}`,
          { toolsets }
        );

        await mcp.disconnect();
        return { analysis: result };
      }
    }
  ]
});

// Use in agent with workflow
const agent = new Agent({
  name: 'Development Assistant',
  instructions: 'Help with development tasks',
  model: openai('gpt-4'),
  workflows: [analysisWorkflow]
});
```

This comprehensive documentation covers all aspects of Mastra's MCP implementation, from basic usage to advanced patterns and best practices for production applications.