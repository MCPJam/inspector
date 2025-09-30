import { usePostHog } from "posthog-js/react";

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    format: string;
    family: string;
    families: string[] | null;
    parameter_size: string;
    quantization_level: string;
  };
}

interface OllamaModelsResponse {
  models: OllamaModel[];
}

interface OllamaShowResponse {
  capabilities: string[];
}

export class OllamaClient {
  private baseUrl: string;
  private static normalizeBaseUrl(raw: string): string {
    const trimmed = (raw || "").replace(/\/+$/, "");
    return /\/api$/.test(trimmed) ? trimmed : `${trimmed}/api`;
  }

  constructor(baseUrl: string = "http://localhost:11434/api") {
    this.baseUrl = OllamaClient.normalizeBaseUrl(baseUrl);
  }

  setBaseUrl(baseUrl: string) {
    this.baseUrl = OllamaClient.normalizeBaseUrl(baseUrl);
  }

  async isOllamaRunning(): Promise<boolean> {
    const posthog = usePostHog();
    try {
      const response = await fetch(`${this.baseUrl}/version`, {
        method: "GET",
        signal: AbortSignal.timeout(3000), // 3 second timeout
      });

      posthog.capture("ollama_running");

      return response.ok;
    } catch (error) {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });

      if (!response.ok) {
        return [];
      }

      const data: OllamaModelsResponse = await response.json();
      return data.models.map((model) => model.name);
    } catch (error) {
      console.warn("Failed to fetch Ollama models:", error);
      return [];
    }
  }

  async checkModelExists(modelName: string): Promise<boolean> {
    const availableModels = await this.getAvailableModels();
    return availableModels.some(
      (model) => model === modelName || model.startsWith(`${modelName}:`),
    );
  }

  async getFilteredAvailableModels(
    supportedModels: string[],
  ): Promise<string[]> {
    const availableModels = await this.getAvailableModels();

    return supportedModels.filter((supportedModel) =>
      availableModels.some(
        (availableModel) =>
          availableModel === supportedModel ||
          availableModel.startsWith(`${supportedModel}:`),
      ),
    );
  }

  async getToolCapableModels(): Promise<string[]> {
    const models = await this.getAvailableModels();
    if (models.length === 0) return [];

    const checked = await Promise.all(
      models.map(async (modelName): Promise<string | null> => {
        try {
          const response = await fetch(`${this.baseUrl}/show`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: modelName }),
            signal: AbortSignal.timeout(5000),
          });

          if (!response.ok) return null;

          const data: OllamaShowResponse = await response.json();
          return data.capabilities.includes("tools") ? modelName : null;
        } catch {
          return null;
        }
      }),
    );

    return checked.flatMap((name) => (name ? [name] : []));
  }
}

// Create a singleton instance
export const ollamaClient = new OllamaClient();

// Utility functions
export const detectOllamaModels = async (
  baseUrl?: string,
): Promise<{
  isRunning: boolean;
  availableModels: string[];
}> => {
  // Use a temporary client with the provided base URL if given
  const client = baseUrl ? new OllamaClient(baseUrl) : ollamaClient;

  const isRunning = await client.isOllamaRunning();

  if (!isRunning) {
    return { isRunning: false, availableModels: [] };
  }

  const availableModels = await client.getAvailableModels();

  return {
    isRunning: true,
    availableModels,
  };
};

// Utility to fetch only tool-capable models using a provided base URL (if any)
export const detectOllamaToolCapableModels = async (
  baseUrl?: string,
): Promise<string[]> => {
  const client = baseUrl ? new OllamaClient(baseUrl) : ollamaClient;
  return client.getToolCapableModels();
};
