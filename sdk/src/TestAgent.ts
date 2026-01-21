import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface TestAgentConfig {
  tools: Tool[];
  llm: string;
  apiKey: string;
  systemPrompt?: string;
  temperature?: number;
}

export interface QueryResult {
  response: string;
  toolCalls: ToolCall[];
  tokenUsage: TokenUsage;
}

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class TestAgent {
  private tools: Tool[];
  private llm: string;
  private apiKey: string;
  private systemPrompt: string;
  private temperature: number;

  constructor(config: TestAgentConfig) {
    this.tools = config.tools;
    this.llm = config.llm;
    this.apiKey = config.apiKey;
    this.systemPrompt = config.systemPrompt ?? "You are a helpful assistant.";
    this.temperature = config.temperature ?? 0.7;
  }

  async query(_prompt: string): Promise<QueryResult> {
    // TODO: Implement LLM query with tool calling
    // This would integrate with OpenAI, Anthropic, or other LLM providers
    // based on the llm string (e.g., "openai/gpt-4o", "anthropic/claude-3")
    // Will use: this.llm, this.apiKey, this.systemPrompt, this.temperature

    throw new Error("Not implemented: query()");
  }

  toolsCalled(): string[] {
    // Returns the names of tools called in the last query
    throw new Error("Not implemented: toolsCalled()");
  }

  getTools(): Tool[] {
    return this.tools;
  }

  getLlm(): string {
    return this.llm;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getTemperature(): number {
    return this.temperature;
  }

  setTemperature(temperature: number): void {
    if (temperature < 0 || temperature > 2) {
      throw new Error("Temperature must be between 0 and 2");
    }
    this.temperature = temperature;
  }
}
