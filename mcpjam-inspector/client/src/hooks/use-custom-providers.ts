import { useState, useEffect, useCallback } from "react";
import type { CustomProvider } from "@mcpjam/sdk";

const STORAGE_KEY = "mcp-inspector-custom-providers";

export interface UseCustomProvidersReturn {
  customProviders: CustomProvider[];
  addCustomProvider: (provider: CustomProvider) => void;
  updateCustomProvider: (index: number, provider: CustomProvider) => void;
  removeCustomProvider: (index: number) => void;
  getCustomProviderByName: (name: string) => CustomProvider | undefined;
}

export function useCustomProviders(): UseCustomProvidersReturn {
  const [customProviders, setCustomProviders] = useState<CustomProvider[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as CustomProvider[];
          setCustomProviders(parsed);
        }
      } catch (error) {
        console.warn(
          "Failed to load custom providers from localStorage:",
          error,
        );
      }
      setIsInitialized(true);
    }
  }, []);

  // Save to localStorage whenever providers change
  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(customProviders));
      } catch (error) {
        console.warn(
          "Failed to save custom providers to localStorage:",
          error,
        );
      }
    }
  }, [customProviders, isInitialized]);

  const addCustomProvider = useCallback((provider: CustomProvider) => {
    setCustomProviders((prev) => [...prev, provider]);
  }, []);

  const updateCustomProvider = useCallback(
    (index: number, provider: CustomProvider) => {
      setCustomProviders((prev) => {
        const next = [...prev];
        next[index] = provider;
        return next;
      });
    },
    [],
  );

  const removeCustomProvider = useCallback((index: number) => {
    setCustomProviders((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const getCustomProviderByName = useCallback(
    (name: string) => {
      return customProviders.find((p) => p.name === name);
    },
    [customProviders],
  );

  return {
    customProviders,
    addCustomProvider,
    updateCustomProvider,
    removeCustomProvider,
    getCustomProviderByName,
  };
}
