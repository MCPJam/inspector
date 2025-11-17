import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Badge } from "../ui/badge";
import { ChevronDown, ChevronRight, Copy, Check, Loader2 } from "lucide-react";
import { ServerFormData } from "@/shared/types.js";
import { ServerWithName } from "@/hooks/use-app-state";
import { getStoredTokens } from "@/lib/mcp-oauth";
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
import { useServerForm } from "./hooks/use-server-form";
import { AuthenticationSection } from "./shared/AuthenticationSection";
import { CustomHeadersSection } from "./shared/CustomHeadersSection";
import { EnvVarsSection } from "./shared/EnvVarsSection";

interface EditServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (
    formData: ServerFormData,
    originalServerName: string,
    skipAutoConnect?: boolean,
  ) => void;
  server: ServerWithName;
  skipAutoConnect?: boolean;
}

export function EditServerModal({
  isOpen,
  onClose,
  onSubmit,
  server,
  skipAutoConnect = false,
}: EditServerModalProps) {
  const posthog = usePostHog();
  const [activeTab, setActiveTab] = useState<"config" | "auth" | "tools">(
    "config",
  );
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [expandedTokens, setExpandedTokens] = useState<Set<string>>(new Set());
  const [showTokenInsights, setShowTokenInsights] = useState<boolean>(false);
  const [showServerInfo, setShowServerInfo] = useState<boolean>(false);
  const [tools, setTools] = useState<ListToolsResultWithMetadata | null>(null);
  const [isLoadingTools, setIsLoadingTools] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);

  // Use the shared form hook
  const {
    serverFormData,
    setServerFormData,
    commandInput,
    setCommandInput,
    oauthScopesInput,
    setOauthScopesInput,
    clientId,
    setClientId,
    clientSecret,
    setClientSecret,
    bearerToken,
    setBearerToken,
    authType,
    setAuthType,
    useCustomClientId,
    setUseCustomClientId,
    requestTimeout,
    setRequestTimeout,
    clientIdError,
    setClientIdError,
    clientSecretError,
    setClientSecretError,
    envVars,
    customHeaders,
    showConfiguration,
    setShowConfiguration,
    showEnvVars,
    setShowEnvVars,
    showCustomHeaders,
    setShowCustomHeaders,
    showAuthSettings,
    setShowAuthSettings,
    validateClientId,
    validateClientSecret,
    addEnvVar,
    removeEnvVar,
    updateEnvVar,
    addCustomHeader,
    removeCustomHeader,
    updateCustomHeader,
    buildFormData,
  } = useServerForm(server);

  // Copy to clipboard helper
  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 2000);
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

  // Load tools for the server
  const loadTools = async () => {
    if (!server) return;

    // Check if server is connected
    if (server.connectionStatus !== "connected") {
      setToolsError("not-connected");
      setIsLoadingTools(false);
      return;
    }

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

  // Load tools when switching to tools tab
  useEffect(() => {
    if (isOpen && activeTab === "tools" && server && !tools) {
      loadTools();
    }
  }, [isOpen, activeTab, server]);

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

    const finalFormData = buildFormData();
    onSubmit(finalFormData, server.name, skipAutoConnect);
    handleClose();
  };

  const handleClose = () => {
    setActiveTab("config");
    setCopiedField(null);
    setExpandedTokens(new Set());
    setShowTokenInsights(false);
    setShowServerInfo(false);
    setTools(null);
    setIsLoadingTools(false);
    setToolsError(null);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader className="space-y-3">
          <DialogTitle className="flex text-xl font-semibold">
            <img src="/mcp.svg" alt="MCP" className="mr-2" /> Edit MCP Server
          </DialogTitle>
          <DialogDescription className="sr-only">
            Edit your MCP server configuration, authentication settings, and
            view widget metadata
          </DialogDescription>

          {/* Tab switcher */}
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
        </DialogHeader>

        {/* Configuration Tab */}
        {activeTab === "config" && (
          <form
            onSubmit={(e) => {
              posthog.capture("update_server_button_clicked", {
                location: "server_modal_config_tab",
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

            {/* Connection Type */}
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
                      <SelectItem value="http">HTTP</SelectItem>
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
              <EnvVarsSection
                envVars={envVars}
                showEnvVars={showEnvVars}
                onToggle={() => setShowEnvVars(!showEnvVars)}
                onAdd={addEnvVar}
                onRemove={removeEnvVar}
                onUpdate={updateEnvVar}
              />
            )}

            {/* Custom Headers for HTTP */}
            {serverFormData.type === "http" && (
              <CustomHeadersSection
                customHeaders={customHeaders}
                showCustomHeaders={showCustomHeaders}
                onToggle={() => setShowCustomHeaders(!showCustomHeaders)}
                onAdd={addCustomHeader}
                onRemove={removeCustomHeader}
                onUpdate={updateCustomHeader}
              />
            )}

            {/* Additional Configuration Section */}
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

            {/* Server Info section */}
            {server && server.initializationInfo && (
              <div className="border border-border rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowServerInfo(!showServerInfo)}
                  className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    {showServerInfo ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="text-sm font-medium text-foreground">
                      Server Info
                    </span>
                  </div>
                </button>

                {showServerInfo && (
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
                              Server Title
                            </span>
                            <span className="text-sm font-mono">
                              {server.initializationInfo.serverVersion.title ||
                                "None"}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">
                              Homepage URL
                            </span>
                            <span className="text-sm font-mono">
                              {server.initializationInfo.serverVersion
                                .websiteUrl || "None"}
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
                              {server.initializationInfo.serverVersion.version}
                            </Badge>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Server Icons */}
                    {server.initializationInfo.serverVersion &&
                      server.initializationInfo.serverVersion.icons && (
                        <div className="space-y-3 pt-2 border-t border-border/50">
                          <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">
                            Server Icons
                          </h4>

                          <ul className="space-y-3">
                            {server.initializationInfo.serverVersion.icons.map(
                              (icon, index) => (
                                <li
                                  key={index}
                                  className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/30 hover:bg-muted/50 transition-colors"
                                >
                                  <span className="font-mono text-xs break-all mr-4 flex-1">
                                    {icon.src}
                                  </span>

                                  <div className="w-12 h-12 rounded-md overflow-hidden bg-background border border-border/50 flex items-center justify-center">
                                    <img
                                      src={icon.src}
                                      alt=""
                                      className="w-full h-full object-contain"
                                      loading="lazy"
                                    />
                                  </div>
                                </li>
                              ),
                            )}
                          </ul>
                        </div>
                      )}

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
                    location: "edit_server_modal_config",
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
                Update Server
              </Button>
            </div>
          </form>
        )}

        {/* Authentication Tab */}
        {activeTab === "auth" && (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold">Authentication Settings</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Configure authentication for your MCP server connection
              </p>
            </div>

            {serverFormData.type === "http" ? (
              <div className="space-y-4">
                {/* Authentication Section */}
                <AuthenticationSection
                  authType={authType}
                  onAuthTypeChange={(value) => {
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
                  showAuthSettings={showAuthSettings}
                  bearerToken={bearerToken}
                  onBearerTokenChange={setBearerToken}
                  oauthScopesInput={oauthScopesInput}
                  onOauthScopesChange={setOauthScopesInput}
                  useCustomClientId={useCustomClientId}
                  onUseCustomClientIdChange={(checked) => {
                    setUseCustomClientId(checked);
                    if (!checked) {
                      setClientId("");
                      setClientSecret("");
                      setClientIdError(null);
                      setClientSecretError(null);
                    }
                  }}
                  clientId={clientId}
                  onClientIdChange={(value) => {
                    setClientId(value);
                    const error = validateClientId(value);
                    setClientIdError(error);
                  }}
                  clientSecret={clientSecret}
                  onClientSecretChange={(value) => {
                    setClientSecret(value);
                    const error = validateClientSecret(value);
                    setClientSecretError(error);
                  }}
                  clientIdError={clientIdError}
                  clientSecretError={clientSecretError}
                />

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
                    location: "edit_server_modal_auth",
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
                    location: "edit_server_modal_auth_tab",
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

        {/* Tools Tab */}
        {activeTab === "tools" && (
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
                toolsError === "not-connected" ? (
                  <div className="bg-muted/30 rounded-lg p-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      Connect to see widget metadata
                    </p>
                  </div>
                ) : (
                  <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/30 rounded-lg p-4 text-sm text-red-600 dark:text-red-400">
                    {toolsError}
                  </div>
                )
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
                                      {(() => {
                                        if (
                                          value === null ||
                                          value === undefined
                                        )
                                          return "null";
                                        if (typeof value === "object") {
                                          // Handle URL objects specifically
                                          if (value instanceof URL)
                                            return value.toString();
                                          // Handle other objects with JSON
                                          try {
                                            return JSON.stringify(
                                              value,
                                              null,
                                              2,
                                            );
                                          } catch {
                                            return String(value);
                                          }
                                        }
                                        return String(value);
                                      })()}
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
                    location: "edit_server_modal_tools",
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
