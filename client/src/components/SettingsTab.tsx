import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eye, EyeOff, Key, CheckCircle, ChevronRight, AlertCircle } from "lucide-react";
import { useToast } from "@/lib/hooks/useToast";
import { providerManager, SupportedProvider } from "@/lib/providers";

interface SettingsTabProps {
  disabled?: boolean;
}

interface ApiKeyData {
  key: string;
  isValid: boolean;
  showKey: boolean;
}

interface ApiKeysState {
  anthropic: ApiKeyData;
  openai: ApiKeyData;
  deepseek: ApiKeyData;
}

interface ProviderConfig {
  name: SupportedProvider;
  displayName: string;
  placeholder: string;
  description: string;
}

const PROVIDERS: Record<SupportedProvider, ProviderConfig> = {
  anthropic: {
    name: "anthropic",
    displayName: "Anthropic (Claude)",
    placeholder: "Enter your Claude API key (sk-ant-api03-...)",
    description: "Required for Claude AI chat functionality"
  },
  openai: {
    name: "openai",
    displayName: "OpenAI",
    placeholder: "Enter your OpenAI API key (sk-...)",
    description: "Required for GPT models and OpenAI features"
  },
  deepseek: {
    name: "deepseek",
    displayName: "DeepSeek",
    placeholder: "Enter your DeepSeek API key",
    description: "Required for DeepSeek AI models (coming soon)"
  }
};

const SettingsTab: React.FC<SettingsTabProps> = ({
  disabled = false,
}) => {
  const [apiKeys, setApiKeys] = useState<ApiKeysState>({
    anthropic: { key: "", isValid: false, showKey: false },
    openai: { key: "", isValid: false, showKey: false },
    deepseek: { key: "", isValid: false, showKey: false }
  });
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const { toast } = useToast();

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
        showKey: false
      };
      
      // Collapse sections that have valid keys
      if (isValid) {
        setCollapsedSections(prev => ({ ...prev, [providerName]: true }));
      }
    });
    
    setApiKeys(newApiKeys);
  }, []);

  const handleApiKeyChange = (providerName: SupportedProvider, value: string) => {
    const config = PROVIDERS[providerName];
    const isValid = providerManager.setApiKey(providerName, value);
    
    setApiKeys(prev => ({
      ...prev,
      [providerName]: {
        ...prev[providerName],
        key: value,
        isValid
      }
    }));

    if (isValid) {
      setCollapsedSections(prev => ({ ...prev, [providerName]: true }));
      toast({
        title: "API Key Set",
        description: `Your ${config.displayName} API key has been saved and configured successfully.`,
        variant: "default",
      });
    } else {
      setCollapsedSections(prev => ({ ...prev, [providerName]: false }));
    }
  };

  const clearApiKey = (providerName: SupportedProvider) => {
    const config = PROVIDERS[providerName];
    
    providerManager.clearApiKey(providerName);
    
    setApiKeys(prev => ({
      ...prev,
      [providerName]: {
        ...prev[providerName],
        key: "",
        isValid: false
      }
    }));
    
    setCollapsedSections(prev => ({ ...prev, [providerName]: false }));
    
    toast({
      title: "API Key Cleared",
      description: `Your ${config.displayName} API key has been removed from storage.`,
      variant: "default",
    });
  };

  const toggleShowKey = (providerName: SupportedProvider) => {
    setApiKeys(prev => ({
      ...prev,
      [providerName]: {
        ...prev[providerName],
        showKey: !prev[providerName].showKey
      }
    }));
  };

  const toggleCollapse = (providerName: SupportedProvider) => {
    setCollapsedSections(prev => ({
      ...prev,
      [providerName]: !prev[providerName]
    }));
  };

  const renderProviderSection = (providerName: SupportedProvider, config: ProviderConfig) => {
    const keyData = apiKeys[providerName];
    const isCollapsed = collapsedSections[providerName] && keyData.isValid;

    // Collapsed view
    if (isCollapsed) {
      return (
        <div key={providerName} className="p-3 bg-green-50/80 dark:bg-green-900/20 backdrop-blur-sm rounded-lg border border-green-200/60 dark:border-green-700/60 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Key className="w-4 h-4 text-green-600 dark:text-green-400" />
              <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
              <span className="text-sm font-medium text-green-700 dark:text-green-300">
                {config.displayName} API Key Configured
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => toggleCollapse(providerName)}
                disabled={disabled}
                className="h-7 px-2 text-green-700 dark:text-green-300 hover:bg-green-100/50 dark:hover:bg-green-800/30"
              >
                <ChevronRight className="w-4 h-4" />
                <span className="ml-1 text-xs">Manage</span>
              </Button>
            </div>
          </div>
        </div>
      );
    }

    // Expanded view
    return (
      <div key={providerName} className="p-4 bg-white/60 dark:bg-slate-800/60 backdrop-blur-sm rounded-xl border border-slate-200/60 dark:border-slate-700/60 shadow-lg">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Key className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
              {config.displayName}
            </h3>
            {keyData.isValid && (
              <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
            )}
            {keyData.key.length > 0 && !keyData.isValid && (
              <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
            )}
          </div>
        </div>

        <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
          {config.description}
        </p>

        <div className="space-y-3">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Input
                type={keyData.showKey ? "text" : "password"}
                placeholder={config.placeholder}
                value={keyData.key}
                onChange={(e) => handleApiKeyChange(providerName, e.target.value)}
                disabled={disabled}
                className={`font-mono pr-10 ${
                  keyData.key.length > 0
                    ? keyData.isValid
                      ? "border-green-500 dark:border-green-400"
                      : "border-red-500 dark:border-red-400"
                    : ""
                }`}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 transform -translate-y-1/2 h-8 w-8"
                onClick={() => toggleShowKey(providerName)}
                disabled={disabled}
              >
                {keyData.showKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            {keyData.key.length > 0 && (
              <Button
                variant="outline"
                onClick={() => clearApiKey(providerName)}
                disabled={disabled}
                className="bg-white/70 dark:bg-slate-800/70 backdrop-blur-sm border-slate-300/60 dark:border-slate-600/60 hover:border-red-400/60 dark:hover:border-red-500/60 hover:bg-red-50/80 dark:hover:bg-red-900/20"
              >
                Clear
              </Button>
            )}
          </div>

          {keyData.key.length > 0 && !keyData.isValid && (
            <p className="text-sm text-red-600 dark:text-red-400">
              Please enter a valid {config.displayName} API key with the correct format
            </p>
          )}

          {!keyData.key.length && (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Enter your {config.displayName} API key to enable related functionality. 
              Your key will be securely stored in your browser's local storage.
            </p>
          )}

          {keyData.isValid && (
            <p className="text-sm text-green-600 dark:text-green-400">
              ✓ Valid {config.displayName} API key configured.
            </p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-4">
        <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-200 mb-6">
          API Key Management
        </h2>
        <p className="text-slate-600 dark:text-slate-400 mb-6">
          Configure your API keys for different AI providers. Keys are stored securely in your browser's local storage.
        </p>
        
        {Object.entries(PROVIDERS).map(([providerName, config]) =>
          renderProviderSection(providerName as SupportedProvider, config)
        )}
      </div>
    </div>
  );
};

export default SettingsTab;
