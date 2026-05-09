import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "mcp-inspector-provider-tokens";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/api";

type LegacyProviderTokens = {
  ollamaBaseUrl?: string;
};

export function useOllamaConfig() {
  const [ollamaBaseUrl, setOllamaBaseUrlState] = useState(
    DEFAULT_OLLAMA_BASE_URL,
  );
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as LegacyProviderTokens;
        if (typeof parsed.ollamaBaseUrl === "string" && parsed.ollamaBaseUrl) {
          setOllamaBaseUrlState(parsed.ollamaBaseUrl);
        }
      }
    } catch (error) {
      console.warn("Failed to load Ollama config from localStorage:", error);
    } finally {
      setIsInitialized(true);
    }
  }, []);

  useEffect(() => {
    if (!isInitialized || typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      const parsed = stored ? (JSON.parse(stored) as LegacyProviderTokens) : {};
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...parsed,
          ollama: "local",
          ollamaBaseUrl,
        }),
      );
    } catch (error) {
      console.warn("Failed to save Ollama config to localStorage:", error);
    }
  }, [isInitialized, ollamaBaseUrl]);

  const getOllamaBaseUrl = useCallback(
    () => ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
    [ollamaBaseUrl],
  );

  const setOllamaBaseUrl = useCallback((url: string) => {
    setOllamaBaseUrlState(url || DEFAULT_OLLAMA_BASE_URL);
  }, []);

  return {
    ollamaBaseUrl,
    getOllamaBaseUrl,
    setOllamaBaseUrl,
  };
}
