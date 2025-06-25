import { useState, useCallback, useEffect } from "react";
import { InspectorConfig } from "@/lib/configurationTypes";
import { AuthDebuggerState } from "@/lib/auth-types";
import { initializeInspectorConfig } from "@/utils/configUtils";

const CONFIG_LOCAL_STORAGE_KEY = "inspectorConfig_v1";

export const useConfigState = () => {
  const [config, setConfig] = useState<InspectorConfig>(() =>
    initializeInspectorConfig(CONFIG_LOCAL_STORAGE_KEY),
  );

  const [bearerToken, setBearerToken] = useState<string>(() => {
    return localStorage.getItem("lastBearerToken") || "";
  });

  const [headerName, setHeaderName] = useState<string>(() => {
    return localStorage.getItem("lastHeaderName") || "";
  });

  // Auth debugger state
  const [authState, setAuthState] = useState<AuthDebuggerState>({
    isInitiatingAuth: false,
    oauthTokens: null,
    loading: true,
    oauthStep: "metadata_discovery",
    oauthMetadata: null,
    oauthClientInfo: null,
    authorizationUrl: null,
    authorizationCode: "",
    latestError: null,
    statusMessage: null,
    validationError: null,
    resourceMetadata: null,
    resourceMetadataError: null,
    authServerUrl: null,
  });

  // Helper function to update specific auth state properties
  const updateAuthState = useCallback((updates: Partial<AuthDebuggerState>) => {
    setAuthState((prev) => ({ ...prev, ...updates }));
  }, []);

  // Persist config to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem(CONFIG_LOCAL_STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  // Persist bearer token whenever it changes
  useEffect(() => {
    localStorage.setItem("lastBearerToken", bearerToken);
  }, [bearerToken]);

  // Persist header name whenever it changes
  useEffect(() => {
    localStorage.setItem("lastHeaderName", headerName);
  }, [headerName]);

  // Ensure default hash is set
  useEffect(() => {
    if (!window.location.hash) {
      window.location.hash = "tools";
    }
  }, []);

  return {
    config,
    setConfig,
    bearerToken,
    setBearerToken,
    headerName,
    setHeaderName,
    authState,
    updateAuthState,
  };
};
