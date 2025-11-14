import { useState, useEffect } from "react";
import { toast } from "sonner";
import { ServerFormData } from "@/shared/types.js";
import { ServerWithName } from "@/hooks/use-app-state";
import { hasOAuthConfig, getStoredTokens } from "@/lib/mcp-oauth";

export function useServerForm(server?: ServerWithName) {
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

  // Initialize form with server data (for edit mode)
  useEffect(() => {
    if (server) {
      const config = server.config;
      const isHttpServer = "url" in config;

      // For HTTP servers, check OAuth from multiple sources like the original
      let hasOAuth = false;
      let scopes: string[] = [];
      let clientIdValue = "";
      let clientSecretValue = "";

      if (isHttpServer) {
        // Check if OAuth is configured by looking at multiple sources:
        // 1. Check if server has oauth tokens
        // 2. Check if there's stored OAuth data
        // 3. Check if the config has an oauth field
        const hasOAuthTokens = server.oauthTokens != null;
        const hasStoredOAuthConfig = hasOAuthConfig(server.name);
        const hasOAuthInConfig = "oauth" in config && config.oauth != null;
        hasOAuth = hasOAuthTokens || hasStoredOAuthConfig || hasOAuthInConfig;

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

        // Retrieve scopes from multiple sources (prioritize config over tokens/storage)
        scopes =
          config.oauthScopes ||
          server.oauthTokens?.scope?.split(" ") ||
          storedTokens?.scope?.split(" ") ||
          oauthConfig.scopes ||
          [];

        // Get client ID and secret from multiple sources (prioritize config)
        clientIdValue =
          (typeof config.clientId === "string" ? config.clientId : "") ||
          storedTokens?.client_id ||
          clientInfo?.client_id ||
          "";

        clientSecretValue =
          (typeof config.clientSecret === "string"
            ? config.clientSecret
            : "") ||
          clientInfo?.client_secret ||
          "";
      }

      setServerFormData({
        name: server.name,
        type: server.config.command ? "stdio" : "http",
        command: server.config.command || "",
        args: server.config.args || [],
        url: server.config.url
          ? typeof server.config.url === "string"
            ? server.config.url
            : server.config.url.toString()
          : "",
        headers: server.config.headers || {},
        env: server.config.env || {},
        useOAuth: hasOAuth,
        oauthScopes: scopes,
        clientId: clientIdValue,
        clientSecret: clientSecretValue,
        requestTimeout: server.config.requestTimeout,
      });

      // For STDIO servers, combine command and args into commandInput
      if (server.config.command) {
        const fullCommand = [
          server.config.command,
          ...(server.config.args || []),
        ]
          .filter(Boolean)
          .join(" ");
        setCommandInput(fullCommand);
      }

      // Don't set a default scope for existing servers - use what's configured
      // Only set default for new servers
      setOauthScopesInput(scopes.join(" "));
      setRequestTimeout(String(server.config.requestTimeout || 10000));

      // Set auth type based on multiple OAuth detection sources
      if (hasOAuth) {
        setAuthType("oauth");
        setShowAuthSettings(true);
      } else if (
        server.config.headers?.["Authorization"]?.startsWith("Bearer ")
      ) {
        setAuthType("bearer");
        setBearerToken(
          server.config.headers["Authorization"].replace("Bearer ", ""),
        );
        setShowAuthSettings(true);
      } else {
        setAuthType("none");
        setShowAuthSettings(false);
      }

      // Set custom OAuth credentials if present (from any source)
      if (clientIdValue) {
        setUseCustomClientId(true);
        setClientId(clientIdValue);
        setClientSecret(clientSecretValue);
      }

      // Initialize env vars
      if (server.config.env) {
        const envArray = Object.entries(server.config.env).map(
          ([key, value]) => ({ key, value: String(value) }),
        );
        setEnvVars(envArray);
      }

      // Initialize custom headers (excluding Authorization)
      if (server.config.headers) {
        const headersArray = Object.entries(server.config.headers)
          .filter(([key]) => key !== "Authorization")
          .map(([key, value]) => ({ key, value: String(value) }));
        setCustomHeaders(headersArray);
      }
    }
  }, [server]);

  // Validation functions
  const validateClientId = (value: string): string | null => {
    if (!value || value.trim() === "") {
      return "Client ID is required when using custom credentials";
    }
    if (value.length < 3) {
      return "Client ID must be at least 3 characters";
    }
    return null;
  };

  const validateClientSecret = (value: string): string | null => {
    if (value && value.length < 8) {
      return "Client Secret must be at least 8 characters if provided";
    }
    return null;
  };

  const validateForm = (formData: ServerFormData): string | null => {
    if (!formData.name || formData.name.trim() === "") {
      return "Server name is required";
    }

    if (formData.type === "stdio") {
      if (!formData.command || formData.command.trim() === "") {
        return "Command is required for STDIO servers";
      }
    } else if (formData.type === "http") {
      if (!formData.url || formData.url.trim() === "") {
        return "URL is required for HTTP servers";
      }
    }

    return null;
  };

  // Helper functions
  const addEnvVar = () => {
    setEnvVars([...envVars, { key: "", value: "" }]);
    setShowEnvVars(true);
  };

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
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

  const addCustomHeader = () => {
    setCustomHeaders([...customHeaders, { key: "", value: "" }]);
    setShowCustomHeaders(true);
  };

  const removeCustomHeader = (index: number) => {
    setCustomHeaders(customHeaders.filter((_, i) => i !== index));
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

  const buildFormData = (): ServerFormData => {
    let finalFormData = { ...serverFormData };

    // Add timeout configuration
    const reqTimeout = parseInt(requestTimeout) || 10000;
    finalFormData = {
      ...finalFormData,
      requestTimeout: reqTimeout,
    };

    // Handle stdio-specific data
    if (serverFormData.type === "stdio") {
      // Parse commandInput to extract command and args
      const parts = commandInput
        .trim()
        .split(/\s+/)
        .filter((part) => part.length > 0);
      const command = parts[0] || "";
      const args = parts.slice(1);

      finalFormData = {
        ...finalFormData,
        command: command.trim(),
        args,
        url: undefined,
        headers: undefined,
      };

      // Add environment variables
      const env: Record<string, string> = {};
      envVars.forEach(({ key, value }) => {
        if (key.trim()) {
          env[key.trim()] = value;
        }
      });
      finalFormData.env = env;
    }

    // Handle http-specific data
    if (serverFormData.type === "http") {
      const headers: Record<string, string> = {};

      // Add custom headers
      customHeaders.forEach(({ key, value }) => {
        if (key.trim()) {
          headers[key.trim()] = value;
        }
      });

      // Parse OAuth scopes from input (preserve them even when not using OAuth)
      const scopes = oauthScopesInput
        .trim()
        .split(/\s+/)
        .filter((s) => s.length > 0);
      if (scopes.length > 0) {
        finalFormData.oauthScopes = scopes;
      }

      // Preserve client credentials
      if (clientId.trim()) {
        finalFormData.clientId = clientId.trim();
      }
      if (clientSecret.trim()) {
        finalFormData.clientSecret = clientSecret.trim();
      }

      // Handle authentication
      if (authType === "bearer" && bearerToken) {
        headers["Authorization"] = `Bearer ${bearerToken.trim()}`;
        finalFormData.useOAuth = false;
      } else if (authType === "oauth") {
        finalFormData.useOAuth = true;
        // Don't add default scopes - let the OAuth server use its defaults
        // This prevents invalid_scope errors when the server doesn't recognize "mcp:*"
      } else {
        finalFormData.useOAuth = false;
      }

      finalFormData.url =
        typeof serverFormData.url === "string" ? serverFormData.url.trim() : ""; // Trim URL to remove trailing/leading spaces
      finalFormData.headers = headers;
      finalFormData.env = undefined;
      finalFormData.command = undefined;
      finalFormData.args = undefined;
    }

    return finalFormData;
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
  };

  return {
    // Form data
    serverFormData,
    setServerFormData,

    // Input states
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

    // Validation states
    clientIdError,
    setClientIdError,
    clientSecretError,
    setClientSecretError,

    // Arrays
    envVars,
    setEnvVars,
    customHeaders,
    setCustomHeaders,

    // Toggle states
    showConfiguration,
    setShowConfiguration,
    showEnvVars,
    setShowEnvVars,
    showCustomHeaders,
    setShowCustomHeaders,
    showAuthSettings,
    setShowAuthSettings,

    // Functions
    validateClientId,
    validateClientSecret,
    validateForm,
    addEnvVar,
    removeEnvVar,
    updateEnvVar,
    addCustomHeader,
    removeCustomHeader,
    updateCustomHeader,
    buildFormData,
    resetForm,
  };
}
