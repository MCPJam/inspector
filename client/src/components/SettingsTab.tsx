
import { useState } from "react";
import { Settings, Key, Eye, EyeOff, Check, X, Server } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

export function SettingsTab() {
  const {
    tokens,
    setToken,
    clearToken,
    hasToken,
    getOllamaBaseUrl,
    setOllamaBaseUrl,
  } = useAiProviderKeys();
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [showOpenAIKey, setShowOpenAIKey] = useState(false);
  const themeMode = usePreferencesStore((s) => s.themeMode);

  const handleClearToken = (provider: "anthropic" | "openai") => {
    clearToken(provider);
  };

  const handleResetOllamaUrl = () => {
    setOllamaBaseUrl("http://localhost:11434");
  };

  const maskToken = (token: string) => {
    if (!token) return "";
    if (token.length <= 8) return "*".repeat(token.length);
    return token.slice(0, 4) + "*".repeat(token.length - 8) + token.slice(-4);
  };

  return (
    <div className="container mx-auto p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Settings className="h-6 w-6" />
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            API Keys
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Configure your LLM provider API keys. Keys are stored locally in
            your browser.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Anthropic API Key */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="anthropic-key" className="text-base font-medium">
                Anthropic API Key
              </Label>
              {hasToken("anthropic") && (
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-500" />
                  <span className="text-xs text-green-600">Configured</span>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="anthropic-key"
                  type={showAnthropicKey ? "text" : "password"}
                  value={
                    showAnthropicKey
                      ? tokens.anthropic
                      : maskToken(tokens.anthropic)
                  }
                  onChange={(e) => setToken("anthropic", e.target.value)}
                  placeholder="sk-ant-..."
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                  onClick={() => setShowAnthropicKey(!showAnthropicKey)}
                >
                  {showAnthropicKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {hasToken("anthropic") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleClearToken("anthropic")}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Get your API key from{" "}
              <a
                href="https://console.anthropic.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline"
              >
                Anthropic Console
              </a>
            </p>
          </div>

          {/* OpenAI API Key */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="openai-key" className="text-base font-medium">
                OpenAI API Key
              </Label>
              {hasToken("openai") && (
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-500" />
                  <span className="text-xs text-green-600">Configured</span>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="openai-key"
                  type={showOpenAIKey ? "text" : "password"}
                  value={
                    showOpenAIKey ? tokens.openai : maskToken(tokens.openai)
                  }
                  onChange={(e) => setToken("openai", e.target.value)}
                  placeholder="sk-..."
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                  onClick={() => setShowOpenAIKey(!showOpenAIKey)}
                >
                  {showOpenAIKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {hasToken("openai") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleClearToken("openai")}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Get your API key from{" "}
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline"
              >
                OpenAI Platform
              </a>
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Ollama Configuration */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <img
              src={
                themeMode === "dark" ? "/ollama_dark.png" : "/ollama_logo.svg"
              }
              alt="Ollama"
              className="h-5 w-5"
            />
            Ollama Configuration
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Configure your local Ollama server settings.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="ollama-url" className="text-base font-medium">
                Base URL
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  Default: http://localhost:11434
                </span>
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                id="ollama-url"
                type="text"
                value={getOllamaBaseUrl()}
                onChange={(e) => setOllamaBaseUrl(e.target.value)}
                placeholder="http://localhost:11434"
                className="flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetOllamaUrl}
              >
                Reset
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Configure the base URL for your Ollama server. This is typically{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                http://localhost:11434
              </code>{" "}
              for local installations.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
