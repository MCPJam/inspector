import { useState, useEffect, useCallback } from "react";
import type { ComboboxItem } from "@/components/ui/combobox";

interface OpenRouterModel {
  id: string;
  name: string;
  supported_parameters: string[];
}

export function useOpenRouterModels() {
  const [models, setModels] = useState<ComboboxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        "https://openrouter.ai/api/v1/models?supported_parameters=tools",
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.statusText}`);
      }

      const response_data = await response.json();

      // The models are in response_data.data array
      const data: OpenRouterModel[] = response_data.data || [];

      // Transform the API response to match our combobox format
      const transformedModels: ComboboxItem[] = data.map((model) => ({
        value: model.id,
        label: model.name,
        description: model.id,
      }));

      // Sort models alphabetically by label
      transformedModels.sort((a, b) => a.label.localeCompare(b.label));

      setModels(transformedModels);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to fetch models";
      setError(errorMessage);
      console.error("Error fetching OpenRouter models:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  return {
    models,
    loading,
    error,
    refetch: fetchModels,
  };
}
