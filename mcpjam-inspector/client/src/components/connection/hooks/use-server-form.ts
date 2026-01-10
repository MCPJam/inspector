import { useState, useEffect } from "react";
import { ServerFormData } from "@/shared/types.js";
import { ServerWithName } from "@/hooks/use-app-state";
import { hasOAuthConfig, getStoredTokens } from "@/lib/oauth/mcp-oauth";

export function useServerForm(server?: ServerWithName) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http">("stdio");
  const [commandInput, setCommandInput] = useState("");
  const [url, setUrl] = useState("");

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
        const hasOAuthTokens = server.oauthTokens != null;
        const hasStoredOAuthConfig = hasOAuthConfig(server.name);
        hasOAuth = hasOAuthTokens || hasStoredOAuthConfig;

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

        // Retrieve scopes from multiple sources (prioritize stored tokens/storage)
        scopes =
          server.oauthTokens?.scope?.split(" ") ||
          storedTokens?.scope?.split(" ") ||
          oauthConfig.scopes ||
          [];

        // Get client ID and secret from multiple sources (prioritize stored)
        clientIdValue = storedTokens?.client_id || clientInfo?.client_id || "";

        clientSecretValue = clientInfo?.client_secret || "";
      }

      setName(server.name);
      setType(server.config.command ? "stdio" : "http");
      setUrl(isHttpServer && config.url ? config.url.toString() : "");

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
      setRequestTimeout(String(config.timeout || 10000));

      // Set auth type based on multiple OAuth detection sources
      if (hasOAuth) {
        setAuthType("oauth");
        setShowAuthSettings(true);
      } else if (
        isHttpServer &&
        config.requestInit?.headers &&
        typeof config.requestInit.headers === "object" &&
        "Authorization" in config.requestInit.headers &&
        typeof config.requestInit.headers.Authorization === "string" &&
        config.requestInit.headers.Authorization.startsWith("Bearer ")
      ) {
        setAuthType("bearer");
        setBearerToken(
          config.requestInit.headers.Authorization.replace("Bearer ", ""),
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

      // Initialize env vars for STDIO servers
      if (!isHttpServer && config.env) {
        const envArray = Object.entries(config.env).map(([key, value]) => ({
          key,
          value: String(value),
        }));
        setEnvVars(envArray);
      }

      // Initialize custom headers for HTTP servers (excluding Authorization)
      if (
        isHttpServer &&
        config.requestInit?.headers &&
        typeof config.requestInit.headers === "object"
      ) {
        const headersArray = Object.entries(config.requestInit.headers)
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

  const validateForm = (): string | null => {
    if (!name || name.trim() === "") {
      return "Server name is required";
    }

    if (type === "stdio") {
      if (!commandInput || commandInput.trim() === "") {
        return "Command is required for STDIO servers";
      }
    } else if (type === "http") {
      if (!url || url.trim() === "") {
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
    const reqTimeout = parseInt(requestTimeout) || 10000;

    // Handle stdio-specific data
    if (type === "stdio") {
      // Parse commandInput to extract command and args
      const parts = commandInput
        .trim()
        .split(/\s+/)
        .filter((part) => part.length > 0);
      const command = parts[0] || "";
      const args = parts.slice(1);

      // Build environment variables
      const env: Record<string, string> = {};
      envVars.forEach(({ key, value }) => {
        if (key.trim()) {
          env[key.trim()] = value;
        }
      });

      return {
        name: name.trim(),
        type: "stdio",
        command: command.trim(),
        args,
        env,
        requestTimeout: reqTimeout,
      };
    }

    // Handle http-specific data
    const headers: Record<string, string> = {};

    // Add custom headers
    customHeaders.forEach(({ key, value }) => {
      if (key.trim()) {
        headers[key.trim()] = value;
      }
    });

    // Parse OAuth scopes from input
    const scopes = oauthScopesInput
      .trim()
      .split(/\s+/)
      .filter((s) => s.length > 0);

    // Handle authentication
    let useOAuth = false;
    if (authType === "bearer" && bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken.trim()}`;
    } else if (authType === "oauth") {
      useOAuth = true;
    }

    return {
      name: name.trim(),
      type: "http",
      url: url.trim(),
      headers,
      useOAuth,
      oauthScopes: scopes.length > 0 ? scopes : undefined,
      clientId: clientId.trim() || undefined,
      clientSecret: clientSecret.trim() || undefined,
      requestTimeout: reqTimeout,
    };
  };

  const resetForm = () => {
    setName("");
    setType("stdio");
    setCommandInput("");
    setUrl("");
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
    setShowAuthSettings(false);
  };

  return {
    // Form data
    name,
    setName,
    type,
    setType,
    commandInput,
    setCommandInput,
    url,
    setUrl,

    // Auth states
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
