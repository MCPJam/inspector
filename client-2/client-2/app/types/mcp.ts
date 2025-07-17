// MCP Server Configuration Types
export interface BaseServerConfig {
  name: string;
  description?: string;
}

export interface StdioServerConfig extends BaseServerConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpServerConfig extends BaseServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

// MCP Tool Types
export interface Tool {
  name: string;
  description: string;
  inputSchema: any;
}

// MCP Resource Types
export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// MCP Prompt Types
export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface Prompt {
  name: string;
  description?: string;
  arguments?: PromptArgument[];
}