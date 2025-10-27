import { useCallback, useEffect, useState } from "react";
import {
  clearProxyAuthToken,
  getProxyAuthToken,
  setProxyAuthToken,
  subscribeProxyAuth,
} from "@/lib/proxy-auth";

export function useProxyAuthToken() {
  const [token, setTokenState] = useState<string | null>(() =>
    getProxyAuthToken(),
  );

  useEffect(() => {
    return subscribeProxyAuth((nextToken) => {
      setTokenState(nextToken);
    });
  }, []);

  const setToken = useCallback((nextToken: string | null) => {
    const normalized = nextToken?.trim() || null;
    setProxyAuthToken(normalized);
  }, []);

  const clearToken = useCallback(() => {
    clearProxyAuthToken();
  }, []);

  return {
    token,
    hasToken: Boolean(token),
    setToken,
    clearToken,
  };
}
