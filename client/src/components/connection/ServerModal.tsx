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
import { ServerFormData } from "@/shared/types.js";
import { ServerWithName } from "@/hooks/use-app-state";
import { getStoredTokens, hasOAuthConfig } from "@/lib/mcp-oauth";

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
      const hasOAuth = hasOAuthTokens || hasStoredOAuthConfig || hasOAuthInConfig;

      const storedOAuthConfig = localStorage.getItem(`mcp-oauth-config-${server.name}`);
      const storedClientInfo = localStorage.getItem(`mcp-client-${server.name}`);
      const storedTokens = getStoredTokens(server.name);

      const clientInfo = storedClientInfo ? JSON.parse(storedClientInfo) : {};
      const oauthConfig = storedOAuthConfig ? JSON.parse(storedOAuthConfig) : {};

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
      };
    } else {
      return {
        name: server.name,
        type: "stdio",
        command: config.command || "",
        args: config.args || [],
        env: config.env || {},
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
    };
  };

  useEffect(() => {
    if (isOpen) {
      const formData = getInitialFormData();
      setServerFormData(formData);

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
        const authHeader = headers.Authorization;
        const hasBearerToken = authHeader?.startsWith("Bearer ");
        const hasOAuth = formData.useOAuth;

        if (hasOAuth) {
          setAuthType("oauth");
          setOauthScopesInput(formData.oauthScopes?.join(" ") || "mcp:*");

          setClientId(formData.clientId || "");
          setClientSecret(formData.clientSecret || "");
          setUseCustomClientId(!!formData.clientId);

          setServerFormData((prev) => ({ ...prev, useOAuth: true }));
        } else if (hasBearerToken) {
          setAuthType("bearer");
          setBearerToken(authHeader.slice(7)); // Remove 'Bearer ' prefix

          setServerFormData((prev) => ({ ...prev, useOAuth: false }));
        } else {
          setAuthType("none");

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
  };

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: "", value: "" }]);
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
      <DialogContent className="max-w-md sm:max-w-lg">
        <DialogHeader className="space-y-2">
          <DialogTitle className="flex text-xl font-semibold">
            <img src="/mcp.svg" alt="MCP" className="mr-2" /> {dialogTitle}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
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
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-sm font-medium text-foreground">
                  Environment Variables
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addEnvVar}
                  className="text-xs"
                >
                  Add Variable
                </Button>
              </div>
              {envVars.length > 0 && (
                <div className="space-y-2 max-h-32 overflow-y-auto">
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

          {/* Authentication for HTTP */}
          {serverFormData.type === "http" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-foreground">
                  Authentication
                </label>
                <Select
                  value={authType}
                  onValueChange={(value: "oauth" | "bearer" | "none") => {
                    setAuthType(value);
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

              {authType === "bearer" && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-foreground">
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

              {authType === "oauth" && (
                <div className="space-y-4">
                  <div className="space-y-2">
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
                    <div className="space-y-4">
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

              {/* Custom Headers for HTTP */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-foreground">
                    Custom Headers
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addCustomHeader}
                    className="text-xs"
                  >
                    Add Header
                  </Button>
                </div>
                {customHeaders.length > 0 && (
                  <div className="space-y-2 max-h-32 overflow-y-auto">
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
                            updateCustomHeader(index, "value", e.target.value)
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
                <p className="text-xs text-muted-foreground">
                  Add custom HTTP headers for your MCP server connection (e.g.
                  API-Key, X-Custom-Header)
                </p>
              </div>
            </div>
          )}

          <div className="flex justify-end space-x-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              className="px-4"
            >
              Cancel
            </Button>
            <Button type="submit" className="px-4">
              {mode === "add" ? "Add Server" : "Update Server"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
