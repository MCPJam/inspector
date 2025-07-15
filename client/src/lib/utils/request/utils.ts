import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { providerManager } from "../../providers";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Provider utilities
export function getProviderDisplayName(): string {
  const defaultProvider = providerManager.getDefaultProvider();
  if (defaultProvider) {
    const providerName = defaultProvider.constructor.name.toLowerCase();
    if (providerName.includes("anthropic")) return "Claude";
    if (providerName.includes("openai")) return "OpenAI";
    if (providerName.includes("ollama")) return "Ollama";
  }
  return "AI";
}

// Chat configuration utilities
export interface ChatConfig {
  title: string;
  subtitle?: string;
  suggestions: string[];
}

export function createChatConfig(
  options: {
    subtitle?: string;
    additionalSuggestions?: string[];
  } = {},
): ChatConfig {
  const baseSuggestions = [
    "Hello! How can you help me?",
    "Help me write some code",
    "Explain a concept to me",
  ];

  const config: ChatConfig = {
    title: "LLM Playground",
    suggestions: [...baseSuggestions, ...(options.additionalSuggestions || [])],
  };

  if (options.subtitle) {
    config.subtitle = options.subtitle;
  }

  return config;
}
