import { encodingForModel, getEncoding } from "js-tiktoken";
import { Model, ModelDefinition, ModelProvider } from "@/shared/types.js";
import { ChatMessage } from "@/lib/chat-types";

// Cache encoders to avoid recreating them
const encoderCache = new Map<string, any>();

// Cache token counts for frequently used text
const tokenCountCache = new Map<string, number>();
const MAX_CACHE_SIZE = 1000;

// Context window limits for different models (in tokens)
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // OpenAI models
  [Model.GPT_4_1]: 128000,
  [Model.GPT_4_1_MINI]: 128000,
  [Model.GPT_4_1_NANO]: 128000,
  [Model.GPT_4O]: 128000,
  [Model.GPT_4O_MINI]: 128000,
  [Model.GPT_4_TURBO]: 128000,
  [Model.GPT_4]: 8192,
  [Model.GPT_5]: 200000, // Estimated
  [Model.GPT_3_5_TURBO]: 16384,
  
  // Anthropic models
  [Model.CLAUDE_OPUS_4_0]: 800000, // Estimated
  [Model.CLAUDE_SONNET_4_0]: 800000, // Estimated
  [Model.CLAUDE_3_7_SONNET_LATEST]: 500000, // Estimated
  [Model.CLAUDE_3_5_SONNET_LATEST]: 200000,
  [Model.CLAUDE_3_5_HAIKU_LATEST]: 200000,
  
  // DeepSeek models
  [Model.DEEPSEEK_CHAT]: 64000,
  [Model.DEEPSEEK_REASONER]: 64000,
  
  // Google Gemini models
  [Model.GEMINI_2_5_PRO]: 2000000,
  [Model.GEMINI_2_5_FLASH]: 1000000,
  [Model.GEMINI_2_5_FLASH_LITE]: 1000000,
  [Model.GEMINI_2_0_FLASH_EXP]: 1000000,
  [Model.GEMINI_1_5_PRO]: 2000000,
  [Model.GEMINI_1_5_PRO_002]: 2000000,
  [Model.GEMINI_1_5_FLASH]: 1000000,
  [Model.GEMINI_1_5_FLASH_002]: 1000000,
  [Model.GEMINI_1_5_FLASH_8B]: 1000000,
  [Model.GEMINI_1_5_FLASH_8B_001]: 1000000,
  [Model.GEMMA_3_2B]: 8192,
  [Model.GEMMA_3_9B]: 8192,
  [Model.GEMMA_3_27B]: 8192,
  [Model.GEMMA_2_2B]: 8192,
  [Model.GEMMA_2_9B]: 8192,
  [Model.GEMMA_2_27B]: 8192,
  [Model.CODE_GEMMA_2B]: 8192,
  [Model.CODE_GEMMA_7B]: 8192,
};

// Default context limit for unknown models
export const DEFAULT_CONTEXT_LIMIT = 4096;

// Map model providers to tiktoken encodings
const PROVIDER_ENCODINGS: Record<ModelProvider, string> = {
  openai: "cl100k_base", // GPT-4, GPT-3.5
  anthropic: "cl100k_base", // Approximate for Claude
  deepseek: "cl100k_base", // Approximate 
  google: "cl100k_base", // Approximate for Gemini
  ollama: "cl100k_base", // Default for local models
};

// Get encoder for specific model with caching
function getEncoder(model: ModelDefinition | null) {
  const cacheKey = model ? `${model.provider}-${model.id}` : "default";
  
  // Check cache first
  if (encoderCache.has(cacheKey)) {
    return encoderCache.get(cacheKey);
  }

  let encoder;
  
  if (!model) {
    encoder = getEncoding("cl100k_base");
  } else if (model.provider === "openai") {
    try {
      // Map specific models to their encodings
      const modelKey = model.id.toString();
      if (modelKey.startsWith("gpt-4") || modelKey.startsWith("gpt-3.5")) {
        encoder = encodingForModel(modelKey as any);
      } else {
        encoder = getEncoding("cl100k_base");
      }
    } catch (error) {
      // Fall back to default if model not found
      console.warn(`Could not load encoding for model ${model.id}, using default`);
      encoder = getEncoding("cl100k_base");
    }
  } else {
    // Use provider-based encoding for non-OpenAI models
    const encodingName = PROVIDER_ENCODINGS[model.provider] || "cl100k_base";
    encoder = getEncoding(encodingName as any);
  }

  // Cache the encoder
  encoderCache.set(cacheKey, encoder);
  return encoder;
}

export interface TokenCount {
  totalTokens: number;
  messageTokens: number;
  systemPromptTokens: number;
  contextLimit: number;
  percentageUsed: number;
  warningLevel: "safe" | "warning" | "danger";
}

export function getContextLimit(model: ModelDefinition | null): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  return MODEL_CONTEXT_LIMITS[model.id.toString()] || DEFAULT_CONTEXT_LIMIT;
}

export function countTokensInText(text: string, model: ModelDefinition | null): number {
  if (!text.trim()) return 0;
  
  // Create cache key
  const cacheKey = `${model?.provider || 'default'}-${model?.id || 'default'}-${text}`;
  
  // Check cache first
  if (tokenCountCache.has(cacheKey)) {
    return tokenCountCache.get(cacheKey)!;
  }
  
  try {
    const encoder = getEncoder(model);
    const tokens = encoder.encode(text);
    const tokenCount = tokens.length;
    
    // Cache the result (with size limit)
    if (tokenCountCache.size >= MAX_CACHE_SIZE) {
      // Remove oldest entries (simple LRU)
      const firstKey = tokenCountCache.keys().next().value;
      if (firstKey) {
        tokenCountCache.delete(firstKey);
      }
    }
    tokenCountCache.set(cacheKey, tokenCount);
    
    return tokenCount;
  } catch (error) {
    console.error("Error counting tokens:", error);
    // Fallback: rough estimation (1 token ≈ 4 characters)
    const estimate = Math.ceil(text.length / 4);
    tokenCountCache.set(cacheKey, estimate);
    return estimate;
  }
}

export function countTokensInMessage(message: ChatMessage, model: ModelDefinition | null): number {
  // Count tokens in message content using fast counting
  let tokens = countTokensFast(message.content, model);
  
  // Add overhead for message formatting (role, metadata, etc.)
  // Based on OpenAI's estimation: every message follows <|start|>{role/name}\n{content}<|end|>\n
  tokens += 3; // Base message overhead
  
  // Add tokens for role
  tokens += countTokensFast(message.role, model);
  
  // Add tokens for tool calls if present
  if (message.toolCalls && message.toolCalls.length > 0) {
    for (const toolCall of message.toolCalls) {
      tokens += countTokensFast(toolCall.name, model);
      tokens += countTokensFast(JSON.stringify(toolCall.parameters), model);
      tokens += 10; // Tool call overhead
    }
  }
  
  // Add tokens for tool results if present
  if (message.toolResults && message.toolResults.length > 0) {
    for (const result of message.toolResults) {
      tokens += countTokensFast(JSON.stringify(result), model);
      tokens += 5; // Tool result overhead
    }
  }
  
  return tokens;
}

export function calculateTokenUsage(
  messages: ChatMessage[],
  systemPrompt: string,
  model: ModelDefinition | null
): TokenCount {
  // Count system prompt tokens using fast counting
  const systemPromptTokens = countTokensFast(systemPrompt, model);
  
  // Count message tokens
  const messageTokens = messages.reduce((total, message) => {
    return total + countTokensInMessage(message, model);
  }, 0);
  
  // Total tokens
  const totalTokens = systemPromptTokens + messageTokens;
  
  // Context limit
  const contextLimit = getContextLimit(model);
  
  // Calculate percentage used
  const percentageUsed = (totalTokens / contextLimit) * 100;
  
  // Determine warning level
  let warningLevel: "safe" | "warning" | "danger" = "safe";
  if (percentageUsed >= 90) {
    warningLevel = "danger";
  } else if (percentageUsed >= 70) {
    warningLevel = "warning";
  }
  
  return {
    totalTokens,
    messageTokens,
    systemPromptTokens,
    contextLimit,
    percentageUsed,
    warningLevel,
  };
}

// Real-time token counting for input text
export function countTokensInInput(
  currentInput: string,
  messages: ChatMessage[],
  systemPrompt: string,
  model: ModelDefinition | null
): TokenCount {
  // Create a temporary message to simulate the user's input
  const tempMessage: ChatMessage = {
    id: "temp",
    role: "user",
    content: currentInput,
    timestamp: new Date(),
  };
  
  // Calculate tokens including the current input
  const allMessages = [...messages, tempMessage];
  return calculateTokenUsage(allMessages, systemPrompt, model);
}

// Format token count for display
export function formatTokenCount(tokenCount: TokenCount): string {
  const { totalTokens, contextLimit, percentageUsed } = tokenCount;
  return `${totalTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens (${percentageUsed.toFixed(1)}%)`;
}

// Get warning message based on token usage
export function getTokenWarningMessage(tokenCount: TokenCount): string | null {
  const { warningLevel, percentageUsed, contextLimit, totalTokens } = tokenCount;
  
  if (warningLevel === "danger") {
    const remaining = contextLimit - totalTokens;
    return `Context window nearly full! Only ${remaining.toLocaleString()} tokens remaining.`;
  } else if (warningLevel === "warning") {
    return `Approaching context limit (${percentageUsed.toFixed(1)}% used). Consider clearing chat history.`;
  }
  
  return null;
}

// Simple estimation mode for better performance
export function estimateTokensQuickly(text: string): number {
  if (!text.trim()) return 0;
  // Quick estimation: 1 token ≈ 4 characters (works well for most text)
  return Math.ceil(text.length / 4);
}

// Fast token counting with fallback to estimation
export function countTokensFast(text: string, model: ModelDefinition | null): number {
  // For very long texts, use quick estimation to avoid performance issues
  if (text.length > 10000) {
    return estimateTokensQuickly(text);
  }
  
  return countTokensInText(text, model);
}