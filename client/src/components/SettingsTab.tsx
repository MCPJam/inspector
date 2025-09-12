import { Settings, KeyRound, Copy, RefreshCw } from "lucide-react";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { useState } from "react";
import { ProvidersTable } from "./setting/ProvidersTable";
import { ProviderConfigDialog } from "./setting/ProviderConfigDialog";
import { OllamaConfigDialog } from "./setting/OllamaConfigDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { api } from "../../../convex/_generated/api";

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
  const [apiKeyPlaintext, setApiKeyPlaintext] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const { signIn } = useAuth();

  // Convex: list current API keys and create/regenerate
  const anyApi = api as any;
  const keys = useQuery(
    anyApi.apiKeys.list, 
    isAuthenticated ? {} : "skip"
  ) as
    | { _id: string; name: string; prefix: string; createdAt: number; lastUsedAt: number | null; revokedAt: number | null }[]
    | undefined;
  const createOrUpdate = useMutation(anyApi.apiKeys.createOrUpdate) as unknown as (
    args: { name?: string; forceNew?: boolean },
  ) => Promise<
    | {
        created: true;
        updated: false;
        apiKey: string;
        key: {
          _id: string;
          prefix: string;
          name: string;
          createdAt: number;
          lastUsedAt: number | null;
          revokedAt: number | null;
        };
      }
    | {
        created: false;
        updated: boolean;
        apiKey: null;
        key: {
          _id: string;
          prefix: string;
          name: string;
          createdAt: number;
          lastUsedAt: number | null;
          revokedAt: number | null;
        };
      }
  >;

  const primaryKey = (keys ?? []).find((k) => !k.revokedAt) ?? null;

  const handleGenerateKey = async (forceNew: boolean) => {
    if (!isAuthenticated) return;
    try {
      setIsGenerating(true);
      const result = await createOrUpdate({ forceNew });
      setApiKeyPlaintext(result.apiKey);
    } catch (err) {
      console.error("Failed to generate key", err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyPlaintext = async () => {
    if (!apiKeyPlaintext) return;
    try {
      await navigator.clipboard.writeText(apiKeyPlaintext);
    } catch (err) {
      console.error("Clipboard error", err);
    }
  };

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

      {/* Require authentication to manage API keys */}
      {isAuthLoading ? (
        <div className="rounded-md border p-3 text-sm text-muted-foreground">Checking authentication…</div>
      ) : !isAuthenticated ? (
        <div className="space-y-3 rounded-md border p-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            <h3 className="text-lg font-semibold">Account API Key</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Sign in to view and manage your API key.
          </p>
          <Button type="button" onClick={() => signIn()} size="sm">
            Sign in
          </Button>
        </div>
      ) : null}

      {isAuthenticated && (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          <h3 className="text-lg font-semibold">Account API Key</h3>
        </div>
        <p className="text-muted-foreground text-sm">
          Generate and manage your personal API key for authenticated requests. The
          full key is shown only once when created.
        </p>

        {primaryKey ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">Key prefix</div>
              <div className="font-mono text-sm">{primaryKey.prefix}</div>
            </div>
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">Created</div>
              <div className="text-sm">{new Date(primaryKey.createdAt).toLocaleString()}</div>
            </div>
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">Last used</div>
              <div className="text-sm">{primaryKey.lastUsedAt ? new Date(primaryKey.lastUsedAt).toLocaleString() : "Never"}</div>
            </div>
            <div className="flex items-end justify-start">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleGenerateKey(true)}
                disabled={isGenerating || !isAuthenticated}
              >
                <RefreshCw className="h-4 w-4" />
                <span>Regenerate key</span>
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={() => handleGenerateKey(true)}
              disabled={isGenerating || !isAuthenticated}
            >
              <KeyRound className="h-4 w-4" />
              <span>Create API Key</span>
            </Button>
            <span className="text-sm text-muted-foreground">You don't have an active key yet.</span>
          </div>
        )}

        {apiKeyPlaintext ? (
          <div className="space-y-2 rounded-md border p-3">
            <div className="text-sm font-medium">Your new API key (shown once)</div>
            <div className="flex items-center gap-2">
              <Input readOnly value={apiKeyPlaintext} className="font-mono" />
              <Button type="button" variant="outline" size="sm" onClick={handleCopyPlaintext}>
                <Copy className="h-4 w-4" />
                <span>Copy</span>
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              Store this key securely. You won't be able to see it again.
            </div>
          </div>
        ) : null}
      </div>
      )}

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
