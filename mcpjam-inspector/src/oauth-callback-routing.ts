export const ELECTRON_MCP_CALLBACK_STATE_PREFIX = "electron_mcp:";
export const ELECTRON_HOSTED_AUTH_STATE_KEY = "__mcpjam_electron_hosted_auth";

function hasOAuthCallbackResult(url: URL): boolean {
  return url.searchParams.has("code") || url.searchParams.has("error");
}

export function isElectronMcpCallbackUrl(callbackUrl: URL): boolean {
  return (
    callbackUrl.searchParams.get("flow") === "mcp" ||
    Boolean(
      callbackUrl.searchParams
        .get("state")
        ?.startsWith(ELECTRON_MCP_CALLBACK_STATE_PREFIX)
    )
  );
}

function isElectronHostedAuthCallbackUrl(callbackUrl: URL): boolean {
  if (
    callbackUrl.pathname !== "/callback" ||
    !hasOAuthCallbackResult(callbackUrl)
  ) {
    return false;
  }

  const rawState = callbackUrl.searchParams.get("state");
  if (!rawState) {
    return false;
  }

  try {
    const parsed = JSON.parse(rawState) as Record<string, unknown> | null;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      parsed[ELECTRON_HOSTED_AUTH_STATE_KEY] === true
    );
  } catch {
    return false;
  }
}

export function buildRendererCallbackUrl(
  callbackUrl: URL,
  baseUrl: string
): URL | null {
  const flow = callbackUrl.searchParams.get("flow");

  if (flow === "debug") {
    return null;
  }

  const isMcpCallback = isElectronMcpCallbackUrl(callbackUrl);
  const rendererPath = isMcpCallback ? "/oauth/callback" : "/callback";
  const rendererUrl = new URL(rendererPath, baseUrl);

  for (const [key, value] of callbackUrl.searchParams.entries()) {
    if (key === "flow") continue;
    rendererUrl.searchParams.append(key, value);
  }

  return rendererUrl;
}

export function buildProtocolOAuthCallbackUrl(
  url: string,
  rendererBaseUrl: string
): string | null {
  if (url.startsWith("mcpjam://oauth/callback")) {
    return url;
  }

  try {
    const callbackUrl = new URL(url);
    const rendererBase = new URL(rendererBaseUrl);

    if (
      callbackUrl.origin !== rendererBase.origin ||
      !hasOAuthCallbackResult(callbackUrl)
    ) {
      return null;
    }

    const protocolUrl = new URL("mcpjam://oauth/callback");

    if (callbackUrl.pathname === "/callback") {
      if (!isElectronHostedAuthCallbackUrl(callbackUrl)) {
        return null;
      }
    } else if (callbackUrl.pathname === "/oauth/callback") {
      if (!isElectronMcpCallbackUrl(callbackUrl)) {
        return null;
      }

      protocolUrl.searchParams.set("flow", "mcp");
    } else if (callbackUrl.pathname === "/oauth/callback/debug") {
      protocolUrl.searchParams.set("flow", "debug");
    } else {
      return null;
    }

    for (const [key, value] of callbackUrl.searchParams.entries()) {
      if (key === "flow") continue;
      protocolUrl.searchParams.append(key, value);
    }

    return protocolUrl.toString();
  } catch {
    return null;
  }
}
