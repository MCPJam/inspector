/**
 * Fetch per-server harness MCP proxy tokens from Convex — the same bearer-authed
 * channel the harness already uses for `model-credential` and `session-state`.
 *
 * Convex MINTS the tokens (it knows the authenticated user, so identity is
 * authoritative and baked in) and checks per-server access; the inspector only
 * verifies + forwards. Mirrors `harness-model-credential.ts`.
 *
 * Backed by `convex/http.ts:/web/harness/mcp-proxy-token`.
 */
import { logger } from "../logger.js";

export type HarnessProxyTokensResult =
  | { ok: true; tokens: Record<string, string> }
  | { ok: false; status: number; error: string };

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for harness proxy tokens");
  }
  return convexHttpUrl;
}

/**
 * Mint a token per server. Convex returns only servers the caller can access
 * (others are silently omitted — the inspector just won't attach them).
 */
export async function fetchHarnessProxyTokens(args: {
  projectId: string;
  serverIds: string[];
  bearer: string;
  signal?: AbortSignal;
}): Promise<HarnessProxyTokensResult> {
  const url = new URL(
    "/web/harness/mcp-proxy-token",
    getConvexHttpUrl(),
  ).toString();
  const authorization = args.bearer.startsWith("Bearer ")
    ? args.bearer
    : `Bearer ${args.bearer}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        projectId: args.projectId,
        serverIds: args.serverIds,
      }),
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (err) {
    logger.error("[harness-proxy-token] network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach harness mcp-proxy-token endpoint",
    };
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error: `Harness mcp-proxy-token returned ${response.status} with non-JSON body`,
    };
  }

  if (!response.ok || payload?.ok !== true || typeof payload?.tokens !== "object") {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Harness mcp-proxy-token failed (${response.status})`,
    };
  }

  return { ok: true, tokens: payload.tokens as Record<string, string> };
}
