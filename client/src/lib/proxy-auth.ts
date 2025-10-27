const STORAGE_KEY = "mcp-proxy-auth-token";

export type ProxyAuthListener = (token: string | null) => void;

const listeners = new Set<ProxyAuthListener>();

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function notify(token: string | null) {
  for (const listener of listeners) {
    try {
      listener(token);
    } catch (error) {
      console.error("Failed to notify proxy auth listener", error);
    }
  }
}

export function getProxyAuthToken(): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const token = storage.getItem(STORAGE_KEY);
    return token || null;
  } catch {
    return null;
  }
}

export function setProxyAuthToken(token: string | null) {
  const storage = getStorage();
  if (!storage) return;

  try {
    if (!token) {
      storage.removeItem(STORAGE_KEY);
    } else {
      storage.setItem(STORAGE_KEY, token);
    }
  } catch (error) {
    console.error("Failed to persist proxy auth token", error);
  }

  notify(token);
}

export function clearProxyAuthToken() {
  setProxyAuthToken(null);
}

export function subscribeProxyAuth(listener: ProxyAuthListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function initializeProxyAuthFromUrl(): string | null {
  if (typeof window === "undefined") return null;

  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("MCP_PROXY_AUTH_TOKEN");
    if (token) {
      setProxyAuthToken(token);
      url.searchParams.delete("MCP_PROXY_AUTH_TOKEN");
      window.history.replaceState(null, document.title, url.toString());
      return token;
    }
  } catch (error) {
    console.error("Failed to initialize proxy auth token from URL", error);
  }

  return null;
}

export function mergeProxyAuthHeaders(existing?: HeadersInit): Headers {
  const headers = new Headers(existing ?? {});
  const token = getProxyAuthToken();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
}

export function withProxyAuth(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: mergeProxyAuthHeaders(init.headers),
  };
}

export function appendProxyAuthToUrl(input: string): string {
  const token = getProxyAuthToken();
  if (!token || typeof window === "undefined") {
    return input;
  }

  try {
    const url = new URL(input, window.location.origin);
    url.searchParams.set("MCP_PROXY_AUTH_TOKEN", token);
    if (input.startsWith("http://") || input.startsWith("https://")) {
      return url.toString();
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return input;
  }
}

export function isProxyAuthConfigured(): boolean {
  return !!getProxyAuthToken();
}
