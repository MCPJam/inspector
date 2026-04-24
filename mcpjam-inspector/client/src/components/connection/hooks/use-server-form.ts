import { useState, useEffect, useRef } from "react";
import {
  ServerFormData,
  type ServerFormOAuthProtocolMode,
  type ServerFormOAuthRegistrationMode,
} from "@/shared/types.js";
import { ServerWithName } from "@/hooks/use-app-state";
import type { WorkspaceClientConfig } from "@/lib/client-config";
import { getEffectiveWorkspaceConnectionDefaults } from "@/lib/client-config";
import { hasOAuthConfig, getStoredTokens } from "@/lib/oauth/mcp-oauth";
import { HOSTED_MODE } from "@/lib/config";

interface InitialFormValues {
  name: string;
  type: "stdio" | "http";
  url: string;
  commandInput: string;
  authType: "oauth" | "bearer" | "none";
  bearerToken: string;
  oauthScopesInput: string;
  oauthProtocolMode: ServerFormOAuthProtocolMode;
  oauthRegistrationMode: ServerFormOAuthRegistrationMode;
  useCustomClientId: boolean;
  clientId: string;
  clientSecret: string;
  envVars: Array<{ key: string; value: string }>;
  customHeaders: Array<{ key: string; value: string }>;
  requestTimeout: string;
  clientCapabilitiesOverrideEnabled: boolean;
  clientCapabilitiesOverrideText: string;
}

const DEFAULT_OAUTH_PROTOCOL_MODE: ServerFormOAuthProtocolMode = "2025-11-25";

function normalizeOauthProtocolMode(
  value?: string,
): ServerFormOAuthProtocolMode {
  return value === "2025-03-26" ||
    value === "2025-06-18" ||
    value === "2025-11-25"
    ? value
    : DEFAULT_OAUTH_PROTOCOL_MODE;
}

export function useServerForm(
  server?: ServerWithName,
  options?: {
    requireHttps?: boolean;
    workspaceClientConfig?: WorkspaceClientConfig;
  },
) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http">("http");
  const [commandInput, setCommandInput] = useState("");
  const [url, setUrl] = useState("");

  const [oauthScopesInput, setOauthScopesInput] = useState("");
  const [oauthProtocolMode, setOauthProtocolMode] =
    useState<ServerFormOAuthProtocolMode>(DEFAULT_OAUTH_PROTOCOL_MODE);
  const [oauthRegistrationMode, setOauthRegistrationMode] =
    useState<ServerFormOAuthRegistrationMode>("auto");
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
  const [requestTimeout, setRequestTimeout] = useState<string>("");
  const [clientCapabilitiesOverrideEnabled, setClientCapabilitiesOverrideEnabled] =
    useState(false);
  const [clientCapabilitiesOverrideText, setClientCapabilitiesOverrideText] =
    useState("{}");
  const [clientCapabilitiesOverrideError, setClientCapabilitiesOverrideError] =
    useState<string | null>(null);

  const [showConfiguration, setShowConfiguration] = useState<boolean>(false);
  const [showEnvVars, setShowEnvVars] = useState<boolean>(false);
  const [showAuthSettings, setShowAuthSettings] = useState<boolean>(false);

  const initialValues = useRef<InitialFormValues | null>(null);
  const workspaceConnectionDefaults = getEffectiveWorkspaceConnectionDefaults(
    options?.workspaceClientConfig,
  );

  const parseCapabilitiesOverride = (
    value: string,
  ): Record<string, unknown> => {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Client capabilities override must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  };

  // Initialize form with server data (for edit mode)
  useEffect(() => {
    if (server) {
      const config = server.config;
      const isHttpServer = "url" in config;

      // For HTTP servers, check OAuth from multiple sources like the original
      let hasOAuth = false;
      let scopes: string[] = [];
      let protocolModeValue: ServerFormOAuthProtocolMode =
        DEFAULT_OAUTH_PROTOCOL_MODE;
      let registrationModeValue: ServerFormOAuthRegistrationMode = "auto";
      let clientIdValue = "";
      let clientSecretValue = "";
      let shouldShowClientCredentials = false;
      let clientCapabilitiesOverrideValue: Record<string, unknown> | undefined;

      if (isHttpServer) {
        // Check if OAuth is configured by looking at multiple sources:
        // 1. Check if server has oauth tokens
        // 2. Check if there's stored OAuth data
        const hasOAuthTokens = server.oauthTokens != null;
        const hasStoredOAuthConfig = hasOAuthConfig(server.name);
        hasOAuth =
          server.useOAuth === true ||
          hasOAuthTokens ||
          hasStoredOAuthConfig ||
          server.oauthFlowProfile != null;

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
        const fallbackScopes =
          typeof server.oauthFlowProfile?.scopes === "string"
            ? server.oauthFlowProfile.scopes
                .split(/[,\s]+/)
                .filter((scope) => scope.length > 0)
            : [];

        // Retrieve scopes from multiple sources (prioritize stored tokens/storage)
        scopes =
          server.oauthTokens?.scope?.split(" ") ||
          storedTokens?.scope?.split(" ") ||
          oauthConfig.scopes ||
          fallbackScopes;

        const savedClientId =
          clientInfo?.client_id || server.oauthFlowProfile?.clientId || "";
        const savedClientSecret =
          clientInfo?.client_secret ||
          server.oauthFlowProfile?.clientSecret ||
          "";

        // Keep runtime token metadata available for preregistered reconnects,
        // but only surface credential fields from saved client configuration.
        clientIdValue = storedTokens?.client_id || savedClientId;
        clientSecretValue = savedClientSecret;

        protocolModeValue = normalizeOauthProtocolMode(
          typeof oauthConfig.protocolMode === "string"
            ? oauthConfig.protocolMode
            : typeof server.oauthFlowProfile?.protocolVersion === "string"
              ? server.oauthFlowProfile.protocolVersion
              : typeof oauthConfig.protocolVersion === "string"
                ? oauthConfig.protocolVersion
                : undefined,
        );

        registrationModeValue =
          oauthConfig.registrationMode === "auto" ||
          oauthConfig.registrationMode === "cimd" ||
          oauthConfig.registrationMode === "dcr" ||
          oauthConfig.registrationMode === "preregistered"
            ? oauthConfig.registrationMode
            : server.oauthFlowProfile?.registrationStrategy ||
              (oauthConfig.registrationStrategy === "cimd" ||
              oauthConfig.registrationStrategy === "dcr" ||
              oauthConfig.registrationStrategy === "preregistered"
                ? oauthConfig.registrationStrategy
                : (savedClientId || savedClientSecret)
                  ? "preregistered"
                  : "auto");

        shouldShowClientCredentials =
          registrationModeValue === "preregistered" ||
          Boolean(savedClientId || savedClientSecret);
      }

      // Derive local values used for both state initialization and snapshot
      const serverType: "stdio" | "http" = server.config.command
        ? "stdio"
        : "http";
      const serverUrl = isHttpServer && config.url ? config.url.toString() : "";
      const fullCommand = server.config.command
        ? [server.config.command, ...(server.config.args || [])]
            .filter(Boolean)
            .join(" ")
        : "";
      const hasBearer =
        isHttpServer &&
        config.requestInit?.headers &&
        typeof config.requestInit.headers === "object" &&
        "Authorization" in config.requestInit.headers &&
        typeof config.requestInit.headers.Authorization === "string" &&
        config.requestInit.headers.Authorization.startsWith("Bearer ");
      const bearerTokenValue = hasBearer
        ? (
            config.requestInit!.headers as Record<string, string>
          ).Authorization.replace("Bearer ", "")
        : "";
      const resolvedAuthType: "oauth" | "bearer" | "none" = hasOAuth
        ? "oauth"
        : hasBearer
          ? "bearer"
          : "none";
      const timeoutValue =
        typeof config.timeout === "number" && Number.isFinite(config.timeout)
          ? String(config.timeout)
          : "";
      clientCapabilitiesOverrideValue =
        (config.clientCapabilities as Record<string, unknown> | undefined) ??
        (config.capabilities as Record<string, unknown> | undefined);

      setName(server.name);
      setType(serverType);
      setUrl(serverUrl);
      setCommandInput(fullCommand);

      // Don't set a default scope for existing servers - use what's configured
      // Only set default for new servers
      setOauthScopesInput(scopes.join(" "));
      setOauthProtocolMode(protocolModeValue);
      setOauthRegistrationMode(registrationModeValue);
      setRequestTimeout(timeoutValue);
      setClientCapabilitiesOverrideEnabled(
        clientCapabilitiesOverrideValue != null,
      );
      setClientCapabilitiesOverrideText(
        JSON.stringify(clientCapabilitiesOverrideValue ?? {}, null, 2),
      );
      setClientCapabilitiesOverrideError(null);

      // Set auth type based on multiple OAuth detection sources
      if (resolvedAuthType === "oauth") {
        setAuthType("oauth");
        setShowAuthSettings(true);
      } else if (resolvedAuthType === "bearer") {
        setAuthType("bearer");
        setBearerToken(bearerTokenValue);
        setShowAuthSettings(true);
      } else {
        setAuthType("none");
        setShowAuthSettings(false);
      }

      // Set custom OAuth credentials if present (from any source)
      if (shouldShowClientCredentials) {
        setUseCustomClientId(true);
        setClientId(clientIdValue);
        setClientSecret(clientSecretValue);
      } else {
        setUseCustomClientId(false);
        setClientId("");
        setClientSecret("");
      }

      // Initialize env vars for STDIO servers
      let envArray: Array<{ key: string; value: string }> = [];
      if (!isHttpServer && config.env) {
        envArray = Object.entries(config.env).map(([key, value]) => ({
          key,
          value: String(value),
        }));
      }
      setEnvVars(envArray);

      // Initialize custom headers for HTTP servers (excluding Authorization)
      let headersArray: Array<{ key: string; value: string }> = [];
      if (
        isHttpServer &&
        config.requestInit?.headers &&
        typeof config.requestInit.headers === "object"
      ) {
        headersArray = Object.entries(config.requestInit.headers)
          .filter(([key]) => key !== "Authorization")
          .map(([key, value]) => ({ key, value: String(value) }));
      }
      setCustomHeaders(headersArray);
      setShowConfiguration(
        headersArray.length > 0 ||
          timeoutValue.trim() !== "" ||
          clientCapabilitiesOverrideValue != null,
      );

      // Capture initial values for change detection (deep copy arrays to avoid aliasing)
      initialValues.current = {
        name: server.name,
        type: serverType,
        url: serverUrl,
        commandInput: fullCommand,
        authType: resolvedAuthType,
        bearerToken: bearerTokenValue,
        oauthScopesInput: scopes.join(" "),
        oauthProtocolMode: protocolModeValue,
        oauthRegistrationMode: registrationModeValue,
        useCustomClientId: shouldShowClientCredentials,
        clientId: clientIdValue,
        clientSecret: clientSecretValue,
        envVars: envArray.map(({ key, value }) => ({ key, value })),
        customHeaders: headersArray.map(({ key, value }) => ({ key, value })),
        requestTimeout: timeoutValue,
        clientCapabilitiesOverrideEnabled:
          clientCapabilitiesOverrideValue != null,
        clientCapabilitiesOverrideText: JSON.stringify(
          clientCapabilitiesOverrideValue ?? {},
          null,
          2,
        ),
      };
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

      let urlObj: URL;
      try {
        urlObj = new URL(url.trim());
      } catch {
        return "Invalid URL format";
      }

      // Enforce HTTPS in hosted mode or when explicitly required
      if (
        (HOSTED_MODE || options?.requireHttps) &&
        urlObj.protocol !== "https:"
      ) {
        return "HTTPS is required";
      }
    }

    if (
      clientCapabilitiesOverrideEnabled &&
      clientCapabilitiesOverrideError != null
    ) {
      return clientCapabilitiesOverrideError;
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

  const updateClientCapabilitiesOverride = (value: string) => {
    setClientCapabilitiesOverrideText(value);
    try {
      parseCapabilitiesOverride(value);
      setClientCapabilitiesOverrideError(null);
    } catch (error) {
      setClientCapabilitiesOverrideError(
        error instanceof Error ? error.message : "Invalid JSON",
      );
    }
  };

  const buildFormData = (): ServerFormData => {
    const parsedTimeout = Number.parseInt(requestTimeout.trim(), 10);
    const reqTimeout = Number.isFinite(parsedTimeout) ? parsedTimeout : undefined;
    const clientCapabilities =
      clientCapabilitiesOverrideEnabled &&
      clientCapabilitiesOverrideError == null
        ? parseCapabilitiesOverride(clientCapabilitiesOverrideText)
        : undefined;

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
        clientCapabilities,
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
    const explicitHeaders =
      Object.keys(headers).length > 0 ? headers : undefined;

    // Parse OAuth scopes from input
    const scopes = oauthScopesInput
      .trim()
      .split(/\s+/)
      .filter((s) => s.length > 0);
    const shouldUsePreregisteredCredentials =
      authType === "oauth" && oauthRegistrationMode === "preregistered";

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
      headers: explicitHeaders,
      clientCapabilities,
      useOAuth,
      oauthProtocolMode: useOAuth ? oauthProtocolMode : undefined,
      oauthRegistrationMode: useOAuth ? oauthRegistrationMode : undefined,
      oauthScopes: scopes.length > 0 ? scopes : undefined,
      clientId: shouldUsePreregisteredCredentials
        ? clientId.trim() || undefined
        : undefined,
      clientSecret: shouldUsePreregisteredCredentials
        ? clientSecret.trim() || undefined
        : undefined,
      requestTimeout: reqTimeout,
    };
  };

  const resetForm = () => {
    setName("");
    setType("http");
    setCommandInput("");
    setUrl("");
    setOauthScopesInput("");
    setOauthProtocolMode(DEFAULT_OAUTH_PROTOCOL_MODE);
    setOauthRegistrationMode("auto");
    setClientId("");
    setClientSecret("");
    setBearerToken("");
    setAuthType("none");
    setUseCustomClientId(false);
    setClientIdError(null);
    setClientSecretError(null);
    setEnvVars([]);
    setCustomHeaders([]);
    setRequestTimeout("");
    setClientCapabilitiesOverrideEnabled(false);
    setClientCapabilitiesOverrideText("{}");
    setClientCapabilitiesOverrideError(null);
    setShowConfiguration(false);
    setShowEnvVars(false);
    setShowAuthSettings(false);
  };

  // Derive hasChanges by comparing current state against initial snapshot
  const hasChanges = (() => {
    if (!initialValues.current) return true; // New server — always allow save
    const iv = initialValues.current;
    return (
      name !== iv.name ||
      type !== iv.type ||
      url !== iv.url ||
      commandInput !== iv.commandInput ||
      authType !== iv.authType ||
      bearerToken !== iv.bearerToken ||
      oauthScopesInput !== iv.oauthScopesInput ||
      oauthProtocolMode !== iv.oauthProtocolMode ||
      oauthRegistrationMode !== iv.oauthRegistrationMode ||
      useCustomClientId !== iv.useCustomClientId ||
      clientId !== iv.clientId ||
      clientSecret !== iv.clientSecret ||
      requestTimeout !== iv.requestTimeout ||
      clientCapabilitiesOverrideEnabled !==
        iv.clientCapabilitiesOverrideEnabled ||
      clientCapabilitiesOverrideText !== iv.clientCapabilitiesOverrideText ||
      JSON.stringify(envVars) !== JSON.stringify(iv.envVars) ||
      JSON.stringify(customHeaders) !== JSON.stringify(iv.customHeaders)
    );
  })();

  const preregisteredOauthBlocksSubmit =
    type === "http" &&
    authType === "oauth" &&
    oauthRegistrationMode === "preregistered" &&
    validateClientId(clientId) !== null;

  return {
    // Change detection
    hasChanges,
    preregisteredOauthBlocksSubmit,

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
    oauthProtocolMode,
    setOauthProtocolMode,
    oauthRegistrationMode,
    setOauthRegistrationMode,
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
    inheritedRequestTimeout: workspaceConnectionDefaults.requestTimeout,
    clientCapabilitiesOverrideEnabled,
    setClientCapabilitiesOverrideEnabled,
    clientCapabilitiesOverrideText,
    setClientCapabilitiesOverrideText: updateClientCapabilitiesOverride,
    clientCapabilitiesOverrideError,
    setClientCapabilitiesOverrideError,

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
    updateClientCapabilitiesOverride,
    buildFormData,
    resetForm,
  };
}
