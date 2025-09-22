import { Settings } from "lucide-react";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { useState } from "react";
import { ProvidersTable } from "./setting/ProvidersTable";
import { ProviderConfigDialog } from "./setting/ProviderConfigDialog";
import { OllamaConfigDialog } from "./setting/OllamaConfigDialog";
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
      description: "GPT-4, GPT-4o, GPT-4o-mini, GPT-4.1, GPT-5, etc.",
      placeholder: "sk-...",
      getApiKeyUrl: "https://platform.openai.com/api-keys",
    },
    {
      id: "anthropic",
      name: "Anthropic",
      logo: "/claude_logo.png",
      logoAlt: "Claude",
      description: "Claude 3.5, Claude 3.7, Claude Opus 4, etc.",
      placeholder: "sk-ant-...",
      getApiKeyUrl: "https://console.anthropic.com/",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      logo: "/deepseek_logo.svg",
      logoAlt: "DeepSeek",
      description: "DeepSeek Chat, DeepSeek Reasoner, etc.",
      placeholder: "sk-...",
      getApiKeyUrl: "https://platform.deepseek.com/api_keys",
    },
    {
      id: "google",
      name: "Google AI",
      logo: "/google_logo.png",
      logoAlt: "Google AI",
      description: "Gemini 2.5, Gemini 2.5 Flash, Gemini 2.5 Flash Lite",
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

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-8">
      <div className="flex items-center gap-3 mb-6">
        <Settings className="h-6 w-6" />
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      <AccountApiKeySection />

      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Configure LLM API Keys</h3>
        </div>

        <ProvidersTable
          providerConfigs={providerConfigs}
          hasToken={(providerId) => hasToken(providerId as keyof typeof tokens)}
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
