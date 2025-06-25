import { AIProvider, SupportedProvider, ProviderConfig } from "./types";
import { providerFactory } from "./providerFactory";

interface ProviderInfo {
  provider: AIProvider | null;
  isValid: boolean;
  apiKey: string;
}

interface StorageKeys {
  [key: string]: string;
}

export class ProviderManager {
  private providers: Map<SupportedProvider, ProviderInfo> = new Map();
  private storageKeys: StorageKeys = {
    anthropic: "claude-api-key",
    openai: "openai-api-key",
    deepseek: "deepseek-api-key"
  };

  constructor() {
    this.initializeProviders();
    this.loadApiKeysFromStorage();
  }

  private initializeProviders() {
    // Initialize with null providers
    this.providers.set("anthropic", { provider: null, isValid: false, apiKey: "" });
    this.providers.set("openai", { provider: null, isValid: false, apiKey: "" });
    this.providers.set("deepseek", { provider: null, isValid: false, apiKey: "" });
  }

  private loadApiKeysFromStorage() {
    this.providers.forEach((_, providerType) => {
      try {
        const storageKey = this.storageKeys[providerType];
        const storedApiKey = localStorage.getItem(storageKey) || "";
        if (storedApiKey && this.validateApiKey(providerType, storedApiKey)) {
          this.setApiKey(providerType, storedApiKey);
        }
      } catch (error) {
        console.warn(`Failed to load ${providerType} API key from localStorage:`, error);
      }
    });
  }

  private validateApiKey(providerType: SupportedProvider, apiKey: string): boolean {
    switch (providerType) {
      case "anthropic":
        return /^sk-ant-api03-[A-Za-z0-9_-]+$/.test(apiKey) && apiKey.length > 20;
      case "openai":
        // Basic validation - just check it starts with sk- and has reasonable length
        return apiKey.startsWith("sk-") && apiKey.length > 20;
      case "deepseek":
        // Add DeepSeek validation pattern when implemented
        return apiKey.length > 10; // Basic validation for now
      default:
        return false;
    }
  }

  private createProvider(providerType: SupportedProvider, apiKey: string): AIProvider | null {
    try {
      const config: ProviderConfig = {
        apiKey,
        dangerouslyAllowBrowser: true,
      };
      return providerFactory.createProvider(providerType, config);
    } catch (error) {
      console.error(`Failed to create ${providerType} provider:`, error);
      return null;
    }
  }

  setApiKey(providerType: SupportedProvider, apiKey: string): boolean {
    const isValid = this.validateApiKey(providerType, apiKey);
    let provider: AIProvider | null = null;

    if (isValid && apiKey) {
      provider = this.createProvider(providerType, apiKey);
      
      // Save to localStorage if provider creation succeeded
      if (provider) {
        try {
          const storageKey = this.storageKeys[providerType];
          localStorage.setItem(storageKey, apiKey);
        } catch (error) {
          console.warn(`Failed to save ${providerType} API key to localStorage:`, error);
        }
      }
    } else if (!apiKey) {
      // Clear from localStorage if empty key
      try {
        const storageKey = this.storageKeys[providerType];
        localStorage.removeItem(storageKey);
      } catch (error) {
        console.warn(`Failed to remove ${providerType} API key from localStorage:`, error);
      }
    }

    this.providers.set(providerType, {
      provider,
      isValid: isValid && provider !== null,
      apiKey
    });

    return isValid && provider !== null;
  }

  getProvider(providerType: SupportedProvider): AIProvider | null {
    return this.providers.get(providerType)?.provider || null;
  }

  isProviderReady(providerType: SupportedProvider): boolean {
    const info = this.providers.get(providerType);
    return info?.isValid && info?.provider !== null || false;
  }

  getApiKey(providerType: SupportedProvider): string {
    return this.providers.get(providerType)?.apiKey || "";
  }

  getAllProviderStatus(): Record<SupportedProvider, { isValid: boolean; hasApiKey: boolean }> {
    const status: Record<string, { isValid: boolean; hasApiKey: boolean }> = {};
    
    this.providers.forEach((info, providerType) => {
      status[providerType] = {
        isValid: info.isValid,
        hasApiKey: info.apiKey.length > 0
      };
    });

    return status as Record<SupportedProvider, { isValid: boolean; hasApiKey: boolean }>;
  }

  // Get the first available provider (for backward compatibility)
  getDefaultProvider(): AIProvider | null {
    // Try Anthropic first, then others
    const priority: SupportedProvider[] = ["anthropic", "openai", "deepseek"];
    
    for (const providerType of priority) {
      const provider = this.getProvider(providerType);
      if (provider && this.isProviderReady(providerType)) {
        return provider;
      }
    }
    
    return null;
  }

  // Get the provider type for the default provider
  getDefaultProviderType(): SupportedProvider | null {
    const priority: SupportedProvider[] = ["anthropic", "openai", "deepseek"];
    
    for (const providerType of priority) {
      if (this.isProviderReady(providerType)) {
        return providerType;
      }
    }
    
    return null;
  }

  clearApiKey(providerType: SupportedProvider): void {
    this.setApiKey(providerType, "");
  }

  clearAllApiKeys(): void {
    this.providers.forEach((_, providerType) => {
      this.clearApiKey(providerType);
    });
  }
}

// Export singleton instance
export const providerManager = new ProviderManager();