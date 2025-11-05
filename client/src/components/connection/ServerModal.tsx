import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Badge } from "../ui/badge";
import { Separator } from "../ui/separator";
import {
  ChevronDown,
  ChevronRight,
  Settings,
  Copy,
  Check,
  Loader2,
} from "lucide-react";
import { ServerFormData } from "@/shared/types.js";
import { ServerWithName } from "@/hooks/use-app-state";
import { getStoredTokens, hasOAuthConfig } from "@/lib/mcp-oauth";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import { usePostHog } from "posthog-js/react";
import { decodeJWT } from "@/lib/jwt-decoder";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/mcp-tools-api";

interface ServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: "add" | "edit";
  onSubmit: (formData: ServerFormData, originalServerName?: string) => void;
  server?: ServerWithName; // Required for edit mode
}

export function ServerModal({
  isOpen,
  onClose,
  mode,
  onSubmit,
  server,
}: ServerModalProps) {
  const posthog = usePostHog();
  const [serverFormData, setServerFormData] = useState<ServerFormData>({
    name: "",
    type: "stdio",
    command: "",
    args: [],
    url: "",
    headers: {},
    env: {},
    useOAuth: true,
    oauthScopes: [],
    clientId: "",
  });
  const [commandInput, setCommandInput] = useState("");
  const [oauthScopesInput, setOauthScopesInput] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [authType, setAuthType] = useState<"oauth" | "bearer" | "none">("none");
  const [useCustomClientId, setUseCustomClientId] = useState(false);
  const [clientIdError, setClientIdError] = useState<string | null>(null);
  const [clientSecretError, setClientSecretError] = useState<string | null>(
    null,
  );
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(
    [],
  );
  const [customHeaders, setCustomHeaders] = useState<
    Array<{ key: string; value: string }>
  >([]);
  const [requestTimeout, setRequestTimeout] = useState<string>("10000");
  const [showConfiguration, setShowConfiguration] = useState<boolean>(false);
  const [showEnvVars, setShowEnvVars] = useState<boolean>(false);
  const [showCustomHeaders, setShowCustomHeaders] = useState<boolean>(false);
  const [showAuthSettings, setShowAuthSettings] = useState<boolean>(false);
  const [showTokenInsights, setShowTokenInsights] = useState<boolean>(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [expandedTokens, setExpandedTokens] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<"config" | "auth" | "tools">(
    "config",
  );
  const [tools, setTools] = useState<ListToolsResultWithMetadata | null>(null);
  const [isLoadingTools, setIsLoadingTools] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);

  // Convert ServerWithName to ServerFormData format
  const convertServerConfig = (server: ServerWithName): ServerFormData => {
    const config = server.config;
    const isHttpServer = "url" in config;

    if (isHttpServer) {
      const headers =
        (config.requestInit?.headers as Record<string, string>) || {};

      // Check if OAuth is configured by looking at multiple sources:
      // 1. Check if server has oauth tokens
      // 2. Check if there's stored OAuth data (server URL, client info, config, or tokens)
      // 3. Check if the config has an oauth field
      const hasOAuthTokens = server.oauthTokens != null;
      const hasStoredOAuthConfig = hasOAuthConfig(server.name);
      const hasOAuthInConfig = "oauth" in config && config.oauth != null;
      const hasOAuth =
        hasOAuthTokens || hasStoredOAuthConfig || hasOAuthInConfig;

      const storedOAuthConfig = localStorage.getItem(
        `mcp-oauth-config-${server.name}`,
      );
      const storedClientInfo = localStorage.getItem(
        `mcp-client-${server.name}`,
      );
      const storedTokens = getStoredTokens(server.name);

      const clientInfo = storedClientInfo ? JSON.parse(storedClientInfo) : {};
      const oauthConfig = storedOAuthConfig
        ? JSON.parse(storedOAuthConfig)
        : {};

      // Retrieve scopes from multiple sources (in priority order)
      const scopes =
        server.oauthTokens?.scope?.split(" ") ||
        storedTokens?.scope?.split(" ") ||
        oauthConfig.scopes ||
        [];

      return {
        name: server.name,
        type: "http",
        url: config.url?.toString() || "",
        headers: headers,
        useOAuth: hasOAuth,
        oauthScopes: scopes,
        clientId:
          "clientId" in config
            ? typeof config.clientId === "string"
              ? config.clientId
              : ""
            : storedTokens?.client_id || clientInfo?.client_id || "",
        clientSecret:
          "clientSecret" in config
            ? typeof config.clientSecret === "string"
              ? config.clientSecret
              : ""
            : clientInfo?.client_secret || "",
        requestTimeout: config.timeout || 10000,
      };
    } else {
      return {
        name: server.name,
        type: "stdio",
        command: config.command || "",
        args: config.args || [],
        env: config.env || {},
        requestTimeout: config.timeout || 10000,
      };
    }
  };

  const getInitialFormData = (): ServerFormData => {
    if (mode === "edit" && server) {
      return convertServerConfig(server);
    }
    return {
      name: "",
      type: "stdio",
      command: "",
      args: [],
      url: "",
      headers: {},
      env: {},
      useOAuth: true,
      oauthScopes: [],
      clientId: "",
      requestTimeout: 10000,
    };
  };

  useEffect(() => {
    if (isOpen) {
      const formData = getInitialFormData();
      setServerFormData(formData);

      // Set timeout value
      setRequestTimeout(String(formData.requestTimeout || 10000));

      // Set additional form state
      if (formData.type === "stdio") {
        const command = formData.command || "";
        const args = formData.args || [];
        setCommandInput([command, ...args].join(" "));

        // Convert env object to key-value pairs
        const envEntries = Object.entries(formData.env || {}).map(
          ([key, value]) => ({
            key,
            value: String(value),
          }),
        );
        setEnvVars(envEntries);
        setShowEnvVars(envEntries.length > 0);
      } else {
        // HTTP server
        const headers = formData.headers || {};

        // Convert headers object to key-value pairs (excluding Authorization header)
        const headerEntries = Object.entries(headers)
          .filter(([key]) => key.toLowerCase() !== "authorization")
          .map(([key, value]) => ({
            key,
            value: String(value),
          }));
        setCustomHeaders(headerEntries);
        setShowCustomHeaders(headerEntries.length > 0);

        const authHeader = headers.Authorization;
        const hasBearerToken = authHeader?.startsWith("Bearer ");
        const hasOAuth = formData.useOAuth;

        if (hasOAuth) {
          setAuthType("oauth");
          setOauthScopesInput(formData.oauthScopes?.join(" ") || "mcp:*");

          setClientId(formData.clientId || "");
          setClientSecret(formData.clientSecret || "");
          setUseCustomClientId(!!formData.clientId);
          setShowAuthSettings(true);

          setServerFormData((prev) => ({ ...prev, useOAuth: true }));
        } else if (hasBearerToken) {
          setAuthType("bearer");
          setBearerToken(authHeader.slice(7)); // Remove 'Bearer ' prefix
          setShowAuthSettings(true);

          setServerFormData((prev) => ({ ...prev, useOAuth: false }));
        } else {
          setAuthType("none");
          setShowAuthSettings(false);

          setServerFormData((prev) => ({ ...prev, useOAuth: false }));
        }
      }
    }
  }, [mode, server, isOpen]);

  // Basic client ID validation
  const validateClientId = (id: string): string | null => {
    if (!id.trim()) {
      return "Client ID is required when using manual configuration";
    }

    const validPattern =
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
    if (!validPattern.test(id.trim())) {
      return "Client ID should contain only letters, numbers, dots, hyphens, and underscores";
    }

    if (id.trim().length < 3) {
      return "Client ID must be at least 3 characters long";
    }

    if (id.trim().length > 100) {
      return "Client ID must be less than 100 characters long";
    }

    return null;
  };

  // Basic client secret validation following OAuth 2.0 spec flexibility
  const validateClientSecret = (secret: string): string | null => {
    if (secret && secret.trim().length > 0) {
      if (secret.trim().length < 8) {
        return "Client secret should be at least 8 characters long for security";
      }

      if (secret.trim().length > 512) {
        return "Client secret must be less than 512 characters long";
      }

      // Check for common security issues
      if (secret === secret.toLowerCase() && secret.length < 16) {
        return "Client secret should contain mixed case or be longer for security";
      }
    }

    return null;
  };

  // Copy to clipboard helper
  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 2000); // Reset after 2 seconds
    } catch (error) {
      console.error("Failed to copy text:", error);
      toast.error("Failed to copy to clipboard");
    }
  };

  // Toggle token expansion
  const toggleTokenExpansion = (tokenName: string) => {
    setExpandedTokens((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(tokenName)) {
        newSet.delete(tokenName);
      } else {
        newSet.add(tokenName);
      }
      return newSet;
    });
  };

  // Load tools for the server (edit mode only)
  const loadTools = async () => {
    if (!server) return;

    setIsLoadingTools(true);
    setToolsError(null);
    try {
      const result = await listTools(server.name);
      setTools(result);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to load tools";
      setToolsError(errorMessage);
      toast.error(`Failed to load tools: ${errorMessage}`);
    } finally {
      setIsLoadingTools(false);
    }
  };

  // Load tools when switching to tools tab in edit mode
  useEffect(() => {
    if (
      isOpen &&
      mode === "edit" &&
      activeTab === "tools" &&
      server &&
      !tools
    ) {
      loadTools();
    }
  }, [isOpen, mode, activeTab, server]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validate Client ID if using custom configuration
    if (authType === "oauth" && useCustomClientId) {
      const clientIdError = validateClientId(clientId);
      if (clientIdError) {
        toast.error(clientIdError);
        return;
      }

      // Validate Client Secret if provided
      if (clientSecret) {
        const clientSecretError = validateClientSecret(clientSecret);
        if (clientSecretError) {
          toast.error(clientSecretError);
          return;
        }
      }
    }

    if (serverFormData.name) {
      let finalFormData = { ...serverFormData };

      // Add timeout configuration
      const reqTimeout = parseInt(requestTimeout) || 10000;
      finalFormData = {
        ...finalFormData,
        requestTimeout: reqTimeout,
      };

      if (serverFormData.type === "stdio" && commandInput) {
        const parts = commandInput.split(" ").filter((part) => part.trim());
        const command = parts[0] || "";
        const args = parts.slice(1);
        finalFormData = { ...finalFormData, command, args };

        // Add environment variables for STDIO
        const envObj = envVars.reduce(
          (acc, { key, value }) => {
            if (key && value) acc[key] = value;
            return acc;
          },
          {} as Record<string, string>,
        );
        finalFormData = { ...finalFormData, env: envObj };
      }

      if (serverFormData.type === "http") {
        // Add custom headers for HTTP
        const customHeadersObj = customHeaders.reduce(
          (acc, { key, value }) => {
            if (key && value) acc[key] = value;
            return acc;
          },
          {} as Record<string, string>,
        );
        if (authType === "none") {
          finalFormData = {
            ...finalFormData,
            useOAuth: false,
            headers: customHeadersObj, // Use custom headers only
          };
          delete (finalFormData as any).oauthScopes;
        } else if (authType === "bearer" && bearerToken) {
          finalFormData = {
            ...finalFormData,
            headers: {
              ...customHeadersObj,
              Authorization: `Bearer ${bearerToken}`,
            },
            useOAuth: false,
          };
          delete (finalFormData as any).oauthScopes;
        } else if (authType === "oauth" && serverFormData.useOAuth) {
          const scopes = (oauthScopesInput || "")
            .split(" ")
            .map((s) => s.trim())
            .filter(Boolean);
          finalFormData = {
            ...finalFormData,
            useOAuth: true,
            clientId: useCustomClientId
              ? clientId.trim() || undefined
              : undefined,
            clientSecret: useCustomClientId
              ? clientSecret.trim() || undefined
              : undefined,
            headers: customHeadersObj, // Use custom headers for OAuth too
          };
          if (scopes.length > 0) {
            (finalFormData as any).oauthScopes = scopes;
          } else {
            delete (finalFormData as any).oauthScopes;
          }
        }
      }

      if (mode === "edit") {
        onSubmit(finalFormData, server?.name);
      } else {
        onSubmit(finalFormData);
      }

      resetForm();
      onClose();
    }
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const resetForm = () => {
    setServerFormData({
      name: "",
      type: "stdio",
      command: "",
      args: [],
      url: "",
      headers: {},
      env: {},
      useOAuth: true,
      oauthScopes: [],
      clientId: "",
    });
    setCommandInput("");
    setOauthScopesInput("");
    setClientId("");
    setClientSecret("");
    setBearerToken("");
    setAuthType("none");
    setUseCustomClientId(false);
    setClientIdError(null);
    setClientSecretError(null);
    setEnvVars([]);
    setCustomHeaders([]);
    setRequestTimeout("10000");
    setShowConfiguration(false);
    setShowEnvVars(false);
    setShowCustomHeaders(false);
    setShowAuthSettings(false);
    setShowTokenInsights(false);
    setCopiedField(null);
    setExpandedTokens(new Set());
    setActiveTab("config");
    setTools(null);
    setIsLoadingTools(false);
    setToolsError(null);
  };

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: "", value: "" }]);
    setShowEnvVars(true);
  };

  const updateEnvVar = (
    index: number,
    field: "key" | "value",
    value: string,
  ) => {
    const updated = [...envVars];
    updated[index][field] = value;
    setEnvVars(updated);
  };

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  const addCustomHeader = () => {
    setCustomHeaders([...customHeaders, { key: "", value: "" }]);
    setShowCustomHeaders(true);
  };

  const updateCustomHeader = (
    index: number,
    field: "key" | "value",
    value: string,
  ) => {
    const updated = [...customHeaders];
    updated[index][field] = value;
    setCustomHeaders(updated);
  };

  const removeCustomHeader = (index: number) => {
    setCustomHeaders(customHeaders.filter((_, i) => i !== index));
  };

  const dialogTitle = mode === "add" ? "Add MCP Server" : "Edit MCP Server";

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader className="space-y-3">
          <DialogTitle className="flex text-xl font-semibold">
            <img src="/mcp.svg" alt="MCP" className="mr-2" /> {dialogTitle}
          </DialogTitle>

          {/* Tab switcher for edit mode */}
          {mode === "edit" && (
            <div className="flex gap-2 border-b border-border">
              <button
                type="button"
                onClick={() => setActiveTab("config")}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === "config"
                    ? "border-b-2 border-primary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Configuration
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("auth")}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === "auth"
                    ? "border-b-2 border-primary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Authentication
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("tools")}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === "tools"
                    ? "border-b-2 border-primary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Widget Metadata
              </button>
            </div>
          )}
        </DialogHeader>

        {/* Show configuration form when in add mode or config tab is active */}
        {(mode === "add" || activeTab === "config") && (
          <>
            <form
              onSubmit={(e) => {
                posthog.capture("add_server_button_clicked", {
                  location: "server_modal",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                });
                handleSubmit(e);
              }}
              className="space-y-6"
            >
              <div className="space-y-2">
                <label className="block text-sm font-medium text-foreground">
                  Server Name
                </label>
                <Input
                  value={serverFormData.name}
                  onChange={(e) =>
                    setServerFormData((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                  placeholder="my-mcp-server"
                  required
                  className="h-10"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-foreground">
                  Connection Type
                </label>
                {serverFormData.type === "stdio" ? (
                  <div className="flex">
                    <Select
                      value={serverFormData.type}
                      onValueChange={(value: "stdio" | "http") =>
                        setServerFormData((prev) => ({
                          ...prev,
                          type: value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-22 rounded-r-none border-r-0 text-xs border-border">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="stdio">STDIO</SelectItem>
                        <SelectItem value="http">HTTP/SSE</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      value={commandInput}
                      onChange={(e) => setCommandInput(e.target.value)}
                      placeholder="npx -y @modelcontextprotocol/server-everything"
                      required
                      className="flex-1 rounded-l-none text-sm border-border"
                    />
                  </div>
                ) : (
                  <div className="flex">
                    <Select
                      value={serverFormData.type}
                      onValueChange={(value: "stdio" | "http") =>
                        setServerFormData((prev) => ({
                          ...prev,
                          type: value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-22 rounded-r-none border-r-0 text-xs border-border">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="stdio">STDIO</SelectItem>
                        <SelectItem value="http">HTTP</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      value={serverFormData.url}
                      onChange={(e) =>
                        setServerFormData((prev) => ({
                          ...prev,
                          url: e.target.value,
                        }))
                      }
                      placeholder="http://localhost:8080/mcp"
                      required
                      className="flex-1 rounded-l-none text-sm border-border"
                    />
                  </div>
                )}
              </div>

              {/* Environment Variables for STDIO */}
              {serverFormData.type === "stdio" && (
                <div className="border border-border rounded-lg overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowEnvVars(!showEnvVars)}
                    className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      {showEnvVars ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span className="text-sm font-medium text-foreground">
                        Environment Variables
                      </span>
                      {envVars.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          ({envVars.length})
                        </span>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        addEnvVar();
                      }}
                      className="text-xs"
                    >
                      Add Variable
                    </Button>
                  </button>

                  {showEnvVars && envVars.length > 0 && (
                    <div className="p-4 space-y-2 border-t border-border bg-muted/30 max-h-48 overflow-y-auto">
                      {envVars.map((envVar, index) => (
                        <div key={index} className="flex gap-2 items-center">
                          <Input
                            value={envVar.key}
                            onChange={(e) =>
                              updateEnvVar(index, "key", e.target.value)
                            }
                            placeholder="KEY"
                            className="flex-1 text-xs"
                          />
                          <Input
                            value={envVar.value}
                            onChange={(e) =>
                              updateEnvVar(index, "value", e.target.value)
                            }
                            placeholder="value"
                            className="flex-1 text-xs"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => removeEnvVar(index)}
                            className="px-2 text-xs"
                          >
                            ×
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Authentication for HTTP (only in add mode - edit mode has separate auth tab) */}
              {mode === "add" && serverFormData.type === "http" && (
                <div className="space-y-4">
                  <div className="border border-border rounded-lg overflow-hidden">
                    <div className="p-3 space-y-2">
                      <label className="block text-sm font-medium text-foreground">
                        Authentication
                      </label>
                      <Select
                        value={authType}
                        onValueChange={(value: "oauth" | "bearer" | "none") => {
                          setAuthType(value);
                          setShowAuthSettings(value !== "none");
                          if (value === "oauth") {
                            setServerFormData((prev) => ({
                              ...prev,
                              useOAuth: true,
                            }));
                          } else {
                            setServerFormData((prev) => ({
                              ...prev,
                              useOAuth: false,
                            }));
                          }
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">
                            No Authentication
                          </SelectItem>
                          <SelectItem value="bearer">Bearer Token</SelectItem>
                          <SelectItem value="oauth">OAuth 2.0</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Bearer Token Settings */}
                    {showAuthSettings && authType === "bearer" && (
                      <div className="px-3 pb-3 space-y-2 border-t border-border bg-muted/30">
                        <label className="block text-sm font-medium text-foreground pt-3">
                          Bearer Token
                        </label>
                        <Input
                          type="password"
                          value={bearerToken}
                          onChange={(e) => setBearerToken(e.target.value)}
                          placeholder="Enter your bearer token"
                          className="h-10"
                        />
                      </div>
                    )}

                    {/* OAuth Settings */}
                    {showAuthSettings && authType === "oauth" && (
                      <div className="px-3 pb-3 space-y-3 border-t border-border bg-muted/30">
                        <div className="space-y-2 pt-3">
                          <label className="block text-sm font-medium text-foreground">
                            OAuth Scopes
                          </label>
                          <Input
                            value={oauthScopesInput}
                            onChange={(e) =>
                              setOauthScopesInput(e.target.value)
                            }
                            placeholder="mcp:* or custom scopes separated by spaces"
                            className="h-10"
                          />
                          <p className="text-xs text-muted-foreground">
                            Default: mcp:* (space-separated for multiple scopes)
                          </p>
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center space-x-2">
                            <input
                              type="checkbox"
                              id="useCustomClientId"
                              checked={useCustomClientId}
                              onChange={(e) => {
                                setUseCustomClientId(e.target.checked);
                                if (!e.target.checked) {
                                  setClientId("");
                                  setClientSecret("");
                                  setClientIdError(null);
                                  setClientSecretError(null);
                                }
                              }}
                              className="rounded"
                            />
                            <label
                              htmlFor="useCustomClientId"
                              className="text-sm font-medium text-foreground"
                            >
                              Use custom OAuth credentials
                            </label>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Leave unchecked to use the server's default OAuth
                            flow
                          </p>
                        </div>

                        {useCustomClientId && (
                          <div className="space-y-3">
                            <div className="space-y-2">
                              <label className="block text-sm font-medium text-foreground">
                                Client ID
                              </label>
                              <Input
                                value={clientId}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setClientId(value);
                                  const error = validateClientId(value);
                                  setClientIdError(error);
                                }}
                                placeholder="Your OAuth Client ID"
                                className={`h-10 ${
                                  clientIdError ? "border-red-500" : ""
                                }`}
                              />
                              {clientIdError && (
                                <p className="text-xs text-red-500">
                                  {clientIdError}
                                </p>
                              )}
                            </div>

                            <div className="space-y-2">
                              <label className="block text-sm font-medium text-foreground">
                                Client Secret (Optional)
                              </label>
                              <Input
                                type="password"
                                value={clientSecret}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setClientSecret(value);
                                  const error = validateClientSecret(value);
                                  setClientSecretError(error);
                                }}
                                placeholder="Your OAuth Client Secret"
                                className={`h-10 ${
                                  clientSecretError ? "border-red-500" : ""
                                }`}
                              />
                              {clientSecretError && (
                                <p className="text-xs text-red-500">
                                  {clientSecretError}
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground">
                                Optional for public clients using PKCE
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Custom Headers for HTTP */}
              {serverFormData.type === "http" && (
                <div className="space-y-4">
                  <div className="border border-border rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowCustomHeaders(!showCustomHeaders)}
                      className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        {showCustomHeaders ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="text-sm font-medium text-foreground">
                          Custom Headers
                        </span>
                        {customHeaders.length > 0 && (
                          <span className="text-xs text-muted-foreground">
                            ({customHeaders.length})
                          </span>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          addCustomHeader();
                        }}
                        className="text-xs"
                      >
                        Add Header
                      </Button>
                    </button>

                    {showCustomHeaders && customHeaders.length > 0 && (
                      <div className="p-4 space-y-2 border-t border-border bg-muted/30 max-h-48 overflow-y-auto">
                        {customHeaders.map((header, index) => (
                          <div key={index} className="flex gap-2 items-center">
                            <Input
                              value={header.key}
                              onChange={(e) =>
                                updateCustomHeader(index, "key", e.target.value)
                              }
                              placeholder="Header-Name"
                              className="flex-1 text-xs"
                            />
                            <Input
                              value={header.value}
                              onChange={(e) =>
                                updateCustomHeader(
                                  index,
                                  "value",
                                  e.target.value,
                                )
                              }
                              placeholder="header-value"
                              className="flex-1 text-xs"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => removeCustomHeader(index)}
                              className="px-2 text-xs"
                            >
                              ×
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    {!showCustomHeaders && (
                      <div className="px-3 pb-3">
                        <p className="text-xs text-muted-foreground">
                          Add custom HTTP headers for your MCP server connection
                          (e.g. API-Key, X-Custom-Header)
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Configuration Section */}
              <div className="border border-border rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowConfiguration(!showConfiguration)}
                  className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    {showConfiguration ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="text-sm font-medium text-foreground">
                      Additional Configuration
                    </span>
                  </div>
                </button>

                {showConfiguration && (
                  <div className="p-4 space-y-4 border-t border-border bg-muted/30">
                    {/* Request Timeout */}
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-foreground">
                        Request Timeout
                      </label>
                      <Input
                        type="number"
                        value={requestTimeout}
                        onChange={(e) => setRequestTimeout(e.target.value)}
                        placeholder="10000"
                        className="h-10"
                        min="1000"
                        max="600000"
                        step="1000"
                      />
                      <p className="text-xs text-muted-foreground">
                        Timeout in ms (default: 10000ms, min: 1000ms, max:
                        600000ms)
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Server Info section (only in edit mode) */}
              {mode === "edit" && server && server.initializationInfo && (
                <div className="border border-border rounded-lg overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowConfiguration(!showConfiguration)}
                    className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      {showConfiguration ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span className="text-sm font-medium text-foreground">
                        Server Info
                      </span>
                    </div>
                  </button>

                  {showConfiguration && (
                    <div className="p-4 space-y-4 border-t border-border bg-muted/30">
                      {/* Connection Details */}
                      <div className="space-y-3">
                        <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">
                          Connection Details
                        </h4>
                        {server.initializationInfo.protocolVersion && (
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">
                              Protocol Version
                            </span>
                            <Badge
                              variant="secondary"
                              className="font-mono text-xs"
                            >
                              {server.initializationInfo.protocolVersion}
                            </Badge>
                          </div>
                        )}
                        {server.initializationInfo.transport && (
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">
                              Transport
                            </span>
                            <Badge
                              variant="secondary"
                              className="font-mono uppercase text-xs"
                            >
                              {server.initializationInfo.transport}
                            </Badge>
                          </div>
                        )}
                        {server.initializationInfo.serverVersion && (
                          <>
                            <div className="flex items-center justify-between">
                              <span className="text-sm text-muted-foreground">
                                Server Name
                              </span>
                              <span className="text-sm font-mono">
                                {server.initializationInfo.serverVersion.name}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-sm text-muted-foreground">
                                Server Version
                              </span>
                              <Badge
                                variant="outline"
                                className="font-mono text-xs"
                              >
                                {
                                  server.initializationInfo.serverVersion
                                    .version
                                }
                              </Badge>
                            </div>
                          </>
                        )}
                      </div>

                      {/* Server Instructions */}
                      {server.initializationInfo.instructions && (
                        <div className="space-y-3 pt-2 border-t border-border/50">
                          <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">
                            Server Instructions
                          </h4>
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            {server.initializationInfo.instructions}
                          </p>
                        </div>
                      )}

                      {/* Server Capabilities */}
                      {server.initializationInfo.serverCapabilities && (
                        <div className="space-y-3 pt-2 border-t border-border/50">
                          <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">
                            Server Capabilities
                          </h4>
                          <JsonView
                            src={server.initializationInfo.serverCapabilities}
                            theme="atom"
                            dark={true}
                            enableClipboard={true}
                            displaySize={false}
                            collapseStringsAfterLength={100}
                            style={{
                              fontSize: "11px",
                              fontFamily:
                                "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                              backgroundColor: "hsl(var(--background))",
                              padding: "8px",
                              borderRadius: "6px",
                              border: "1px solid hsl(var(--border))",
                            }}
                          />
                        </div>
                      )}

                      {/* Client Capabilities */}
                      {server.initializationInfo.clientCapabilities && (
                        <div className="space-y-3 pt-2 border-t border-border/50">
                          <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">
                            Client Capabilities
                          </h4>
                          <JsonView
                            src={server.initializationInfo.clientCapabilities}
                            theme="atom"
                            dark={true}
                            enableClipboard={true}
                            displaySize={false}
                            collapseStringsAfterLength={100}
                            style={{
                              fontSize: "11px",
                              fontFamily:
                                "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                              backgroundColor: "hsl(var(--background))",
                              padding: "8px",
                              borderRadius: "6px",
                              border: "1px solid hsl(var(--border))",
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end space-x-2 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    posthog.capture("cancel_button_clicked", {
                      location: "server_modal",
                      platform: detectPlatform(),
                      environment: detectEnvironment(),
                    });
                    handleClose();
                  }}
                  className="px-4"
                >
                  Cancel
                </Button>
                <Button type="submit" className="px-4">
                  {mode === "add" ? "Add Server" : "Update Server"}
                </Button>
              </div>
            </form>
          </>
        )}

        {/* Show authentication tab when in edit mode and auth tab is active */}
        {mode === "edit" && activeTab === "auth" && server && (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold">Authentication Settings</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Configure authentication for your MCP server connection
              </p>
            </div>

            {serverFormData.type === "http" ? (
              <div className="space-y-4">
                {/* Authentication Type Selection */}
                <div className="border border-border rounded-lg overflow-hidden">
                  <div className="p-3 space-y-2">
                    <label className="block text-sm font-medium text-foreground">
                      Authentication Type
                    </label>
                    <Select
                      value={authType}
                      onValueChange={(value: "oauth" | "bearer" | "none") => {
                        setAuthType(value);
                        setShowAuthSettings(value !== "none");
                        if (value === "oauth") {
                          setServerFormData((prev) => ({
                            ...prev,
                            useOAuth: true,
                          }));
                        } else {
                          setServerFormData((prev) => ({
                            ...prev,
                            useOAuth: false,
                          }));
                        }
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No Authentication</SelectItem>
                        <SelectItem value="bearer">Bearer Token</SelectItem>
                        <SelectItem value="oauth">OAuth 2.0</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Bearer Token Settings */}
                  {showAuthSettings && authType === "bearer" && (
                    <div className="px-3 pb-3 space-y-2 border-t border-border bg-muted/30">
                      <label className="block text-sm font-medium text-foreground pt-3">
                        Bearer Token
                      </label>
                      <Input
                        type="password"
                        value={bearerToken}
                        onChange={(e) => setBearerToken(e.target.value)}
                        placeholder="Enter your bearer token"
                        className="h-10"
                      />
                    </div>
                  )}

                  {/* OAuth Settings */}
                  {showAuthSettings && authType === "oauth" && (
                    <div className="px-3 pb-3 space-y-3 border-t border-border bg-muted/30">
                      <div className="space-y-2 pt-3">
                        <label className="block text-sm font-medium text-foreground">
                          OAuth Scopes
                        </label>
                        <Input
                          value={oauthScopesInput}
                          onChange={(e) => setOauthScopesInput(e.target.value)}
                          placeholder="mcp:* or custom scopes separated by spaces"
                          className="h-10"
                        />
                        <p className="text-xs text-muted-foreground">
                          Default: mcp:* (space-separated for multiple scopes)
                        </p>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id="useCustomClientId"
                            checked={useCustomClientId}
                            onChange={(e) => {
                              setUseCustomClientId(e.target.checked);
                              if (!e.target.checked) {
                                setClientId("");
                                setClientSecret("");
                                setClientIdError(null);
                                setClientSecretError(null);
                              }
                            }}
                            className="rounded"
                          />
                          <label
                            htmlFor="useCustomClientId"
                            className="text-sm font-medium text-foreground"
                          >
                            Use custom OAuth credentials
                          </label>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Leave unchecked to use the server's default OAuth flow
                        </p>
                      </div>

                      {useCustomClientId && (
                        <div className="space-y-3">
                          <div className="space-y-2">
                            <label className="block text-sm font-medium text-foreground">
                              Client ID
                            </label>
                            <Input
                              value={clientId}
                              onChange={(e) => {
                                const value = e.target.value;
                                setClientId(value);
                                const error = validateClientId(value);
                                setClientIdError(error);
                              }}
                              placeholder="Your OAuth Client ID"
                              className={`h-10 ${
                                clientIdError ? "border-red-500" : ""
                              }`}
                            />
                            {clientIdError && (
                              <p className="text-xs text-red-500">
                                {clientIdError}
                              </p>
                            )}
                          </div>

                          <div className="space-y-2">
                            <label className="block text-sm font-medium text-foreground">
                              Client Secret (Optional)
                            </label>
                            <Input
                              type="password"
                              value={clientSecret}
                              onChange={(e) => {
                                const value = e.target.value;
                                setClientSecret(value);
                                const error = validateClientSecret(value);
                                setClientSecretError(error);
                              }}
                              placeholder="Your OAuth Client Secret"
                              className={`h-10 ${
                                clientSecretError ? "border-red-500" : ""
                              }`}
                            />
                            {clientSecretError && (
                              <p className="text-xs text-red-500">
                                {clientSecretError}
                              </p>
                            )}
                            <p className="text-xs text-muted-foreground">
                              Optional for public clients using PKCE
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Token Insights (OAuth only) */}
                {(authType === "oauth" || server.oauthTokens) &&
                  (() => {
                    const tokens =
                      server.oauthTokens || getStoredTokens(server.name);
                    if (!tokens) return null;

                    return (
                      <div className="border border-border rounded-lg overflow-hidden">
                        <button
                          type="button"
                          onClick={() =>
                            setShowTokenInsights(!showTokenInsights)
                          }
                          className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors cursor-pointer"
                        >
                          <div className="flex items-center gap-2">
                            {showTokenInsights ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                            <span className="text-sm font-medium text-foreground">
                              OAuth Tokens
                            </span>
                          </div>
                        </button>

                        {showTokenInsights && (
                          <div className="p-4 space-y-3 border-t border-border bg-muted/30">
                            {/* Access Token */}
                            <div>
                              <span className="text-xs text-muted-foreground font-medium">
                                Access Token:
                              </span>
                              <div
                                className="font-mono text-xs text-foreground break-all bg-background/50 p-2 rounded mt-1 relative group cursor-pointer hover:bg-background/70 transition-colors"
                                onClick={() =>
                                  toggleTokenExpansion("accessToken")
                                }
                              >
                                <div className="pr-8">
                                  {expandedTokens.has("accessToken") ||
                                  tokens.access_token.length <= 50
                                    ? tokens.access_token
                                    : `${tokens.access_token.substring(0, 50)}...`}
                                </div>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyToClipboard(
                                      tokens.access_token,
                                      "accessToken",
                                    );
                                  }}
                                  className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer"
                                >
                                  {copiedField === "accessToken" ? (
                                    <Check className="h-3 w-3 text-green-500" />
                                  ) : (
                                    <Copy className="h-3 w-3" />
                                  )}
                                </button>
                              </div>
                              {(() => {
                                const decoded = decodeJWT(tokens.access_token);
                                if (!decoded) return null;
                                return (
                                  <div className="mt-2">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        toggleTokenExpansion(
                                          "accessTokenDecoded",
                                        )
                                      }
                                      className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1"
                                    >
                                      {expandedTokens.has(
                                        "accessTokenDecoded",
                                      ) ? (
                                        <ChevronDown className="h-3 w-3" />
                                      ) : (
                                        <ChevronRight className="h-3 w-3" />
                                      )}
                                      View Decoded JWT
                                    </button>
                                    {expandedTokens.has(
                                      "accessTokenDecoded",
                                    ) && (
                                      <div className="mt-1">
                                        <JsonView
                                          src={decoded}
                                          theme="atom"
                                          dark={true}
                                          enableClipboard={true}
                                          displaySize={false}
                                          collapseStringsAfterLength={100}
                                          style={{
                                            fontSize: "11px",
                                            fontFamily:
                                              "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                                            backgroundColor:
                                              "hsl(var(--background))",
                                            padding: "8px",
                                            borderRadius: "6px",
                                            border:
                                              "1px solid hsl(var(--border))",
                                          }}
                                        />
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>

                            {/* Refresh Token */}
                            {tokens.refresh_token && (
                              <div>
                                <span className="text-xs text-muted-foreground font-medium">
                                  Refresh Token:
                                </span>
                                <div
                                  className="font-mono text-xs text-foreground break-all bg-background/50 p-2 rounded mt-1 relative group cursor-pointer hover:bg-background/70 transition-colors"
                                  onClick={() =>
                                    toggleTokenExpansion("refreshToken")
                                  }
                                >
                                  <div className="pr-8">
                                    {expandedTokens.has("refreshToken") ||
                                    tokens.refresh_token.length <= 50
                                      ? tokens.refresh_token
                                      : `${tokens.refresh_token.substring(0, 50)}...`}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      copyToClipboard(
                                        tokens.refresh_token || "",
                                        "refreshToken",
                                      );
                                    }}
                                    className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer"
                                  >
                                    {copiedField === "refreshToken" ? (
                                      <Check className="h-3 w-3 text-green-500" />
                                    ) : (
                                      <Copy className="h-3 w-3" />
                                    )}
                                  </button>
                                </div>
                                {(() => {
                                  const decoded = decodeJWT(
                                    tokens.refresh_token,
                                  );
                                  if (!decoded) return null;
                                  return (
                                    <div className="mt-2">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          toggleTokenExpansion(
                                            "refreshTokenDecoded",
                                          )
                                        }
                                        className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1"
                                      >
                                        {expandedTokens.has(
                                          "refreshTokenDecoded",
                                        ) ? (
                                          <ChevronDown className="h-3 w-3" />
                                        ) : (
                                          <ChevronRight className="h-3 w-3" />
                                        )}
                                        View Decoded JWT
                                      </button>
                                      {expandedTokens.has(
                                        "refreshTokenDecoded",
                                      ) && (
                                        <div className="mt-1">
                                          <JsonView
                                            src={decoded}
                                            theme="atom"
                                            dark={true}
                                            enableClipboard={true}
                                            displaySize={false}
                                            collapseStringsAfterLength={100}
                                            style={{
                                              fontSize: "11px",
                                              fontFamily:
                                                "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                                              backgroundColor:
                                                "hsl(var(--background))",
                                              padding: "8px",
                                              borderRadius: "6px",
                                              border:
                                                "1px solid hsl(var(--border))",
                                            }}
                                          />
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                            )}

                            {/* ID Token */}
                            {(tokens as any).id_token && (
                              <div>
                                <span className="text-xs text-muted-foreground font-medium">
                                  ID Token:
                                </span>
                                <div
                                  className="font-mono text-xs text-foreground break-all bg-background/50 p-2 rounded mt-1 relative group cursor-pointer hover:bg-background/70 transition-colors"
                                  onClick={() =>
                                    toggleTokenExpansion("idToken")
                                  }
                                >
                                  <div className="pr-8">
                                    {expandedTokens.has("idToken") ||
                                    (tokens as any).id_token.length <= 50
                                      ? (tokens as any).id_token
                                      : `${(tokens as any).id_token.substring(0, 50)}...`}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      copyToClipboard(
                                        (tokens as any).id_token || "",
                                        "idToken",
                                      );
                                    }}
                                    className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer"
                                  >
                                    {copiedField === "idToken" ? (
                                      <Check className="h-3 w-3 text-green-500" />
                                    ) : (
                                      <Copy className="h-3 w-3" />
                                    )}
                                  </button>
                                </div>
                                {(() => {
                                  const decoded = decodeJWT(
                                    (tokens as any).id_token,
                                  );
                                  if (!decoded) return null;
                                  return (
                                    <div className="mt-2">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          toggleTokenExpansion("idTokenDecoded")
                                        }
                                        className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1"
                                      >
                                        {expandedTokens.has(
                                          "idTokenDecoded",
                                        ) ? (
                                          <ChevronDown className="h-3 w-3" />
                                        ) : (
                                          <ChevronRight className="h-3 w-3" />
                                        )}
                                        View Decoded JWT
                                      </button>
                                      {expandedTokens.has("idTokenDecoded") && (
                                        <div className="mt-1">
                                          <JsonView
                                            src={decoded}
                                            theme="atom"
                                            dark={true}
                                            enableClipboard={true}
                                            displaySize={false}
                                            collapseStringsAfterLength={100}
                                            style={{
                                              fontSize: "11px",
                                              fontFamily:
                                                "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                                              backgroundColor:
                                                "hsl(var(--background))",
                                              padding: "8px",
                                              borderRadius: "6px",
                                              border:
                                                "1px solid hsl(var(--border))",
                                            }}
                                          />
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                            )}

                            {/* Token Metadata */}
                            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground pt-2 border-t border-border">
                              <span>Type: {tokens.token_type || "Bearer"}</span>
                              {tokens.expires_in && (
                                <span>Expires in: {tokens.expires_in}s</span>
                              )}
                              {tokens.scope && (
                                <span>Scope: {tokens.scope}</span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}
              </div>
            ) : (
              <div className="bg-muted/30 rounded-lg p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  Authentication settings are only available for HTTP/SSE
                  servers. STDIO servers use process-level authentication.
                </p>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex justify-end space-x-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  posthog.capture("cancel_button_clicked", {
                    location: "server_modal",
                    platform: detectPlatform(),
                    environment: detectEnvironment(),
                  });
                  handleClose();
                }}
                className="px-4"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={(e) => {
                  posthog.capture("update_server_button_clicked", {
                    location: "server_modal_auth_tab",
                    platform: detectPlatform(),
                    environment: detectEnvironment(),
                  });
                  handleSubmit(e as any);
                }}
                className="px-4"
              >
                Update Server
              </Button>
            </div>
          </div>
        )}

        {/* Show tools section when in edit mode and tools tab is active */}
        {mode === "edit" && activeTab === "tools" && (
          <div className="space-y-6">
            <div>
              <div className="mb-3">
                <h3 className="text-lg font-semibold">Actions</h3>
              </div>

              {isLoadingTools && !tools ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : toolsError ? (
                <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/30 rounded-lg p-4 text-sm text-red-600 dark:text-red-400">
                  {toolsError}
                </div>
              ) : tools && tools.tools.length > 0 ? (
                (() => {
                  // Filter tools that have metadata
                  const toolsWithMetadata = tools.tools.filter(
                    (tool) => tools.toolsMetadata?.[tool.name],
                  );

                  if (toolsWithMetadata.length === 0) {
                    return (
                      <div className="bg-muted/30 rounded-lg p-8 text-center">
                        <p className="text-sm text-muted-foreground">
                          No widget metadata
                        </p>
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-3">
                      {toolsWithMetadata.map((tool) => {
                        const metadata = tools.toolsMetadata?.[tool.name];

                        return (
                          <div
                            key={tool.name}
                            className="bg-muted/30 rounded-lg p-4 space-y-2 hover:bg-muted/50 transition-colors"
                          >
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <h4 className="font-medium text-sm">
                                    {tool.name}
                                  </h4>
                                  {metadata.write !== undefined && (
                                    <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded-md uppercase">
                                      {metadata.write ? "WRITE" : "READ"}
                                    </span>
                                  )}
                                </div>
                                <p className="text-sm text-muted-foreground mt-1">
                                  {tool.description ||
                                    "No description available"}
                                </p>
                              </div>
                            </div>

                            {/* Metadata Section - Show all metadata fields */}
                            <div className="mt-3 pt-3 border-t border-border/50">
                              <div className="text-xs text-muted-foreground font-medium mb-2">
                                METADATA
                              </div>

                              {Object.entries(metadata).map(([key, value]) => {
                                // Skip the 'write' field as it's already shown as a badge
                                if (key === "write") return null;

                                return (
                                  <div key={key} className="space-y-1 mt-2">
                                    <div className="text-xs text-muted-foreground">
                                      {key.replace(/([A-Z])/g, " $1").trim()}
                                    </div>
                                    <div
                                      className={`text-xs rounded px-2 py-1 ${
                                        typeof value === "string" &&
                                        value.includes("://")
                                          ? "font-mono bg-muted/50"
                                          : "bg-muted/50"
                                      }`}
                                    >
                                      {typeof value === "object"
                                        ? JSON.stringify(value, null, 2)
                                        : String(value)}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()
              ) : (
                <div className="bg-muted/30 rounded-lg p-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    No actions available for this server
                  </p>
                </div>
              )}
            </div>

            {/* Close button for tools view */}
            <div className="flex justify-end space-x-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  posthog.capture("cancel_button_clicked", {
                    location: "server_modal",
                    platform: detectPlatform(),
                    environment: detectEnvironment(),
                  });
                  handleClose();
                }}
                className="px-4"
              >
                Close
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
