import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import { useState } from "react";
import { ProviderConfigDialog } from "./setting/ProviderConfigDialog";
import { OllamaConfigDialog } from "./setting/OllamaConfigDialog";
import { CustomProviderConfigDialog } from "./setting/CustomProviderConfigDialog";
import { OpenRouterConfigDialog } from "./setting/OpenRouterConfigDialog";
import { AzureOpenAIConfigDialog } from "./setting/AzureOpenAIConfigDialog";
import { SettingsSection } from "./setting/SettingsSection";
import { SettingsRow } from "./setting/SettingsRow";
import { ProviderRow } from "./setting/ProviderRow";
import { Switch } from "./ui/switch";
import { Button } from "./ui/button";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { updateThemeMode } from "@/lib/theme-utils";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { HOSTED_MODE } from "@/lib/config";
import type { CustomProvider } from "@mcpjam/sdk";

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
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);
  const {
    tokens,
    setToken,
    clearToken,
    hasToken,
    getOllamaBaseUrl,
    setOllamaBaseUrl,
    getOpenRouterSelectedModels,
    setOpenRouterSelectedModels,
    getAzureBaseUrl,
    setAzureBaseUrl,
  } = useAiProviderKeys();
  const {
    customProviders,
    addCustomProvider,
    updateCustomProvider,
    removeCustomProvider,
  } = useCustomProviders();

  const [editingValue, setEditingValue] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<ProviderConfig | null>(null);
  const [ollamaDialogOpen, setOllamaDialogOpen] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [openRouterDialogOpen, setOpenRouterDialogOpen] = useState(false);
  const [openRouterApiKeyInput, setOpenRouterApiKeyInput] = useState("");
  const [openRouterSelectedModelsInput, setOpenRouterSelectedModelsInput] =
    useState<string[]>([]);
  const [azureDialogOpen, setAzureDialogOpen] = useState(false);
  const [azureUrl, setAzureUrl] = useState("");
  const [azureApiKey, setAzureApiKey] = useState("");

  // Custom provider dialog state
  const [customProviderDialogOpen, setCustomProviderDialogOpen] =
    useState(false);
  const [editingCustomProviderIndex, setEditingCustomProviderIndex] = useState<
    number | null
  >(null);

  const providerConfigs: ProviderConfig[] = [
    {
      id: "openai",
      name: "OpenAI",
      logo: "/openai_logo.png",
      logoAlt: "OpenAI",
      description: "GPT-4, GPT-4o, GPT-4o-mini, GPT-4.1, GPT-5",
      placeholder: "sk-...",
      getApiKeyUrl: "https://platform.openai.com/api-keys",
    },
    {
      id: "anthropic",
      name: "Anthropic",
      logo: "/claude_logo.png",
      logoAlt: "Claude",
      description: "Claude 3.5, Claude 3.7, Claude Opus 4",
      placeholder: "sk-ant-...",
      getApiKeyUrl: "https://console.anthropic.com/",
    },
    {
      id: "google",
      name: "Google AI",
      logo: "/google_logo.png",
      logoAlt: "Google AI",
      description: "Gemini 2.5, Gemini 2.5 Flash",
      placeholder: "AI...",
      getApiKeyUrl: "https://aistudio.google.com/app/apikey",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      logo: "/deepseek_logo.svg",
      logoAlt: "DeepSeek",
      description: "DeepSeek Chat, DeepSeek Reasoner",
      placeholder: "sk-...",
      getApiKeyUrl: "https://platform.deepseek.com/api_keys",
    },
    {
      id: "mistral",
      name: "Mistral AI",
      logo: "/mistral_logo.png",
      logoAlt: "Mistral AI",
      description: "Mistral Large, Mistral Small, Codestral",
      placeholder: "...",
      getApiKeyUrl: "https://console.mistral.ai/api-keys/",
    },
    {
      id: "xai",
      name: "xAI",
      logo: "/xai_logo.png",
      logoAlt: "xAI Grok",
      description: "Grok 3, Grok 3 Mini",
      placeholder: "xai-...",
      getApiKeyUrl: "https://console.x.ai/",
    },
  ];

  const selfHostedProviders: Array<{
    id: string;
    name: string;
    logo: string;
    isConfigured: boolean;
    onEdit: () => void;
    configType?: "api-key" | "base-url";
  }> = [
    {
      id: "ollama",
      name: "Ollama",
      logo: "/ollama_logo.svg",
      isConfigured: Boolean(getOllamaBaseUrl()),
      configType: "base-url",
      onEdit: () => {
        setOllamaUrl(getOllamaBaseUrl());
        setOllamaDialogOpen(true);
      },
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      logo: "/openrouter_logo.png",
      isConfigured: Boolean(tokens.openrouter),
      onEdit: () => {
        setOpenRouterApiKeyInput(tokens.openrouter || "");
        setOpenRouterSelectedModelsInput(getOpenRouterSelectedModels());
        setOpenRouterDialogOpen(true);
      },
    },
    {
      id: "azure",
      name: "Azure OpenAI",
      logo: "/azure_logo.png",
      isConfigured: Boolean(getAzureBaseUrl()),
      configType: "base-url",
      onEdit: () => {
        setAzureUrl(getAzureBaseUrl());
        setAzureApiKey(tokens.azure || "");
        setAzureDialogOpen(true);
      },
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

  const handleOllamaSave = () => {
    setOllamaBaseUrl(ollamaUrl);
    setOllamaDialogOpen(false);
    setOllamaUrl("");
  };

  const handleOllamaCancel = () => {
    setOllamaDialogOpen(false);
    setOllamaUrl("");
  };

  const handleOpenRouterSave = (apiKey: string, selectedModels: string[]) => {
    setToken("openrouter", apiKey);
    setOpenRouterSelectedModels(selectedModels);
    setOpenRouterDialogOpen(false);
  };

  const handleOpenRouterCancel = () => {
    setOpenRouterDialogOpen(false);
    setOpenRouterApiKeyInput("");
    setOpenRouterSelectedModelsInput([]);
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

  const handleThemeToggle = (checked: boolean) => {
    const newTheme = checked ? "dark" : "light";
    updateThemeMode(newTheme);
    setThemeMode(newTheme);
  };

  const handleCustomProviderSave = (provider: CustomProvider) => {
    if (editingCustomProviderIndex !== null) {
      updateCustomProvider(editingCustomProviderIndex, provider);
    } else {
      addCustomProvider(provider);
    }
    setCustomProviderDialogOpen(false);
    setEditingCustomProviderIndex(null);
  };

  const handleCustomProviderCancel = () => {
    setCustomProviderDialogOpen(false);
    setEditingCustomProviderIndex(null);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-10 space-y-8 max-w-3xl">
        <h1 className="text-2xl font-semibold">Settings</h1>

        {/* About */}
        <SettingsSection title="About">
          <SettingsRow label="Version" value={`v${__APP_VERSION__}`} />
        </SettingsSection>

        {/* Appearance */}
        <SettingsSection title="Appearance">
          <SettingsRow
            label="Theme"
            value={
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {themeMode === "dark" ? "Dark" : "Light"}
                </span>
                <Switch
                  checked={themeMode === "dark"}
                  onCheckedChange={handleThemeToggle}
                  aria-label="Toggle dark mode"
                />
              </div>
            }
          />
        </SettingsSection>

        {!HOSTED_MODE && (
          <>
            {/* LLM Providers */}
            <SettingsSection title="LLM Providers">
              {providerConfigs.map((config) => (
                <ProviderRow
                  key={config.id}
                  logo={config.logo}
                  logoAlt={config.logoAlt}
                  name={config.name}
                  isConfigured={hasToken(config.id as keyof typeof tokens)}
                  onEdit={() => handleEdit(config.id)}
                />
              ))}
              {selfHostedProviders.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  logo={provider.logo}
                  logoAlt={provider.name}
                  name={provider.name}
                  isConfigured={provider.isConfigured}
                  onEdit={provider.onEdit}
                  configType={provider.configType}
                />
              ))}
            </SettingsSection>

            {/* Custom Providers */}
            <SettingsSection title="Custom Providers">
              {customProviders.map((cp, index) => (
                <div
                  key={`${cp.name}-${index}`}
                  className="flex items-center justify-between px-4 py-3 rounded-md border border-success/30 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="size-5 rounded-sm bg-primary/10 flex items-center justify-center">
                      <span className="text-xs font-bold text-primary">
                        {cp.name[0]?.toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <span className="text-sm font-medium">{cp.name}</span>
                      <span className="text-xs text-muted-foreground ml-2">
                        {cp.modelIds.length} model
                        {cp.modelIds.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      onClick={() => {
                        setEditingCustomProviderIndex(index);
                        setCustomProviderDialogOpen(true);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => removeCustomProvider(index)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setEditingCustomProviderIndex(null);
                  setCustomProviderDialogOpen(true);
                }}
              >
                <Plus className="size-4 mr-2" />
                Add Custom Provider
              </Button>
            </SettingsSection>
          </>
        )}

        {/* Dialogs */}
        <ProviderConfigDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          provider={selectedProvider}
          value={editingValue}
          onValueChange={setEditingValue}
          onSave={handleSave}
          onCancel={handleCancel}
          onRemove={() => {
            if (selectedProvider) {
              clearToken(selectedProvider.id as keyof typeof tokens);
              setDialogOpen(false);
              setSelectedProvider(null);
              setEditingValue("");
            }
          }}
          isConfigured={
            selectedProvider
              ? hasToken(selectedProvider.id as keyof typeof tokens)
              : false
          }
        />

        <OllamaConfigDialog
          open={ollamaDialogOpen}
          onOpenChange={setOllamaDialogOpen}
          value={ollamaUrl}
          onValueChange={setOllamaUrl}
          onSave={handleOllamaSave}
          onCancel={handleOllamaCancel}
        />

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

        <OpenRouterConfigDialog
          open={openRouterDialogOpen}
          onOpenChange={setOpenRouterDialogOpen}
          apiKey={openRouterApiKeyInput}
          selectedModels={openRouterSelectedModelsInput}
          onApiKeyChange={setOpenRouterApiKeyInput}
          onSelectedModelsChange={setOpenRouterSelectedModelsInput}
          onSave={handleOpenRouterSave}
          onCancel={handleOpenRouterCancel}
          onRemove={() => {
            clearToken("openrouter");
            setOpenRouterSelectedModels([]);
            setOpenRouterDialogOpen(false);
          }}
          isConfigured={Boolean(tokens.openrouter)}
        />

        <CustomProviderConfigDialog
          open={customProviderDialogOpen}
          onOpenChange={setCustomProviderDialogOpen}
          editProvider={
            editingCustomProviderIndex !== null
              ? customProviders[editingCustomProviderIndex]
              : undefined
          }
          onSave={handleCustomProviderSave}
          onCancel={handleCustomProviderCancel}
        />
      </div>
    </div>
  );
}
