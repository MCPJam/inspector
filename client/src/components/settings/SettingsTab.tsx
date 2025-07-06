import React, { useState, useEffect } from "react";
import { useToast } from "@/lib/hooks/useToast";
import { providerManager, SupportedProvider } from "@/lib/providers";
import {
  ProvidersState,
  ProviderConfig,
  SettingsTabProps,
} from "@/components/settings/types";
import ProviderSection from "./ApiKeyManagementSection";
import { ConnectionPersistence } from "@/components/ConnectionPersistence";
import { useServerState } from "@/hooks/useServerState";

const PROVIDERS: Record<SupportedProvider, ProviderConfig> = {
  anthropic: {
    name: "anthropic",
    displayName: "Anthropic (Claude)",
    placeholder: "Enter your Claude API key (sk-ant-api03-...)",
    description: "Required for Claude AI chat functionality",
  },
  openai: {
    name: "openai",
    displayName: "OpenAI",
    placeholder: "Enter your OpenAI API key (sk-...)",
    description: "Required for GPT models and OpenAI features",
  },
  ollama: {
    name: "ollama",
    displayName: "Ollama",
    placeholder:
      "Enter Ollama host URL (optional, defaults to http://127.0.0.1:11434)",
    description:
      "Local Ollama installation - requires Ollama to be running. 📥 Download from https://ollama.com/download • 🔧 Pull tool-calling models from https://ollama.com/search?c=tools • 🔄 Models appear dynamically in chat",
  },
};

const SettingsTab: React.FC<SettingsTabProps> = ({ disabled = false }) => {
  const [apiKeys, setApiKeys] = useState<ProvidersState>({
    anthropic: { key: "", isValid: false, showKey: false },
    openai: { key: "", isValid: false, showKey: false },
    ollama: { key: "", isValid: false, showKey: false },
  });
  const [collapsedSections, setCollapsedSections] = useState<
    Record<string, boolean>
  >({});
  const { toast } = useToast();
  const { serverConfigs, setServerConfigs } = useServerState();

  const handleConnectionsImported = (importedConnections: Record<string, any>) => {
    setServerConfigs(importedConnections);
    toast({
      title: "Connections Imported",
      description: `Successfully imported ${Object.keys(importedConnections).length} connection(s).`,
      variant: "default",
    });
  };

  // Load API keys from ProviderManager on mount
  useEffect(() => {
    const newApiKeys = { ...apiKeys };

    Object.keys(PROVIDERS).forEach((providerName) => {
      const provider = providerName as SupportedProvider;
      const apiKey = providerManager.getApiKey(provider);
      const isValid = providerManager.isProviderReady(provider);

      newApiKeys[provider] = {
        key: apiKey,
        isValid,
        showKey: false,
      };

      // Collapse sections that have valid keys
      if (isValid) {
        setCollapsedSections((prev) => ({ ...prev, [providerName]: true }));
      }
    });

    setApiKeys(newApiKeys);
  }, []);

  const handleApiKeyChange = (
    providerName: SupportedProvider,
    value: string,
  ) => {
    const config = PROVIDERS[providerName];
    const isValid = providerManager.setApiKey(providerName, value);

    setApiKeys((prev) => ({
      ...prev,
      [providerName]: {
        ...prev[providerName],
        key: value,
        isValid,
      },
    }));

    if (isValid) {
      setCollapsedSections((prev) => ({ ...prev, [providerName]: true }));
      toast({
        title: "API Key Set",
        description: `Your ${config.displayName} API key has been saved and configured successfully.`,
        variant: "default",
      });
    } else {
      setCollapsedSections((prev) => ({ ...prev, [providerName]: false }));
    }
  };

  const clearApiKey = (providerName: SupportedProvider) => {
    const config = PROVIDERS[providerName];

    providerManager.clearApiKey(providerName);

    setApiKeys((prev) => ({
      ...prev,
      [providerName]: {
        ...prev[providerName],
        key: "",
        isValid: false,
      },
    }));

    setCollapsedSections((prev) => ({ ...prev, [providerName]: false }));

    toast({
      title: "API Key Cleared",
      description: `Your ${config.displayName} API key has been removed from storage.`,
      variant: "default",
    });
  };

  const toggleShowKey = (providerName: SupportedProvider) => {
    setApiKeys((prev) => ({
      ...prev,
      [providerName]: {
        ...prev[providerName],
        showKey: !prev[providerName].showKey,
      },
    }));
  };

  const toggleCollapse = (providerName: SupportedProvider) => {
    setCollapsedSections((prev) => ({
      ...prev,
      [providerName]: !prev[providerName],
    }));
  };

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-4">
        <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-200 mb-6">
          API Key Management
        </h2>
        <p className="text-slate-600 dark:text-slate-400 mb-6">
          Configure your API keys for different AI providers. Keys are stored
          securely in your browser's local storage.
        </p>

        {Object.entries(PROVIDERS).map(([providerName, config]) => (
          <ProviderSection
            key={providerName}
            providerName={providerName as SupportedProvider}
            config={config}
            keyData={apiKeys[providerName as SupportedProvider]}
            isCollapsed={
              collapsedSections[providerName] &&
              apiKeys[providerName as SupportedProvider].isValid
            }
            disabled={disabled}
            onApiKeyChange={handleApiKeyChange}
            onClearApiKey={clearApiKey}
            onToggleShowKey={toggleShowKey}
            onToggleCollapse={toggleCollapse}
          />
        ))}
      </div>

      {/* Connection Persistence Section */}
      <div className="border-t border-slate-200 dark:border-slate-700 pt-6">
        <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-200 mb-6">
          Connection Persistence
        </h2>
        <p className="text-slate-600 dark:text-slate-400 mb-6">
          Save, export, and import your MCP server connections for backup and sharing across environments.
        </p>
        <ConnectionPersistence
          connections={serverConfigs}
          onConnectionsImported={handleConnectionsImported}
        />
      </div>
    </div>
  );
};

export default SettingsTab;
