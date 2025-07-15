import React, { useState, useEffect } from "react";
import { useToast } from "@/lib/hooks/useToast";
import { providerManager, SupportedProvider } from "@/lib/providers";
import {
  ProvidersState,
  ProviderConfig,
  SettingsTabProps,
} from "@/components/settings/types";
import ProviderCard from "./ProviderCard";

import ClaudeLogo from "./assests/logos/claude.svg";
import OpenAILogo from "./assests/logos/openai.svg";
import OllamaLogo from "./assests/logos/ollama.svg";

const PROVIDERS: Record<SupportedProvider, ProviderConfig> = {
  anthropic: {
    name: "anthropic",
    displayName: "Anthropic (Claude)",
    placeholder: "sk-ant-…",
    description: "Enable Claude AI chat functionality",
    logo: ClaudeLogo,
  },
  openai: {
    name: "openai",
    displayName: "OpenAI",
    placeholder: "sk-…",
    description: "Enable GPT models & OpenAI features",
    logo: OpenAILogo,
  },
  ollama: {
    name: "ollama",
    displayName: "Ollama",
    placeholder: "http://127.0.0.1:11434",
    description:
      "Local Ollama—requires Ollama running. Models load dynamically.",
    logo: OllamaLogo,
  },
};

const SettingsTab: React.FC<SettingsTabProps> = ({ disabled = false }) => {
  const [apiKeys, setApiKeys] = useState<ProvidersState>(() =>
    Object.keys(PROVIDERS).reduce((acc, p) => {
      acc[p as SupportedProvider] = {
        key: "",
        isValid: false,
        showKey: false,
      };
      return acc;
    }, {} as ProvidersState),
  );
  const { toast } = useToast();

  // load saved keys
  useEffect(() => {
    Object.keys(PROVIDERS).forEach((prov) => {
      const provider = prov as SupportedProvider;
      const key = providerManager.getApiKey(provider);
      const valid = providerManager.isProviderReady(provider);
      setApiKeys((prev) => ({
        ...prev,
        [provider]: { key, isValid: valid, showKey: false },
      }));
    });
  }, []);

  const handleApiKeyChange = (provider: SupportedProvider, value: string) => {
    const cfg = PROVIDERS[provider];
    const valid = providerManager.setApiKey(provider, value);
    setApiKeys((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], key: value, isValid: valid },
    }));
    toast({
      title: valid
        ? `${cfg.displayName} key saved`
        : `${cfg.displayName} key invalid`,
      description: valid
        ? `Your ${cfg.displayName} API key was saved successfully.`
        : `Unable to validate your ${cfg.displayName} key.`,
    });
  };

  const handleClear = (provider: SupportedProvider) => {
    const cfg = PROVIDERS[provider];
    providerManager.clearApiKey(provider);
    setApiKeys((p) => ({
      ...p,
      [provider]: { ...p[provider], key: "", isValid: false },
    }));
    toast({ title: `${cfg.displayName} key cleared` });
  };

  const toggleShow = (provider: SupportedProvider) => {
    setApiKeys((p) => ({
      ...p,
      [provider]: { ...p[provider], showKey: !p[provider].showKey },
    }));
  };

  return (
    <div className="space-y-8 p-8">
      <h2 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
        API Key Management
      </h2>
      <p className="text-gray-600 dark:text-gray-400 max-w-2xl">
        Enter your API keys below. They’re stored securely in local storage.
      </p>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {Object.entries(PROVIDERS).map(([prov, cfg]) => (
          <ProviderCard
            key={prov}
            provider={prov as SupportedProvider}
            config={cfg}
            data={apiKeys[prov as SupportedProvider]}
            disabled={disabled}
            onChange={handleApiKeyChange}
            onClear={handleClear}
            onToggleShow={toggleShow}
          />
        ))}
      </div>
    </div>
  );
};

export default SettingsTab;
