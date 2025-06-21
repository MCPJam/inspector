import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Eye, EyeOff, Key, CheckCircle, AlertCircle, Bot } from "lucide-react";
import { useToast } from "@/lib/hooks/useToast";
import { SupportedProvider } from "@/lib/providers";

interface SettingsTabProps {
  onApiKeyChange: (apiKey: string) => void;
  onProviderChange?: (provider: SupportedProvider) => void;
  disabled?: boolean;
}

const CLAUDE_STORAGE_KEY = "claude-api-key";
const OPENAI_STORAGE_KEY = "openai-api-key";
const PROVIDER_STORAGE_KEY = "selected-provider";

const SettingsTab: React.FC<SettingsTabProps> = ({
  onApiKeyChange,
  onProviderChange,
  disabled = false,
}) => {
  const [selectedProvider, setSelectedProvider] = useState<SupportedProvider>("anthropic");
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const { toast } = useToast();

  // Load settings from localStorage on mount
  useEffect(() => {
    try {
      const storedProvider = localStorage.getItem(PROVIDER_STORAGE_KEY) as SupportedProvider || "anthropic";
      const storedClaudeKey = localStorage.getItem(CLAUDE_STORAGE_KEY) || "";
      const storedOpenaiKey = localStorage.getItem(OPENAI_STORAGE_KEY) || "";
      
      setSelectedProvider(storedProvider);
      setClaudeApiKey(storedClaudeKey);
      setOpenaiApiKey(storedOpenaiKey);
      
      // Set the current API key based on selected provider
      const currentApiKey = storedProvider === "openai" ? storedOpenaiKey : storedClaudeKey;
      if (currentApiKey && validateApiKey(currentApiKey, storedProvider)) {
        onApiKeyChange(currentApiKey);
      }
      
      if (onProviderChange) {
        onProviderChange(storedProvider);
      }
    } catch (error) {
      console.warn("Failed to load settings from localStorage:", error);
    }
  }, [onApiKeyChange, onProviderChange]);

  // Validate API key format based on provider
  const validateApiKey = (key: string, provider: SupportedProvider): boolean => {
    if (!key || key.length === 0) return false;
    
    switch (provider) {
      case "anthropic": {
        // Claude API keys start with "sk-ant-api03-" and are followed by base64-like characters
        const claudeApiKeyPattern = /^sk-ant-api03-[A-Za-z0-9_-]+$/;
        return claudeApiKeyPattern.test(key) && key.length > 20;
      }
      case "openai": {
        // OpenAI API keys start with "sk-" and are followed by alphanumeric characters
        const openaiApiKeyPattern = /^sk-[A-Za-z0-9_-]+$/;
        return openaiApiKeyPattern.test(key) && key.length > 20;
      }
      default:
        return false;
    }
  };

  const getCurrentApiKey = () => {
    return selectedProvider === "openai" ? openaiApiKey : claudeApiKey;
  };

  const isCurrentKeyValid = () => {
    const currentKey = getCurrentApiKey();
    return validateApiKey(currentKey, selectedProvider);
  };

  const handleProviderChange = (provider: SupportedProvider) => {
    setSelectedProvider(provider);
    try {
      localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
    } catch (error) {
      console.warn("Failed to save provider to localStorage:", error);
    }
    
    // Update the API key for the new provider
    const newApiKey = provider === "openai" ? openaiApiKey : claudeApiKey;
    if (validateApiKey(newApiKey, provider)) {
      onApiKeyChange(newApiKey);
    } else {
      onApiKeyChange("");
    }
    
    if (onProviderChange) {
      onProviderChange(provider);
    }

    toast({
      title: "Provider Changed",
      description: `Switched to ${provider === "openai" ? "OpenAI" : "Anthropic"} provider.`,
      variant: "default",
    });
  };

  const handleApiKeyChange = (value: string) => {
    if (selectedProvider === "openai") {
      setOpenaiApiKey(value);
    } else {
      setClaudeApiKey(value);
    }

    const isValid = validateApiKey(value, selectedProvider);

    if (isValid) {
      try {
        const storageKey = selectedProvider === "openai" ? OPENAI_STORAGE_KEY : CLAUDE_STORAGE_KEY;
        localStorage.setItem(storageKey, value);
      } catch (error) {
        console.warn("Failed to save API key to localStorage:", error);
      }
      onApiKeyChange(value);
      toast({
        title: "API Key Set",
        description: `Your ${selectedProvider === "openai" ? "OpenAI" : "Claude"} API key has been saved and configured successfully.`,
        variant: "default",
      });
    } else if (value.length > 0) {
      onApiKeyChange("");
    } else {
      onApiKeyChange("");
    }
  };

  const clearApiKey = () => {
    if (selectedProvider === "openai") {
      setOpenaiApiKey("");
    } else {
      setClaudeApiKey("");
    }

    try {
      const storageKey = selectedProvider === "openai" ? OPENAI_STORAGE_KEY : CLAUDE_STORAGE_KEY;
      localStorage.removeItem(storageKey);
    } catch (error) {
      console.warn("Failed to remove API key from localStorage:", error);
    }
    onApiKeyChange("");
    toast({
      title: "API Key Cleared",
      description: `Your ${selectedProvider === "openai" ? "OpenAI" : "Claude"} API key has been removed from storage.`,
      variant: "default",
    });
  };

  const getApiKeyPlaceholder = () => {
    switch (selectedProvider) {
      case "openai":
        return "Enter your OpenAI API key (sk-...)";
      case "anthropic":
        return "Enter your Claude API key (sk-ant-api03-...)";
      default:
        return "Enter your API key";
    }
  };

  const getProviderDisplayName = () => {
    switch (selectedProvider) {
      case "openai":
        return "OpenAI";
      case "anthropic":
        return "Anthropic";
      default:
        return selectedProvider;
    }
  };

  return (
    <div className="space-y-6 p-6">
      {/* Provider Selection */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
            AI Provider
          </h3>
        </div>
        
        <Select value={selectedProvider} onValueChange={handleProviderChange} disabled={disabled}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select AI provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
            <SelectItem value="openai">OpenAI (GPT)</SelectItem>
            <SelectItem value="deepseek" disabled>DeepSeek (Coming Soon)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* API Key Configuration */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Key className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
            {getProviderDisplayName()} API Key
          </h3>
          {isCurrentKeyValid() && (
            <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
          )}
          {getCurrentApiKey().length > 0 && !isCurrentKeyValid() && (
            <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
          )}
        </div>

        <div className="space-y-3">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Input
                type={showApiKey ? "text" : "password"}
                placeholder={getApiKeyPlaceholder()}
                value={getCurrentApiKey()}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                disabled={disabled}
                className={`font-mono pr-10 ${
                  getCurrentApiKey().length > 0
                    ? isCurrentKeyValid()
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
                onClick={() => setShowApiKey(!showApiKey)}
                disabled={disabled}
              >
                {showApiKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            {getCurrentApiKey().length > 0 && (
              <Button
                variant="outline"
                onClick={clearApiKey}
                disabled={disabled}
                className="bg-white/70 dark:bg-slate-800/70 backdrop-blur-sm border-slate-300/60 dark:border-slate-600/60 hover:border-red-400/60 dark:hover:border-red-500/60 hover:bg-red-50/80 dark:hover:bg-red-900/20"
              >
                Clear
              </Button>
            )}
          </div>

          {getCurrentApiKey().length > 0 && !isCurrentKeyValid() && (
            <p className="text-sm text-red-600 dark:text-red-400">
              Please enter a valid {getProviderDisplayName()} API key
            </p>
          )}

          {!getCurrentApiKey().length && (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Enter your {getProviderDisplayName()} API key to enable the chat functionality. Your
              key will be securely stored in your browser's local storage.
            </p>
          )}

          {isCurrentKeyValid() && (
            <p className="text-sm text-green-600 dark:text-green-400">
              ✓ Valid API key configured. Chat functionality is now available.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsTab;
