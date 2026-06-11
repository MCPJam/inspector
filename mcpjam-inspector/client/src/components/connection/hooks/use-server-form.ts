import { useState, useEffect, useRef } from "react";
import {
  ServerFormData,
  type ServerFormOAuthProtocolMode,
  type ServerFormOAuthRegistrationMode,
} from "@/shared/types.js";
import { ServerWithName } from "@/hooks/use-app-state";
import type { ProjectClientConfig } from "@/lib/client-config";
import { getEffectiveProjectConnectionDefaults } from "@/lib/client-config";
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
  hasStoredClientSecret: boolean;
  clearClientSecret: boolean;
  hasStoredEnv: boolean;
  hasStoredHeaders: boolean;
  envVars: Array<{ key: string; value: string }>;
  customHeaders: Array<{ key: string; value: string }>;
  requestTimeout: string;
  clientCapabilitiesOverrideEnabled: boolean;
  clientCapabilitiesOverrideText: string;
}

const DEFAULT_OAUTH_PROTOCOL_MODE: ServerFormOAuthProtocolMode = "2025-11-25";
const DEFAULT_OAUTH_REGISTRATION_MODE: ServerFormOAuthRegistrationMode = "auto";

interface HeaderEntry {
  id?: string;
  key: string;
  value: string;
}

function normalizeOauthProtocolMode(
  value?: string
): ServerFormOAuthProtocolMode {
  return value === "2025-03-26" ||
    value === "2025-06-18" ||
    value === "2025-11-25"
    ? value
    : DEFAULT_OAUTH_PROTOCOL_MODE;
}

function normalizeOauthRegistrationMode(
  value?: string
): ServerFormOAuthRegistrationMode | undefined {
  return value === "auto" ||
    value === "cimd" ||
    value === "dcr" ||
    value === "preregistered"
    ? value
    : undefined;
}

function createHeaderEntry(key = "", value = ""): HeaderEntry {
  return {
    id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    key,
    value,
  };
}

function isAuthorizationHeader(key: string): boolean {
  return key.trim().toLowerCase() === "authorization";
}

function getAuthorizationHeaderValue(
  headers?: Record<string, unknown>
): string | undefined {
  if (!headers) {
    return undefined;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (isAuthorizationHeader(key) && typeof value === "string") {
      return value;
    }
  }

  return undefined;
}

function toComparableHeaders(
  headers: Array<{ key: string; value: string }>
): Array<{ key: string; value: string }> {
  return headers.map(({ key, value }) => ({ key, value }));
}

export function useServerForm(
  server?: ServerWithName,
  options?: {
    requireHttps?: boolean;
    projectClientConfig?: ProjectClientConfig;
  }
) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http">("http");
  const [commandInput, setCommandInput] = useState("");
  const [url, setUrl] = useState("");

  const [oauthScopesInput, setOauthScopesInput] = useState("");
  const [oauthProtocolMode, setOauthProtocolMode] =
    useState<ServerFormOAuthProtocolMode>(DEFAULT_OAUTH_PROTOCOL_MODE);
  const [oauthRegistrationMode, setOauthRegistrationMode] =
    useState<ServerFormOAuthRegistrationMode>(DEFAULT_OAUTH_REGISTRATION_MODE);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [hasStoredClientSecret, setHasStoredClientSecret] = useState(false);
  const [clearClientSecret, setClearClientSecret] = useState(false);
  const [bearerToken, setBearerToken] = useState("");
  const [authType, setAuthType] = useState<"oauth" | "bearer" | "none">("none");
  const [useCustomClientId, setUseCustomClientId] = useState(false);

  const [clientIdError, setClientIdError] = useState<string | null>(null);
  const [clientSecretError, setClientSecretError] = useState<string | null>(
    null
  );

  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(
    []
  );
  const [customHeaders, setCustomHeaders] = useState<HeaderEntry[]>([]);
  const [hasStoredEnv, setHasStoredEnv] = useState(false);
  const [hasStoredHeaders, setHasStoredHeaders] = useState(false);
  const [envDirty, setEnvDirty] = useState(false);
  const [headersDirty, setHeadersDirty] = useState(false);
  // Auth edits (auth type / bearer token) are tracked apart from header-row
  // edits: when hidden stored headers are merged in at save time, the saved
  // Authorization header must only be dropped if the user touched auth.
  const [authDirty, setAuthDirty] = useState(false);
  const [envRevealed, setEnvRevealed] = useState(false);
  const [headersRevealed, setHeadersRevealed] = useState(false);
  const [requestTimeout, setRequestTimeout] = useState<string>("");
  const [
    clientCapabilitiesOverrideEnabled,
    setClientCapabilitiesOverrideEnabled,
  ] = useState(false);
  const [clientCapabilitiesOverrideText, setClientCapabilitiesOverrideText] =
    useState("{}");
  const [clientCapabilitiesOverrideError, setClientCapabilitiesOverrideError] =
    useState<string | null>(null);

  const [showConfiguration, setShowConfiguration] = useState<boolean>(false);
  const [showEnvVars, setShowEnvVars] = useState<boolean>(false);
  const [showAuthSettings, setShowAuthSettings] = useState<boolean>(false);

  const initialValues = useRef<InitialFormValues | null>(null);
  const projectConnectionDefaults = getEffectiveProjectConnectionDefaults(
    options?.projectClientConfig
  );

  const parseCapabilitiesOverride = (
    value: string
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
      let registrationModeValue: ServerFormOAuthRegistrationMode =
        DEFAULT_OAUTH_REGISTRATION_MODE;
      let clientIdValue = "";
      let clientSecretValue = "";
      let hasStoredClientSecretValue = false;
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
          `mcp-oauth-config-${server.name}`
        );
        const storedClientInfo = localStorage.getItem(
          `mcp-client-${server.name}`
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
        hasStoredClientSecretValue = server.hasClientSecret === true;

        // Keep runtime token metadata available for preregistered reconnects,
        // but only surface credential fields from saved client configuration.
        clientIdValue = storedTokens?.client_id || savedClientId;
        // Only mask in hosted mode — there the secret lives in the Vault and
        // never round-trips to the browser, so blanking the field protects it.
        // In local mode the actual secret is in localStorage; blanking it would
        // cause an unrelated edit + save to overwrite mcp-client-* without the
        // secret, silently deleting it.
        clientSecretValue =
          HOSTED_MODE && hasStoredClientSecretValue ? "" : savedClientSecret;

        protocolModeValue = normalizeOauthProtocolMode(
          typeof oauthConfig.protocolMode === "string"
            ? oauthConfig.protocolMode
            : typeof server.oauthFlowProfile?.protocolVersion === "string"
            ? server.oauthFlowProfile.protocolVersion
            : typeof oauthConfig.protocolVersion === "string"
            ? oauthConfig.protocolVersion
            : undefined
        );

        registrationModeValue =
          normalizeOauthRegistrationMode(oauthConfig.registrationMode) ??
          normalizeOauthRegistrationMode(
            server.oauthFlowProfile?.registrationStrategy
          ) ??
          normalizeOauthRegistrationMode(oauthConfig.registrationStrategy) ??
          (savedClientId || savedClientSecret || hasStoredClientSecretValue
            ? "preregistered"
            : DEFAULT_OAUTH_REGISTRATION_MODE);

        shouldShowClientCredentials =
          registrationModeValue === "preregistered" ||
          Boolean(
            savedClientId || savedClientSecret || hasStoredClientSecretValue
          );
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
      const authorizationHeader = isHttpServer
        ? getAuthorizationHeaderValue(
            config.requestInit?.headers as Record<string, unknown> | undefined
          )
        : undefined;
      const hasBearer =
        typeof authorizationHeader === "string" &&
        authorizationHeader.startsWith("Bearer ");
      const bearerTokenValue = hasBearer
        ? authorizationHeader.replace("Bearer ", "")
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
      setHasStoredClientSecret(hasStoredClientSecretValue);
      setClearClientSecret(false);
      setRequestTimeout(timeoutValue);
      setClientCapabilitiesOverrideEnabled(
        clientCapabilitiesOverrideValue != null
      );
      setClientCapabilitiesOverrideText(
        JSON.stringify(clientCapabilitiesOverrideValue ?? {}, null, 2)
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
      const hasStoredEnvValue =
        !isHttpServer && server.hasEnv === true && envArray.length === 0;
      setHasStoredEnv(hasStoredEnvValue);
      setEnvRevealed(envArray.length > 0);
      setEnvDirty(false);

      // Initialize custom headers for HTTP servers (excluding Authorization)
      let headersArray: HeaderEntry[] = [];
      if (
        isHttpServer &&
        config.requestInit?.headers &&
        typeof config.requestInit.headers === "object"
      ) {
        headersArray = Object.entries(config.requestInit.headers)
          .filter(([key]) => !isAuthorizationHeader(key))
          .map(([key, value]) => createHeaderEntry(key, String(value)));
      }
      setCustomHeaders(headersArray);
      const hasStoredHeadersValue =
        isHttpServer && server.hasHeaders === true && headersArray.length === 0;
      setHasStoredHeaders(hasStoredHeadersValue);
      setHeadersRevealed(headersArray.length > 0);
      setHeadersDirty(false);
      setAuthDirty(false);
      setShowConfiguration(
        headersArray.length > 0 ||
          timeoutValue.trim() !== "" ||
          clientCapabilitiesOverrideValue != null
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
        hasStoredClientSecret: hasStoredClientSecretValue,
        clearClientSecret: false,
        hasStoredEnv: hasStoredEnvValue,
        hasStoredHeaders: hasStoredHeadersValue,
        envVars: envArray.map(({ key, value }) => ({ key, value })),
        customHeaders: headersArray.map(({ key, value }) => ({ key, value })),
        requestTimeout: timeoutValue,
        clientCapabilitiesOverrideEnabled:
          clientCapabilitiesOverrideValue != null,
        clientCapabilitiesOverrideText: JSON.stringify(
          clientCapabilitiesOverrideValue ?? {},
          null,
          2
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
    setEnvDirty(true);
    setEnvVars([...envVars, { key: "", value: "" }]);
    setShowEnvVars(true);
  };

  const removeEnvVar = (index: number) => {
    setEnvDirty(true);
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  const updateEnvVar = (
    index: number,
    field: "key" | "value",
    value: string
  ) => {
    setEnvDirty(true);
    const updated = [...envVars];
    updated[index][field] = value;
    setEnvVars(updated);
  };

  const addCustomHeader = () => {
    setHeadersDirty(true);
    setCustomHeaders([...customHeaders, createHeaderEntry()]);
  };

  const removeCustomHeader = (index: number) => {
    setHeadersDirty(true);
    setCustomHeaders(customHeaders.filter((_, i) => i !== index));
  };

  const updateCustomHeader = (
    index: number,
    field: "key" | "value",
    value: string
  ) => {
    setHeadersDirty(true);
    const updated = [...customHeaders];
    updated[index] = {
      ...updated[index],
      [field]: value,
    };
    setCustomHeaders(updated);
  };

  const revealStoredEnv = (env: Record<string, string> | null | undefined) => {
    const nextEnvVars = Object.entries(env ?? {}).map(([key, value]) => ({
      key,
      value: String(value),
    }));
    setEnvVars(nextEnvVars);
    setHasStoredEnv(false);
    setEnvRevealed(true);
    setEnvDirty(false);
    setShowEnvVars(true);
    if (initialValues.current) {
      initialValues.current = {
        ...initialValues.current,
        hasStoredEnv: false,
        envVars: nextEnvVars.map(({ key, value }) => ({ key, value })),
      };
    }
  };

  const revealStoredHeaders = (
    headers: Record<string, string> | null | undefined
  ) => {
    const nextCustomHeaders = Object.entries(headers ?? {})
      .map(([key, value]) => createHeaderEntry(key, String(value)));
    setCustomHeaders(nextCustomHeaders);
    setHasStoredHeaders(false);
    setHeadersRevealed(true);
    setHeadersDirty(false);
    setShowConfiguration(true);
    if (initialValues.current) {
      initialValues.current = {
        ...initialValues.current,
        hasStoredHeaders: false,
        customHeaders: nextCustomHeaders.map(({ key, value }) => ({
          key,
          value,
        })),
      };
    }
  };

  const replaceEnvVars = (
    nextEnvVars: Array<{ key: string; value: string }>
  ) => {
    setEnvVars(nextEnvVars);
    setHasStoredEnv(false);
    setEnvRevealed(nextEnvVars.length > 0);
    setEnvDirty(true);
  };

  const replaceCustomHeaders = (nextHeaders: HeaderEntry[]) => {
    setCustomHeaders(nextHeaders);
    setHasStoredHeaders(false);
    setHeadersRevealed(nextHeaders.length > 0);
    setHeadersDirty(true);
  };

  const updateClientCapabilitiesOverride = (value: string) => {
    setClientCapabilitiesOverrideText(value);
    try {
      parseCapabilitiesOverride(value);
      setClientCapabilitiesOverrideError(null);
    } catch (error) {
      setClientCapabilitiesOverrideError(
        error instanceof Error ? error.message : "Invalid JSON"
      );
    }
  };

  const buildFormData = (buildOptions?: {
    /**
     * Stored headers fetched from the secrets API at save time. Supplying
     * them lets a server with hidden stored headers take an auth or header
     * change without wiping the headers the form can't see.
     */
    revealedHeaders?: Record<string, string>;
  }): ServerFormData => {
    const parsedTimeout = Number.parseInt(requestTimeout.trim(), 10);
    const reqTimeout = Number.isFinite(parsedTimeout)
      ? parsedTimeout
      : undefined;
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

      const secretPatch = envDirty ? { env } : undefined;
      const includeEnv = !hasStoredEnv || envDirty || envRevealed;

      return {
        name: name.trim(),
        type: "stdio",
        command: command.trim(),
        args,
        ...(includeEnv ? { env } : {}),
        ...(secretPatch ? { secretPatch } : {}),
        requestTimeout: reqTimeout,
        clientCapabilities,
      };
    }

    // Handle http-specific data
    const revealedStoredHeaders = buildOptions?.revealedHeaders;
    const headers: Record<string, string> = {};

    // Seed with the stored headers so the replacement patch keeps them. The
    // saved Authorization header only carries over while auth is untouched —
    // once the user edits auth, the auth section below is authoritative.
    if (revealedStoredHeaders) {
      for (const [key, value] of Object.entries(revealedStoredHeaders)) {
        if (authDirty && isAuthorizationHeader(key)) {
          continue;
        }
        headers[key] = value;
      }
    }

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
    const shouldUsePreregisteredCredentials =
      authType === "oauth" && oauthRegistrationMode === "preregistered";
    const normalizedClientSecret = clientSecret.trim();
    const hasReplacementClientSecret = normalizedClientSecret.length > 0;
    // A typed replacement always wins over the clear toggle — the backend
    // rejects payloads that try to do both at once.
    const submittedClearClientSecret =
      shouldUsePreregisteredCredentials &&
      clearClientSecret &&
      !hasReplacementClientSecret;
    const nextHasClientSecret =
      shouldUsePreregisteredCredentials &&
      !submittedClearClientSecret &&
      (hasStoredClientSecret || hasReplacementClientSecret);

    // Handle authentication
    let useOAuth = false;
    if (authType === "bearer" && bearerToken.trim()) {
      headers["Authorization"] = `Bearer ${bearerToken.trim()}`;
    } else if (authType === "oauth") {
      useOAuth = true;
    }
    const explicitHeaders =
      Object.keys(headers).length > 0 ? headers : undefined;
    const canPatchHeaders =
      !hasStoredHeaders || headersRevealed || revealedStoredHeaders != null;
    const secretPatch =
      (headersDirty || authDirty) && canPatchHeaders ? { headers } : undefined;

    return {
      name: name.trim(),
      type: "http",
      url: url.trim(),
      headers: explicitHeaders,
      ...(secretPatch ? { secretPatch } : {}),
      clientCapabilities,
      useOAuth,
      oauthProtocolMode: useOAuth ? oauthProtocolMode : undefined,
      oauthRegistrationMode: useOAuth ? oauthRegistrationMode : undefined,
      oauthScopes: scopes.length > 0 ? scopes : undefined,
      clientId: shouldUsePreregisteredCredentials
        ? clientId.trim() || undefined
        : undefined,
      clientSecret: shouldUsePreregisteredCredentials
        ? normalizedClientSecret || undefined
        : undefined,
      hasClientSecret: shouldUsePreregisteredCredentials
        ? nextHasClientSecret
        : undefined,
      clearClientSecret: shouldUsePreregisteredCredentials
        ? submittedClearClientSecret
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
    setOauthRegistrationMode(DEFAULT_OAUTH_REGISTRATION_MODE);
    setClientId("");
    setClientSecret("");
    setHasStoredClientSecret(false);
    setClearClientSecret(false);
    setBearerToken("");
    setAuthType("none");
    setUseCustomClientId(false);
    setClientIdError(null);
    setClientSecretError(null);
    setEnvVars([]);
    setCustomHeaders([]);
    setHasStoredEnv(false);
    setHasStoredHeaders(false);
    setEnvDirty(false);
    setHeadersDirty(false);
    setAuthDirty(false);
    setEnvRevealed(false);
    setHeadersRevealed(false);
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
      hasStoredClientSecret !== iv.hasStoredClientSecret ||
      clearClientSecret !== iv.clearClientSecret ||
      hasStoredEnv !== iv.hasStoredEnv ||
      hasStoredHeaders !== iv.hasStoredHeaders ||
      requestTimeout !== iv.requestTimeout ||
      clientCapabilitiesOverrideEnabled !==
        iv.clientCapabilitiesOverrideEnabled ||
      clientCapabilitiesOverrideText !== iv.clientCapabilitiesOverrideText ||
      JSON.stringify(envVars) !== JSON.stringify(iv.envVars) ||
      JSON.stringify(toComparableHeaders(customHeaders)) !==
        JSON.stringify(iv.customHeaders)
    );
  })();

  // Saving a header-affecting change replaces the whole stored header set,
  // so when that set is hidden the caller must fetch it (secrets API) and
  // pass it to buildFormData as `revealedHeaders` before submitting.
  const needsStoredHeaderReveal =
    type === "http" &&
    hasStoredHeaders &&
    !headersRevealed &&
    (headersDirty || authDirty);

  const preregisteredOauthBlocksSubmit =
    type === "http" &&
    authType === "oauth" &&
    oauthRegistrationMode === "preregistered" &&
    validateClientId(clientId) !== null;
  const oauthAuthorizationHeaderWarning =
    type === "http" &&
    authType === "oauth" &&
    customHeaders.some((header) => isAuthorizationHeader(header.key))
      ? "OAuth is enabled and custom headers include Authorization. OAuth token headers may override or conflict with this value."
      : undefined;

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
    hasStoredClientSecret,
    setHasStoredClientSecret,
    clearClientSecret,
    setClearClientSecret,
    bearerToken,
    setBearerToken: (value: string) => {
      setAuthDirty(true);
      setBearerToken(value);
    },
    authType,
    setAuthType: (value: "oauth" | "bearer" | "none") => {
      setAuthDirty(true);
      setAuthType(value);
    },
    useCustomClientId,
    setUseCustomClientId,
    requestTimeout,
    setRequestTimeout,
    inheritedRequestTimeout: projectConnectionDefaults.requestTimeout,
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
    setEnvVars: replaceEnvVars,
    customHeaders,
    setCustomHeaders: replaceCustomHeaders,
    hasStoredEnv,
    hasStoredHeaders,
    envDirty,
    headersDirty,
    envRevealed,
    headersRevealed,
    needsStoredHeaderReveal,

    // Toggle states
    showConfiguration,
    setShowConfiguration,
    showEnvVars,
    setShowEnvVars,
    showAuthSettings,
    setShowAuthSettings,
    oauthAuthorizationHeaderWarning,

    // Functions
    validateClientId,
    validateClientSecret,
    validateForm,
    addEnvVar,
    removeEnvVar,
    updateEnvVar,
    revealStoredEnv,
    addCustomHeader,
    removeCustomHeader,
    updateCustomHeader,
    revealStoredHeaders,
    updateClientCapabilitiesOverride,
    buildFormData,
    resetForm,
  };
}
