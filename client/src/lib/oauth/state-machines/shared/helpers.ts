/**
 * Shared helper functions for OAuth state machines
 */

import type { OAuthFlowState } from "../types";

/**
 * Helper function to make requests via backend debug proxy (bypasses CORS)
 */
export async function proxyFetch(
  url: string,
  options: RequestInit = {},
): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
  ok: boolean;
}> {
  const defaultHeaders: Record<string, string> = {
    Accept: "application/json, text/event-stream",
  };

  const mergedHeaders = {
    ...defaultHeaders,
    ...((options.headers as Record<string, string>) || {}),
  };

  let bodyToSend: any = undefined;
  if (options.body) {
    const contentType =
      mergedHeaders[
        Object.keys(mergedHeaders).find(
          (k) => k.toLowerCase() === "content-type",
        ) || ""
      ];

    if (contentType?.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(options.body as string);
      bodyToSend = Object.fromEntries(params.entries());
    } else if (typeof options.body === "string") {
      try {
        bodyToSend = JSON.parse(options.body);
      } catch {
        bodyToSend = options.body;
      }
    } else {
      bodyToSend = options.body;
    }
  }

  const proxyPayload = {
    url,
    method: options.method || "GET",
    body: bodyToSend,
    headers: mergedHeaders,
  };

  const response = await fetch("/api/mcp/oauth/debug/proxy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(proxyPayload),
  });

  if (!response.ok) {
    throw new Error(
      `Backend debug proxy error: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  return {
    ...data,
    ok: data.status >= 200 && data.status < 300,
  };
}

/**
 * Helper function to add an info log to the state
 */
export function addInfoLog(
  state: OAuthFlowState,
  id: string,
  label: string,
  data: any,
): Array<{ id: string; label: string; data: any; timestamp: number }> {
  return [
    ...(state.infoLogs || []),
    {
      id,
      label,
      data,
      timestamp: Date.now(),
    },
  ];
}

/**
 * Helper function to generate random string for PKCE
 */
export function generateRandomString(length: number): string {
  const charset =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  return Array.from(
    randomValues,
    (byte) => charset[byte % charset.length],
  ).join("");
}

/**
 * Helper function to generate code challenge from verifier
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Helper: Load pre-registered OAuth credentials from localStorage
 */
export function loadPreregisteredCredentials(serverName: string): {
  clientId?: string;
  clientSecret?: string;
} {
  try {
    const storedClientInfo = localStorage.getItem(`mcp-client-${serverName}`);
    if (storedClientInfo) {
      const parsed = JSON.parse(storedClientInfo);
      return {
        clientId: parsed.client_id || undefined,
        clientSecret: parsed.client_secret || undefined,
      };
    }
  } catch (e) {
    console.error("Failed to load pre-registered credentials:", e);
  }
  return {};
}

/**
 * Build well-known resource metadata URL from server URL (RFC 9728)
 */
export function buildResourceMetadataUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.pathname !== "/" && url.pathname !== "") {
    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    return new URL(
      `/.well-known/oauth-protected-resource${pathname}`,
      url.origin,
    ).toString();
  }
  return new URL(
    "/.well-known/oauth-protected-resource",
    url.origin,
  ).toString();
}
