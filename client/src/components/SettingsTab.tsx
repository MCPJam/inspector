import { Settings } from "lucide-react";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { useState } from "react";
import { ProvidersTable } from "./setting/ProvidersTable";
import { ProviderConfigDialog } from "./setting/ProviderConfigDialog";
import { OllamaConfigDialog } from "./setting/OllamaConfigDialog";
import { Button } from "@/components/ui/button";
import { AccountApiKeySection } from "./setting/AccountApiKeySection";

interface ProviderConfig {
  id: string;
  name: string;
  logo: string;
  logoAlt: string;
  description: string;
  placeholder: string;
  getApiKeyUrl: string;
}

export function SettingsTab() {
  const {
    tokens,
    setToken,
    clearToken,
    hasToken,
    getOllamaBaseUrl,
    setOllamaBaseUrl,
  } = useAiProviderKeys();

  const [editingValue, setEditingValue] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<ProviderConfig | null>(null);
  const [ollamaDialogOpen, setOllamaDialogOpen] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState("");

  const providerConfigs: ProviderConfig[] = [
    {
      id: "openai",
      name: "OpenAI",
      logo: "/openai_logo.png",
      logoAlt: "OpenAI",
      description: "GPT models for general-purpose AI tasks",
      placeholder: "sk-...",
      getApiKeyUrl: "https://platform.openai.com/api-keys",
    },
    {
      id: "anthropic",
      name: "Anthropic",
      logo: "/claude_logo.png",
      logoAlt: "Claude",
      description: "Claude AI models for advanced reasoning",
      placeholder: "sk-ant-...",
      getApiKeyUrl: "https://console.anthropic.com/",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      logo: "/deepseek_logo.svg",
      logoAlt: "DeepSeek",
      description: "DeepSeek AI models for coding and reasoning",
      placeholder: "sk-...",
      getApiKeyUrl: "https://platform.deepseek.com/api_keys",
    },
    {
      id: "google",
      name: "Google AI",
      logo: "/google_logo.png",
      logoAlt: "Google AI",
      description: "Gemini & Gemma models for multimodal AI and coding tasks",
      placeholder: "AI...",
      getApiKeyUrl: "https://aistudio.google.com/app/apikey",
    },
  ];

  const handleEdit = (providerId: string) => {
    const provider = providerConfigs.find((p) => p.id === providerId);
    if (provider) {
      setSelectedProvider(provider);
      setEditingValue(tokens[providerId as keyof typeof tokens] || "");
      setDialogOpen(true);
    }
  };

  const handleSave = () => {
    if (selectedProvider) {
      setToken(selectedProvider.id as keyof typeof tokens, editingValue);
      // Store timestamp when API key is saved
      const timestamp = new Date().toLocaleString();
      localStorage.setItem(`${selectedProvider.id}_timestamp`, timestamp);
      setDialogOpen(false);
      setSelectedProvider(null);
      setEditingValue("");
    }
  };

  const handleCancel = () => {
    setDialogOpen(false);
    setSelectedProvider(null);
    setEditingValue("");
  };

  const handleDelete = (providerId: string) => {
    clearToken(providerId as keyof typeof tokens);
    // Remove timestamp when API key is deleted
    localStorage.removeItem(`${providerId}_timestamp`);
  };

  const handleOllamaEdit = () => {
    setOllamaUrl(getOllamaBaseUrl());
    setOllamaDialogOpen(true);
  };

  const handleOllamaSave = () => {
    setOllamaBaseUrl(ollamaUrl);
    setOllamaDialogOpen(false);
    setOllamaUrl("");
  };

  const handleOllamaCancel = () => {
    setOllamaDialogOpen(false);
    setOllamaUrl("");
  };

  const maskApiKey = (key: string) => {
    if (!key || key.length <= 8) return key;
    return `****${key.slice(-4)}`;
  };

  const getCreatedDate = (providerId: string) => {
    if (hasToken(providerId as keyof typeof tokens)) {
      const timestamp = localStorage.getItem(`${providerId}_timestamp`);
      return timestamp || "N/A";
    }
    return "N/A";
  };

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-8">
      <div className="flex items-center gap-3 mb-6">
        <Settings className="h-6 w-6" />
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      <AccountApiKeySection />

      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">AI Providers</h3>
          <p className="text-muted-foreground">
            Click the + button next to any provider to configure it.
          </p>
        </div>

        <ProvidersTable
          providerConfigs={providerConfigs}
          hasToken={(providerId) => hasToken(providerId as keyof typeof tokens)}
          getToken={(providerId) =>
            tokens[providerId as keyof typeof tokens] || ""
          }
          getCreatedDate={getCreatedDate}
          maskApiKey={maskApiKey}
          onEditProvider={handleEdit}
          onDeleteProvider={handleDelete}
          ollamaBaseUrl={getOllamaBaseUrl()}
          onEditOllama={handleOllamaEdit}
        />
      </div>

      {/* API Key Configuration Dialog */}
      <ProviderConfigDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        provider={selectedProvider}
        value={editingValue}
        onValueChange={setEditingValue}
        onSave={handleSave}
        onCancel={handleCancel}
      />

      {/* Ollama URL Configuration Dialog */}
      <OllamaConfigDialog
        open={ollamaDialogOpen}
        onOpenChange={setOllamaDialogOpen}
        value={ollamaUrl}
        onValueChange={setOllamaUrl}
        onSave={handleOllamaSave}
        onCancel={handleOllamaCancel}
      />
    </div>
  );
}
