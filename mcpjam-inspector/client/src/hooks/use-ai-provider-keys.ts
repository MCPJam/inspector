import { useState, useEffect, useCallback } from "react";
import { useByokAllowed } from "@/hooks/use-byok-allowed";

export interface ProviderTokens {
  anthropic: string;
  azure: string;
  azureBaseUrl: string;
  openai: string;
  deepseek: string;
  google: string;
  mistral: string;
  xai: string;
  ollama: string;
  ollamaBaseUrl: string;
  openrouter: string;
  openRouterSelectedModels: string[];
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
  getOpenRouterSelectedModels: () => string[];
  setOpenRouterSelectedModels: (models: string[]) => void;
  getAzureBaseUrl: () => string;
  setAzureBaseUrl: (url: string) => void;
}

const STORAGE_KEY = "mcp-inspector-provider-tokens";

const defaultTokens: ProviderTokens = {
  anthropic: "",
  azure: "",
  azureBaseUrl: "",
  openai: "",
  deepseek: "",
  google: "",
  mistral: "",
  xai: "",
  ollama: "local", // Ollama runs locally, no API key needed
  ollamaBaseUrl: "http://127.0.0.1:11434/api",
  openrouter: "",
  openRouterSelectedModels: [],
};

export function useAiProviderKeys(): useAiProviderKeysReturn {
  // BYOK is sign-in only: guests see empty tokens and no-op setters. When the
  // user signs in mid-session the load effect re-runs and rehydrates from
  // localStorage; on sign-out the same effect resets state back to defaults.
  const allowed = useByokAllowed();
  const [tokens, setTokens] = useState<ProviderTokens>(defaultTokens);
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!allowed) {
      // Sign-out (or initial guest load) clears both in-memory state AND
      // localStorage so the next sign-in on the same browser — possibly a
      // different WorkOS user — cannot silently rehydrate the previous
      // user's keys.
      setTokens(defaultTokens);
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (error) {
        console.warn(
          "Failed to clear provider tokens from localStorage:",
          error,
        );
      }
      setIsInitialized(true);
      return;
    }
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        // Merge a (possibly legacy/partial) payload onto defaults so missing
        // or malformed fields can't leave the state ill-shaped — e.g. an
        // absent openRouterSelectedModels would otherwise make
        // hasToken("openrouter") throw on `.length`.
        const parsed = JSON.parse(stored) as Partial<ProviderTokens>;
        setTokens({
          ...defaultTokens,
          ...parsed,
          openRouterSelectedModels: Array.isArray(
            parsed.openRouterSelectedModels,
          )
            ? parsed.openRouterSelectedModels
            : defaultTokens.openRouterSelectedModels,
        });
      }
    } catch (error) {
      console.warn(
        "Failed to load provider tokens from localStorage:",
        error,
      );
    }
    setIsInitialized(true);
  }, [allowed]);

  useEffect(() => {
    if (!isInitialized || typeof window === "undefined") return;
    if (!allowed) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
    } catch (error) {
      console.warn("Failed to save provider tokens to localStorage:", error);
    }
  }, [tokens, isInitialized, allowed]);

  const setToken = useCallback(
    (provider: keyof ProviderTokens, token: string) => {
      if (!allowed) return;
      setTokens((prev) => ({
        ...prev,
        [provider]: token,
      }));
    },
    [allowed],
  );

  const clearToken = useCallback(
    (provider: keyof ProviderTokens) => {
      if (!allowed) return;
      setTokens((prev) => ({
        ...prev,
        [provider]: "",
      }));
    },
    [allowed],
  );

  const clearAllTokens = useCallback(() => {
    if (!allowed) return;
    setTokens(defaultTokens);
  }, [allowed]);

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

  const setOllamaBaseUrl = useCallback(
    (url: string) => {
      if (!allowed) return;
      setTokens((prev) => ({
        ...prev,
        ollamaBaseUrl: url,
      }));
    },
    [allowed],
  );

  const getAzureBaseUrl = useCallback(() => {
    return tokens.azureBaseUrl || defaultTokens.azureBaseUrl;
  }, [tokens.azureBaseUrl]);

  const setAzureBaseUrl = useCallback(
    (url: string) => {
      if (!allowed) return;
      setTokens((prev) => ({
        ...prev,
        azureBaseUrl: url,
      }));
    },
    [allowed],
  );

  const getOpenRouterSelectedModels = useCallback(() => {
    return (
      tokens.openRouterSelectedModels || defaultTokens.openRouterSelectedModels
    );
  }, [tokens.openRouterSelectedModels]);

  const setOpenRouterSelectedModels = useCallback(
    (models: string[]) => {
      if (!allowed) return;
      setTokens((prev) => ({
        ...prev,
        openRouterSelectedModels: models,
      }));
    },
    [allowed],
  );

  return {
    tokens,
    setToken,
    clearToken,
    clearAllTokens,
    hasToken,
    getToken,
    getOllamaBaseUrl,
    setOllamaBaseUrl,
    getOpenRouterSelectedModels,
    setOpenRouterSelectedModels,
    getAzureBaseUrl,
    setAzureBaseUrl,
  };
}
