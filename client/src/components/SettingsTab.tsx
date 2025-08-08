"use client";
import { useState } from "react";
import {
  Settings,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  Server,
  Key,
  Trash2,
  Undo2,
  CheckCircle,
  ExternalLink,
} from "lucide-react";

// Custom Button Component
const Button = ({
  children,
  onClick,
  variant = "primary",
  size = "md",
  className = "",
  disabled = false,
  type = "button",
  ...props
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "outline" | "danger";
  size?: "sm" | "md" | "lg" | "icon";
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit";
  [key: string]: any;
}) => {
  const baseClasses =
    "inline-flex items-center justify-center font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed";

  const variants = {
    primary:
      "bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white shadow-lg hover:shadow-xl focus:ring-blue-500",
    secondary:
      "bg-gray-100 hover:bg-gray-200 text-gray-900 focus:ring-gray-500",
    ghost:
      "hover:bg-gray-100 text-gray-700 hover:text-gray-900 focus:ring-gray-500",
    outline:
      "border-2 border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-700 focus:ring-gray-500",
    danger: "bg-red-500 hover:bg-red-600 text-white focus:ring-red-500",
  };

  const sizes = {
    sm: "px-3 py-1.5 text-sm rounded-md",
    md: "px-4 py-2 text-sm rounded-lg",
    lg: "px-6 py-3 text-base rounded-lg",
    icon: "p-2 rounded-lg",
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${baseClasses} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

// Custom Input Component
const Input = ({
  type = "text",
  placeholder,
  value,
  onChange,
  onFocus,
  onBlur,
  className = "",
  id,
  ...props
}: {
  type?: string;
  placeholder?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  className?: string;
  id?: string;
  [key: string]: any;
}) => {
  return (
    <input
      type={type}
      id={id}
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      onFocus={onFocus}
      onBlur={onBlur}
      className={`w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:ring-4 focus:ring-blue-100 transition-all duration-200 bg-white text-gray-900 placeholder-gray-500 ${className}`}
      {...props}
    />
  );
};

// Custom Label Component
const Label = ({
  children,
  htmlFor,
  className = "",
}: {
  children: React.ReactNode;
  htmlFor?: string;
  className?: string;
}) => {
  return (
    <label
      htmlFor={htmlFor}
      className={`block text-sm font-semibold text-gray-700 mb-2 ${className}`}
    >
      {children}
    </label>
  );
};

// Custom Card Components
const Card = ({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <div
      className={`bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
};

const CardHeader = ({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <div
      className={`px-6 py-5 bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200 ${className}`}
    >
      {children}
    </div>
  );
};

const CardContent = ({
  children,
  className = "",
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) => {
  return (
    <div id={id} className={`px-6 py-5 ${className}`}>
      {children}
    </div>
  );
};

const CardTitle = ({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <h3 className={`text-lg font-bold text-gray-900 ${className}`}>
      {children}
    </h3>
  );
};

// Custom Tooltip Component
const Tooltip = ({
  children,
  content,
}: {
  children: React.ReactNode;
  content: string;
}) => {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div className="relative inline-block">
      <div
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
      >
        {children}
      </div>
      {isVisible && (
        <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 text-sm text-white bg-gray-900 rounded-lg shadow-lg whitespace-nowrap z-10">
          {content}
          <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
        </div>
      )}
    </div>
  );
};

// Mock hooks (replace with your actual implementations)
const useAiProviderKeys = () => {
  const [tokens, setTokens] = useState<{ [key: string]: string }>({});

  return {
    tokens,
    setToken: (provider: string, token: string) => {
      setTokens((prev) => ({ ...prev, [provider]: token }));
    },
    clearToken: (provider: string) => {
      setTokens((prev) => ({ ...prev, [provider]: "" }));
    },
    hasToken: (provider: string) => Boolean(tokens[provider]),
    getOllamaBaseUrl: () => "http://localhost:11434",
    setOllamaBaseUrl: (url: string) => console.log("Setting Ollama URL:", url),
  };
};

const usePreferencesStore = (selector: any) => {
  return "light";
};

// A collapsible card component that acts as a toggleable section header.
const CollapsibleCard = ({
  title,
  icon,
  children,
  logoSrc,
  initialOpen = false,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  logoSrc?: string;
  initialOpen?: boolean;
}) => {
  const [open, setOpen] = useState(initialOpen);

  return (
    <Card className="transition-all duration-300 hover:shadow-xl">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-6 hover:bg-gray-50 transition-colors duration-200 focus:outline-none focus:ring-4 focus:ring-blue-100 rounded-t-2xl"
        aria-expanded={open}
        aria-controls={`collapsible-content-${title}`}
      >
        <div className="flex items-center gap-4">
          {logoSrc ? (
            <div className="w-8 h-8 rounded-full overflow-hidden shadow-md">
              <img
                src={logoSrc || "/placeholder.svg"}
                alt={`${title} logo`}
                className="w-full h-full object-cover"
              />
            </div>
          ) : (
            <div className="w-8 h-8 rounded-full bg-gradient-to-r from-blue-500 to-purple-500 flex items-center justify-center text-white">
              {icon}
            </div>
          )}
          <CardTitle className="text-left">{title}</CardTitle>
        </div>
        <div
          className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          <ChevronDown className="h-5 w-5 text-gray-500" />
        </div>
      </button>
      {open && (
        <div
          id={`collapsible-content-${title}`}
          className="border-t border-gray-200 animate-in slide-in-from-top-2 duration-200"
        >
          <CardContent>{children}</CardContent>
        </div>
      )}
    </Card>
  );
};

// A dedicated component for handling a single API key input with show/hide and clear functionality.
const ApiKeyInput = ({
  provider,
  label,
  placeholder,
  logoSrc,
  providerConsoleUrl,
}: {
  provider: "anthropic" | "openai";
  label: string;
  placeholder: string;
  logoSrc: string;
  providerConsoleUrl: string;
}) => {
  const { tokens, setToken, clearToken, hasToken } = useAiProviderKeys();
  const [showKey, setShowKey] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  // Masks the token for display when not editing.
  const maskToken = (token: string) => {
    if (!token) return "";
    if (token.length <= 8) return "*".repeat(token.length);
    return token.slice(0, 4) + "*".repeat(token.length - 8) + token.slice(-4);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setToken(provider, e.target.value);
  };

  const tokenValue =
    hasToken(provider) && !isEditing && !showKey
      ? maskToken(tokens[provider])
      : tokens[provider];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label htmlFor={`${provider}-key`} className="flex items-center gap-2">
          <img
            src={logoSrc || "/placeholder.svg"}
            alt={`${label} logo`}
            className="w-5 h-5 rounded"
          />
          {label} API Key
        </Label>
        {hasToken(provider) && (
          <div className="flex items-center gap-2 text-green-600 text-sm font-medium bg-green-50 px-3 py-1 rounded-full">
            <CheckCircle className="h-4 w-4" />
            <span>Configured</span>
          </div>
        )}
      </div>
      <div className="flex gap-3 items-center">
        <div className="relative flex-1">
          <Input
            id={`${provider}-key`}
            type={showKey ? "text" : "password"}
            value={tokenValue}
            onChange={handleInputChange}
            onFocus={() => setIsEditing(true)}
            onBlur={() => setIsEditing(false)}
            placeholder={placeholder}
            className="pr-12"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors duration-200 p-1 rounded"
            aria-label={showKey ? "Hide API Key" : "Show API Key"}
          >
            {showKey ? (
              <EyeOff className="h-5 w-5" />
            ) : (
              <Eye className="h-5 w-5" />
            )}
          </button>
        </div>
        {hasToken(provider) && (
          <Tooltip content="Clear API Key">
            <Button
              variant="outline"
              size="icon"
              onClick={() => clearToken(provider)}
              className="border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </Tooltip>
        )}
      </div>
      <p className="text-xs text-gray-500 flex items-center gap-1">
        Get your key from{" "}
        <a
          href={providerConsoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-700 font-medium inline-flex items-center gap-1 hover:underline"
        >
          {label} Console
          <ExternalLink className="h-3 w-3" />
        </a>
      </p>
    </div>
  );
};

export function SettingsTab() {
  const { getOllamaBaseUrl, setOllamaBaseUrl } = useAiProviderKeys();
  const themeMode = usePreferencesStore((s: any) => s.themeMode);

  const handleResetOllamaUrl = () => {
    setOllamaBaseUrl("http://localhost:11434");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      <div className="container mx-auto max-w-4xl p-6 space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-r from-blue-600 to-purple-600 rounded-2xl shadow-lg">
            <Settings className="h-8 w-8 text-white" />
          </div>
          <div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 bg-clip-text text-transparent">
              Settings
            </h1>
            <p className="text-gray-600 mt-2">
              Configure your AI providers and preferences
            </p>
          </div>
        </div>

        <div className="space-y-6">
          {/* API Keys Section */}
          <Card className="shadow-xl border-0">
            <CardHeader className="bg-gradient-to-r from-orange-600 to-orange-200 text-white">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                  <Key className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className="text-white text-xl">API Keys</CardTitle>
                  <p className="text-blue-100 text-sm mt-1">
                    Configure your LLM provider API keys. Keys are stored
                    securely in your browser.
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-8 bg-white">
              <ApiKeyInput
                provider="anthropic"
                label="Anthropic"
                placeholder="sk-ant-..."
                logoSrc="https://raw.githubusercontent.com/Sushant0412/inspector/4b56725b643a225d13dc0fb1b16e150397033d16/client/public/claude_logo.png"
                providerConsoleUrl="https://console.anthropic.com/"
              />
              <div className="border-t border-gray-100 pt-8">
                <ApiKeyInput
                  provider="openai"
                  label="OpenAI"
                  placeholder="sk-..."
                  logoSrc="https://raw.githubusercontent.com/Sushant0412/inspector/4b56725b643a225d13dc0fb1b16e150397033d16/client/public/openai_logo.png"
                  providerConsoleUrl="https://platform.openai.com/account/api-keys"
                />
              </div>
            </CardContent>
          </Card>

          {/* Ollama Configuration Section */}
          <Card className="shadow-xl border-0">
            <CardHeader className="bg-gradient-to-r from-green-600 to-teal-600 text-white">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center">
                  <img
                    src="https://raw.githubusercontent.com/Sushant0412/inspector/4b56725b643a225d13dc0fb1b16e150397033d16/client/public/ollama_dark.png"
                    alt=""
                  />
                </div>
                <div>
                  <CardTitle className="text-white text-xl">
                    Ollama Configuration
                  </CardTitle>
                  <p className="text-green-100 text-sm mt-1">
                    Configure your local Ollama server settings for self-hosted
                    models.
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 bg-white">
              <Label htmlFor="ollama-url" className="text-base">
                Base URL
              </Label>
              <div className="flex gap-3 items-center">
                <Input
                  id="ollama-url"
                  type="text"
                  value={getOllamaBaseUrl()}
                  onChange={(e) => setOllamaBaseUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                  className="font-mono"
                />
                <Tooltip content="Reset to default URL">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleResetOllamaUrl}
                    className="border-gray-300 hover:border-gray-400"
                  >
                    <Undo2 className="h-4 w-4" />
                  </Button>
                </Tooltip>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-blue-500">
                <p className="text-sm text-gray-700">
                  <span className="font-semibold">Default:</span>{" "}
                  <code className="bg-white px-2 py-1 rounded border text-blue-600 font-mono">
                    http://localhost:11434
                  </code>
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  Make sure your Ollama server is running and accessible at this
                  URL.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Footer */}
        <div className="text-center py-8">
          <p className="text-gray-500 text-sm">
            All settings are stored locally in your browser for privacy and
            security.
          </p>
        </div>
      </div>
    </div>
  );
}
