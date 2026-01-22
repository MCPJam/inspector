/**
 * Core types for SDK evals functionality
 */

/**
 * Built-in LLM providers with native SDK support
 */
export type LLMProvider =
  | "anthropic"
  | "openai"
  | "azure"
  | "deepseek"
  | "google"
  | "ollama"
  | "mistral"
  | "openrouter"
  | "xai";

/**
 * Compatible API protocols for custom providers
 */
export type CompatibleProtocol = "openai-compatible" | "anthropic-compatible";

/**
 * Configuration for a custom provider (user-defined)
 */
export interface CustomProvider {
  /** Unique name for this provider (used in model strings, e.g., "groq/llama-3") */
  name: string;
  /** API protocol this provider is compatible with */
  protocol: CompatibleProtocol;
  /** Base URL for the API endpoint */
  baseUrl: string;
  /** List of available model IDs */
  modelIds: string[];
  /** Optional API key (can also be provided at runtime) */
  apiKey?: string;
  /** Environment variable name to read API key from (fallback) */
  apiKeyEnvVar?: string;
  /**
   * Use Chat Completions API (.chat()) instead of default.
   * Required for some OpenAI-compatible providers like LiteLLM.
   * Only applies to openai-compatible protocol.
   */
  useChatCompletions?: boolean;
}

/**
 * Configuration for an LLM
 */
export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
}

/**
 * Represents a tool call made by the LLM
 */
export interface ToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
}

/**
 * Token usage statistics
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Latency breakdown for prompt execution
 */
export interface LatencyBreakdown {
  /** Total wall-clock time in milliseconds */
  e2eMs: number;
  /** LLM API time in milliseconds */
  llmMs: number;
  /** MCP tool execution time in milliseconds */
  mcpMs: number;
}

/**
 * Raw prompt result data (used internally)
 */
export interface PromptResultData {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  latency: LatencyBreakdown;
  error?: string;
}
