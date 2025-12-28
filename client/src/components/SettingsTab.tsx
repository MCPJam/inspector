import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { useState } from "react";
import { ProvidersTable } from "./setting/ProvidersTable";
import { ProviderConfigDialog } from "./setting/ProviderConfigDialog";
import { OllamaConfigDialog } from "./setting/OllamaConfigDialog";
import { LiteLLMConfigDialog } from "./setting/LiteLLMConfigDialog";
import { OpenRouterConfigDialog } from "./setting/OpenRouterConfigDialog";
import { AzureOpenAIConfigDialog } from "./setting/AzureOpenAIConfigDialog";

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
    getLiteLLMBaseUrl,
    setLiteLLMBaseUrl,
    getLiteLLMModelAlias,
    setLiteLLMModelAlias,
    getOpenRouterSelectedModels,
    setOpenRouterSelectedModels,
    getAzureBaseUrl,
    setAzureBaseUrl,
  } = useAiProviderKeys();

  const [editingValue, setEditingValue] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<ProviderConfig | null>(null);
  const [ollamaDialogOpen, setOllamaDialogOpen] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [litellmDialogOpen, setLitellmDialogOpen] = useState(false);
  const [litellmUrl, setLitellmUrl] = useState("");
  const [litellmApiKey, setLitellmApiKey] = useState("");
  const [litellmModelAlias, setLitellmModelAlias] = useState("");
  const [openRouterDialogOpen, setOpenRouterDialogOpen] = useState(false);
  const [openRouterApiKeyInput, setOpenRouterApiKeyInput] = useState("");
  const [openRouterSelectedModelsInput, setOpenRouterSelectedModelsInput] =
    useState<string[]>([]);
  const [azureDialogOpen, setAzureDialogOpen] = useState(false);
  const [azureUrl, setAzureUrl] = useState("");
  const [azureApiKey, setAzureApiKey] = useState("");
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
    {
      id: "mistral",
      name: "Mistral AI",
      logo: "/mistral_logo.png",
      logoAlt: "Mistral AI",
      description: "Mistral Large, Mistral Small, Codestral, etc.",
      placeholder: "...",
      getApiKeyUrl: "https://console.mistral.ai/api-keys/",
    },
    {
      id: "xai",
      name: "xAI",
      logo: "/xai_logo.png",
      logoAlt: "xAI Grok",
      description: "Grok 3, Grok 3 Mini, Grok Code Fast 1, etc.",
      placeholder: "xai-...",
      getApiKeyUrl: "https://console.x.ai/",
    },
  ];

  const handleEdit = (providerId: string) => {
    const provider = providerConfigs.find((p) => p.id === providerId);
    if (provider) {
      setSelectedProvider(provider);
      const tokenValue = tokens[providerId as keyof typeof tokens];
      setEditingValue(
        Array.isArray(tokenValue) ? tokenValue.join(", ") : tokenValue || "",
      );
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
    // Also clear OpenRouter selected models if deleting OpenRouter provider
    if (providerId === "openrouter") {
      setOpenRouterSelectedModels([]);
    }
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

  const handleLiteLLMEdit = () => {
    setLitellmUrl(getLiteLLMBaseUrl());
    setLitellmApiKey(tokens.litellm || "");
    setLitellmModelAlias(getLiteLLMModelAlias());
    setLitellmDialogOpen(true);
  };

  const handleLiteLLMSave = () => {
    setLiteLLMBaseUrl(litellmUrl);
    setToken("litellm", litellmApiKey);
    setLiteLLMModelAlias(litellmModelAlias);
    setLitellmDialogOpen(false);
    setLitellmUrl("");
    setLitellmApiKey("");
    setLitellmModelAlias("");
  };

  const handleLiteLLMCancel = () => {
    setLitellmDialogOpen(false);
    setLitellmUrl("");
    setLitellmApiKey("");
    setLitellmModelAlias("");
  };

  const handleOpenRouterEdit = () => {
    const currentModels = getOpenRouterSelectedModels();
    setOpenRouterApiKeyInput(tokens.openrouter || "");
    setOpenRouterSelectedModelsInput(currentModels);
    setOpenRouterDialogOpen(true);
  };

  const handleOpenRouterSave = (apiKey: string, selectedModels: string[]) => {
    setToken("openrouter", apiKey);
    setOpenRouterSelectedModels(selectedModels);
    setOpenRouterDialogOpen(false);
  };

  const handleOpenRouterModelsChange = (models: string[]) => {
    setOpenRouterSelectedModelsInput(models);
  };

  const handleOpenRouterCancel = () => {
    setOpenRouterDialogOpen(false);
    setOpenRouterApiKeyInput("");
    setOpenRouterSelectedModelsInput([]);
  };

  const handleAzureEdit = () => {
    setAzureUrl(getAzureBaseUrl());
    setAzureApiKey(tokens.azure || "");
    setAzureDialogOpen(true);
  };

  const handleAzureSave = () => {
    setAzureBaseUrl(azureUrl);
    setToken("azure", azureApiKey);
    setAzureDialogOpen(false);
    setAzureUrl("");
    setAzureApiKey("");
  };

  const handleAzureCancel = () => {
    setAzureDialogOpen(false);
    setAzureUrl("");
    setAzureApiKey("");
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="container mx-auto p-6 max-w-6xl space-y-8">
        <div className="flex flex-col gap-3 mb-6">
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-sm text-muted-foreground">
            MCPJam Version: v{__APP_VERSION__}
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold">LLM Provider API Keys</h3>
          </div>

          <ProvidersTable
            providerConfigs={providerConfigs}
            hasToken={(providerId) =>
              hasToken(providerId as keyof typeof tokens)
            }
            onEditProvider={handleEdit}
            onDeleteProvider={handleDelete}
            ollamaBaseUrl={getOllamaBaseUrl()}
            onEditOllama={handleOllamaEdit}
            litellmBaseUrl={getLiteLLMBaseUrl()}
            litellmModelAlias={getLiteLLMModelAlias()}
            onEditLiteLLM={handleLiteLLMEdit}
            openRouterSelectedModels={getOpenRouterSelectedModels()}
            onEditOpenRouter={handleOpenRouterEdit}
            azureBaseUrl={getAzureBaseUrl()}
            onEditAzure={handleAzureEdit}
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

        {/* LiteLLM Configuration Dialog */}
        <LiteLLMConfigDialog
          open={litellmDialogOpen}
          onOpenChange={setLitellmDialogOpen}
          baseUrl={litellmUrl}
          apiKey={litellmApiKey}
          modelAlias={litellmModelAlias}
          onBaseUrlChange={setLitellmUrl}
          onApiKeyChange={setLitellmApiKey}
          onModelAliasChange={setLitellmModelAlias}
          onSave={handleLiteLLMSave}
          onCancel={handleLiteLLMCancel}
        />

        {/* Azure Configuration Dialog */}
        <AzureOpenAIConfigDialog
          open={azureDialogOpen}
          onOpenChange={setAzureDialogOpen}
          baseUrl={azureUrl}
          apiKey={azureApiKey}
          onBaseUrlChange={setAzureUrl}
          onApiKeyChange={setAzureApiKey}
          onSave={handleAzureSave}
          onCancel={handleAzureCancel}
        />

        {/* OpenRouter Configuration Dialog */}
        <OpenRouterConfigDialog
          open={openRouterDialogOpen}
          onOpenChange={setOpenRouterDialogOpen}
          apiKey={openRouterApiKeyInput}
          selectedModels={openRouterSelectedModelsInput}
          onApiKeyChange={setOpenRouterApiKeyInput}
          onSelectedModelsChange={handleOpenRouterModelsChange}
          onSave={handleOpenRouterSave}
          onCancel={handleOpenRouterCancel}
        />
      </div>
    </div>
  );
}
