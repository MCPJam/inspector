import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "mcp-inspector-selected-model";

export interface UsePersistedModelReturn {
  selectedModelId: string | null;
  setSelectedModelId: (modelId: string | null) => void;
}

/**
 * Hook to persist the user's last selected model ID to localStorage.
 * Returns the selected model ID and a setter function.
 */
export function usePersistedModel(): UsePersistedModelReturn {
  const [selectedModelId, setSelectedModelIdState] = useState<string | null>(
    null,
  );
  const [isInitialized, setIsInitialized] = useState(false);

  // Load the selected model from localStorage on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          setSelectedModelIdState(stored);
        }
      } catch (error) {
        console.warn("Failed to load selected model from localStorage:", error);
      }
      setIsInitialized(true);
    }
  }, []);

  // Save the selected model to localStorage whenever it changes
  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      try {
        if (selectedModelId) {
          localStorage.setItem(STORAGE_KEY, selectedModelId);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch (error) {
        console.warn("Failed to save selected model to localStorage:", error);
      }
    }
  }, [selectedModelId, isInitialized]);

  const setSelectedModelId = useCallback((modelId: string | null) => {
    setSelectedModelIdState(modelId);
  }, []);

  return {
    selectedModelId,
    setSelectedModelId,
  };
}
