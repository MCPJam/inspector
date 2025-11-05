import { useState, useEffect, useCallback } from "react";

export interface ProviderTokens {
  anthropic: string;
  openai: string;
  deepseek: string;
  google: string;
  mistral: string;
  ollama: string;
  ollamaBaseUrl: string;
  litellm: string;
  litellmBaseUrl: string;
  litellmModelAlias: string;
  openrouter: string;
  openRouterSelectedModels: string[];
  bedrock: string;
  bedrockRegion: string;
  bedrockSecretKey: string;
}

export interface useAiProviderKeysReturn {
  tokens: ProviderTokens;
  setToken: (provider: keyof ProviderTokens, token: string) => void;
  clearToken: (provider: keyof ProviderTokens) => void;
  clearAllTokens: () => void;
  hasToken: (provider: keyof ProviderTokens) => boolean;
  getToken: (provider: keyof ProviderTokens) => string;
  getOllamaBaseUrl: () => string;
  setOllamaBaseUrl: (url: string) => void;
  getLiteLLMBaseUrl: () => string;
  setLiteLLMBaseUrl: (url: string) => void;
  getLiteLLMModelAlias: () => string;
  setLiteLLMModelAlias: (alias: string) => void;
  getOpenRouterSelectedModels: () => string[];
  setOpenRouterSelectedModels: (models: string[]) => void;
  getBedrockRegion: () => string;
  setBedrockRegion: (region: string) => void;
  getBedrockSecretKey: () => string;
  setBedrockSecretKey: (key: string) => void;
}

const STORAGE_KEY = "mcp-inspector-provider-tokens";

const defaultTokens: ProviderTokens = {
  anthropic: "",
  openai: "",
  deepseek: "",
  google: "",
  mistral: "",
  ollama: "local", // Ollama runs locally, no API key needed
  ollamaBaseUrl: "http://localhost:11434/api",
  litellm: "", // LiteLLM API key (optional, depends on proxy setup)
  litellmBaseUrl: "http://localhost:4000", // Default LiteLLM proxy URL
  litellmModelAlias: "", // Model name/alias to use with LiteLLM
  openrouter: "",
  openRouterSelectedModels: [],
  bedrock: "", // AWS Access Key ID
  bedrockRegion: "us-east-1", // Default AWS region
  bedrockSecretKey: "", // AWS Secret Access Key
};

export function useAiProviderKeys(): useAiProviderKeysReturn {
  const [tokens, setTokens] = useState<ProviderTokens>(defaultTokens);
  const [isInitialized, setIsInitialized] = useState(false);

  // Load tokens from localStorage on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsedTokens = JSON.parse(stored) as ProviderTokens;
          setTokens(parsedTokens);
        }
      } catch (error) {
        console.warn(
          "Failed to load provider tokens from localStorage:",
          error,
        );
      }
      setIsInitialized(true);
    }
  }, []);

  // Save tokens to localStorage whenever they change
  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
      } catch (error) {
        console.warn("Failed to save provider tokens to localStorage:", error);
      }
    }
  }, [tokens, isInitialized]);

  const setToken = useCallback(
    (provider: keyof ProviderTokens, token: string) => {
      setTokens((prev) => ({
        ...prev,
        [provider]: token,
      }));
    },
    [],
  );

  const clearToken = useCallback((provider: keyof ProviderTokens) => {
    setTokens((prev) => ({
      ...prev,
      [provider]: "",
    }));
  }, []);

  const clearAllTokens = useCallback(() => {
    setTokens(defaultTokens);
  }, []);

  const hasToken = useCallback(
    (provider: keyof ProviderTokens) => {
      const value = tokens[provider];
      if (provider === "openrouter") {
        // For OpenRouter, check both API key and selected models
        return (
          Boolean(tokens.openrouter?.trim()) &&
          tokens.openRouterSelectedModels.length > 0
        );
      }
      if (provider === "bedrock") {
        // For Bedrock, check both access key and secret key
        return (
          Boolean(tokens.bedrock?.trim()) &&
          Boolean(tokens.bedrockSecretKey?.trim())
        );
      }
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      return Boolean(value?.trim());
    },
    [tokens],
  );

  const getToken = useCallback(
    (provider: keyof ProviderTokens) => {
      const value = tokens[provider];
      if (Array.isArray(value)) {
        return value.join(", ");
      }
      return value || "";
    },
    [tokens],
  );

  const getOllamaBaseUrl = useCallback(() => {
    return tokens.ollamaBaseUrl || defaultTokens.ollamaBaseUrl;
  }, [tokens.ollamaBaseUrl]);

  const setOllamaBaseUrl = useCallback((url: string) => {
    setTokens((prev) => ({
      ...prev,
      ollamaBaseUrl: url,
    }));
  }, []);

  const getLiteLLMBaseUrl = useCallback(() => {
    return tokens.litellmBaseUrl || defaultTokens.litellmBaseUrl;
  }, [tokens.litellmBaseUrl]);

  const setLiteLLMBaseUrl = useCallback((url: string) => {
    setTokens((prev) => ({
      ...prev,
      litellmBaseUrl: url,
    }));
  }, []);

  const getLiteLLMModelAlias = useCallback(() => {
    return tokens.litellmModelAlias || defaultTokens.litellmModelAlias;
  }, [tokens.litellmModelAlias]);

  const setLiteLLMModelAlias = useCallback((alias: string) => {
    setTokens((prev) => ({
      ...prev,
      litellmModelAlias: alias,
    }));
  }, []);

  const getOpenRouterSelectedModels = useCallback(() => {
    return (
      tokens.openRouterSelectedModels || defaultTokens.openRouterSelectedModels
    );
  }, [tokens.openRouterSelectedModels]);

  const setOpenRouterSelectedModels = useCallback((models: string[]) => {
    setTokens((prev) => ({
      ...prev,
      openRouterSelectedModels: models,
    }));
  }, []);

  const getBedrockRegion = useCallback(() => {
    return tokens.bedrockRegion || defaultTokens.bedrockRegion;
  }, [tokens.bedrockRegion]);

  const setBedrockRegion = useCallback((region: string) => {
    setTokens((prev) => ({
      ...prev,
      bedrockRegion: region,
    }));
  }, []);

  const getBedrockSecretKey = useCallback(() => {
    return tokens.bedrockSecretKey || "";
  }, [tokens.bedrockSecretKey]);

  const setBedrockSecretKey = useCallback((key: string) => {
    setTokens((prev) => ({
      ...prev,
      bedrockSecretKey: key,
    }));
  }, []);

  return {
    tokens,
    setToken,
    clearToken,
    clearAllTokens,
    hasToken,
    getToken,
    getOllamaBaseUrl,
    setOllamaBaseUrl,
    getLiteLLMBaseUrl,
    setLiteLLMBaseUrl,
    getLiteLLMModelAlias,
    setLiteLLMModelAlias,
    getOpenRouterSelectedModels,
    setOpenRouterSelectedModels,
    getBedrockRegion,
    setBedrockRegion,
    getBedrockSecretKey,
    setBedrockSecretKey,
  };
}
