// Common provider types and interfaces

export interface ProviderMessage {
  role: "user" | "assistant";
  content: string | ProviderMessageContent[];
}

export interface ProviderMessageContent {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface ProviderTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface ProviderCreateOptions {
  model: string;
  max_tokens: number;
  messages: ProviderMessage[];
  tools?: ProviderTool[];
}

export interface ProviderResponse {
  content: ProviderResponseContent[];
  model: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface ProviderResponseContent {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
  dangerouslyAllowBrowser?: boolean;
}

export interface ProviderModel {
  id: string;
  name: string;
  description: string;
}

export abstract class AIProvider {
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  abstract updateApiKey(apiKey: string): void;
  abstract createMessage(options: ProviderCreateOptions): Promise<ProviderResponse>;
  abstract validateConfig(): boolean;
  abstract getProviderName(): string;
  abstract getDefaultModel(): string;
  abstract getSupportedModels(): ProviderModel[];
}

export type SupportedProvider = "anthropic" | "openai" | "deepseek";

export interface ProviderFactory {
  createProvider(type: SupportedProvider, config: ProviderConfig): AIProvider;
} 