import { useState, useCallback, useEffect } from "react";
import { InspectorConfig } from "@/lib/configurationTypes";
import { AuthDebuggerState } from "@/lib/auth-types";
import { initializeInspectorConfig } from "@/utils/configUtils";
import { SupportedProvider } from "@/lib/providers";

const CONFIG_LOCAL_STORAGE_KEY = "inspectorConfig_v1";
const CLAUDE_API_KEY_STORAGE_KEY = "claude-api-key";
const OPENAI_API_KEY_STORAGE_KEY = "openai-api-key";
const PROVIDER_STORAGE_KEY = "selected-provider";

// Validate API key format based on provider
const validateApiKey = (key: string, provider: SupportedProvider): boolean => {
  if (!key || key.length === 0) return false;
  
  switch (provider) {
    case "anthropic": {
      const claudeApiKeyPattern = /^sk-ant-api03-[A-Za-z0-9_-]+$/;
      return claudeApiKeyPattern.test(key) && key.length > 20;
    }
    case "openai": {
      const openaiApiKeyPattern = /^sk-[A-Za-z0-9_-]+$/;
      return openaiApiKeyPattern.test(key) && key.length > 20;
    }
    default:
      return false;
  }
};

export const useConfigState = () => {
  const [config, setConfig] = useState<InspectorConfig>(() =>
    initializeInspectorConfig(CONFIG_LOCAL_STORAGE_KEY),
  );

  const [bearerToken, setBearerToken] = useState<string>(() => {
    return localStorage.getItem("lastBearerToken") || "";
  });

  const [headerName, setHeaderName] = useState<string>(() => {
    return localStorage.getItem("lastHeaderName") || "";
  });

  const [selectedProvider, setSelectedProvider] = useState<SupportedProvider>(() => {
    try {
      const storedProvider = localStorage.getItem(PROVIDER_STORAGE_KEY) as SupportedProvider;
      return storedProvider || "anthropic";
    } catch (error) {
      console.warn("Failed to load provider from localStorage:", error);
      return "anthropic";
    }
  });

  const [claudeApiKey, setClaudeApiKey] = useState<string>(() => {
    try {
      const storedApiKey = localStorage.getItem(CLAUDE_API_KEY_STORAGE_KEY) || "";
      if (storedApiKey && validateApiKey(storedApiKey, "anthropic")) {
        return storedApiKey;
      }
    } catch (error) {
      console.warn("Failed to load Claude API key from localStorage:", error);
    }
    return "";
  });

  const [openaiApiKey, setOpenaiApiKey] = useState<string>(() => {
    try {
      const storedApiKey = localStorage.getItem(OPENAI_API_KEY_STORAGE_KEY) || "";
      if (storedApiKey && validateApiKey(storedApiKey, "openai")) {
        return storedApiKey;
      }
    } catch (error) {
      console.warn("Failed to load OpenAI API key from localStorage:", error);
    }
    return "";
  });

  // Auth debugger state
  const [authState, setAuthState] = useState<AuthDebuggerState>({
    isInitiatingAuth: false,
    oauthTokens: null,
    loading: true,
    oauthStep: "metadata_discovery",
    oauthMetadata: null,
    oauthClientInfo: null,
    authorizationUrl: null,
    authorizationCode: "",
    latestError: null,
    statusMessage: null,
    validationError: null,
    resourceMetadata: null,
    resourceMetadataError: null,
    authServerUrl: null,
  });

  // Helper function to update specific auth state properties
  const updateAuthState = useCallback((updates: Partial<AuthDebuggerState>) => {
    setAuthState((prev) => ({ ...prev, ...updates }));
  }, []);

  // Get current API key based on selected provider
  const getCurrentApiKey = useCallback(() => {
    return selectedProvider === "openai" ? openaiApiKey : claudeApiKey;
  }, [selectedProvider, openaiApiKey, claudeApiKey]);

  // Update provider
  const updateProvider = useCallback((newProvider: SupportedProvider) => {
    setSelectedProvider(newProvider);
    try {
      localStorage.setItem(PROVIDER_STORAGE_KEY, newProvider);
    } catch (error) {
      console.warn("Failed to save provider to localStorage:", error);
    }
  }, []);

  // Update Claude API key with validation and storage
  const updateClaudeApiKey = useCallback((newApiKey: string) => {
    setClaudeApiKey(newApiKey);

    try {
      if (newApiKey && validateApiKey(newApiKey, "anthropic")) {
        localStorage.setItem(CLAUDE_API_KEY_STORAGE_KEY, newApiKey);
      } else if (!newApiKey) {
        localStorage.removeItem(CLAUDE_API_KEY_STORAGE_KEY);
      }
    } catch (error) {
      console.warn("Failed to save Claude API key to localStorage:", error);
    }
  }, []);

  // Update OpenAI API key with validation and storage
  const updateOpenaiApiKey = useCallback((newApiKey: string) => {
    setOpenaiApiKey(newApiKey);

    try {
      if (newApiKey && validateApiKey(newApiKey, "openai")) {
        localStorage.setItem(OPENAI_API_KEY_STORAGE_KEY, newApiKey);
      } else if (!newApiKey) {
        localStorage.removeItem(OPENAI_API_KEY_STORAGE_KEY);
      }
    } catch (error) {
      console.warn("Failed to save OpenAI API key to localStorage:", error);
    }
  }, []);

  // Update current API key based on selected provider
  const updateCurrentApiKey = useCallback((newApiKey: string) => {
    if (selectedProvider === "openai") {
      updateOpenaiApiKey(newApiKey);
    } else {
      updateClaudeApiKey(newApiKey);
    }
  }, [selectedProvider, updateOpenaiApiKey, updateClaudeApiKey]);

  // Persist config to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem(CONFIG_LOCAL_STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  // Persist bearer token whenever it changes
  useEffect(() => {
    localStorage.setItem("lastBearerToken", bearerToken);
  }, [bearerToken]);

  // Persist header name whenever it changes
  useEffect(() => {
    localStorage.setItem("lastHeaderName", headerName);
  }, [headerName]);

  // Ensure default hash is set
  useEffect(() => {
    if (!window.location.hash) {
      window.location.hash = "tools";
    }
  }, []);

  return {
    config,
    setConfig,
    bearerToken,
    setBearerToken,
    headerName,
    setHeaderName,
    selectedProvider,
    updateProvider,
    claudeApiKey,
    updateClaudeApiKey,
    openaiApiKey,
    updateOpenaiApiKey,
    getCurrentApiKey,
    updateCurrentApiKey,
    authState,
    updateAuthState,
    validateApiKey: (key: string) => validateApiKey(key, selectedProvider),
  };
};
