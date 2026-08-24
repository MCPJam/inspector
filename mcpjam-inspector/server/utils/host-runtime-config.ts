/**
 * Fetch the live runtime execution config for a SAVED host, keyed by hostId.
 *
 * The chat-v2 endpoints call this for a host-bound DIRECT session (the
 * Playground previewing a saved host) so the server can source execution
 * fields — and critically `harness` / `computer` — from the host's persisted
 * `hostConfigs` row instead of trusting the client body. This is the
 * server-authoritative gate that lets a Claude Code host run the real harness:
 * `harness` is never accepted from the body, only read here.
 *
 * Mirrors {@link fetchScenarioRuntimeConfig}. Backed by
 * `convex/http.ts:/web/host/runtime-config`, which walks `host → hostConfig`
 * via `internalGetHostRuntimeConfig` (project-membership gated).
 */

import { type Harness } from "@mcpjam/sdk/host-config/internal";
import { isAbortError } from "@/shared/abort-errors";
import { logger } from "./logger.js";
import { type RuntimeExecutionFields } from "./execution-scope.js";

export type HostRuntimeConfig = RuntimeExecutionFields & {
  hostId: string;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;
  respectToolVisibility?: boolean;
  hostStyle: string;
  progressiveToolDiscovery?: boolean;
  builtInToolIds?: string[];
  // Host harness selector from the pinned HostConfigV2. Optional so a backend
  // that predates the endpoint returns omitted → emulated path. Omitted by the
  // backend for guest actors.
  harness?: Harness;
  // Personal-computer attachment (resource only; capabilities ride
  // builtInToolIds). `toolset` is a tolerated legacy key. Omitted for guests.
  computer?: {
    kind: "personal";
    toolset?: "bash";
    workdir?: string;
  };
  // Host-level MCP profile envelope from the HostConfigV2 — carries the
  // enterprise-managed authorization policy under
  // `extensions["com.mcpjam/enterprise-managed-auth"]`. Server-authoritative
  // for host-bound turns. Optional so a backend that predates the projection
  // returns omitted → policy off (safe: matches pre-feature behavior).
  mcpProfile?: Record<string, unknown>;
};

export type HostRuntimeConfigResult =
  | { ok: true; config: HostRuntimeConfig }
  | { ok: false; status: number; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeHostRuntimeConfig(
  raw: Record<string, unknown>
): HostRuntimeConfig {
  const nestedConfig = isRecord(raw.config)
    ? raw.config
    : isRecord(raw.hostConfig)
      ? raw.hostConfig
      : null;
  const { config: _ignoredConfig, hostConfig: _ignoredHostConfig, ...topLevel } =
    raw;
  // Current runtime-config is expected to be flat, but some host APIs return
  // `{ ..., config: HostConfigV2 }` (or `hostConfig`). The Playground sidebar
  // reads that nested DTO and shows Claude Code built-ins; execution reads this
  // helper. Flatten the nested config as a compatibility shim so
  // `harness: "claude-code"` does not disappear and silently route the turn
  // through the emulated engine.
  return {
    ...(nestedConfig ?? {}),
    ...topLevel,
  } as HostRuntimeConfig;
}

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for host runtime-config");
  }
  return convexHttpUrl;
}

function wasAborted(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || isAbortError(error);
}

/**
 * Gap before the single retry. Without it the second attempt lands inside the
 * same DNS/socket blip it is meant to outlive, and only doubles the wait. Kept
 * short because this runs before the turn opens its stream, and abort-aware so
 * a Stop during the gap is still immediate.
 */
const RETRY_DELAY_MS = 250;

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchHostRuntimeConfig(args: {
  hostId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<HostRuntimeConfigResult> {
  // Normalize to the TOKEN, then re-prefix, so `Bearer ` (header present,
  // token empty) is recognized as blank rather than sent on as the
  // double-prefixed `Bearer Bearer`.
  //
  // The prefix test REQUIRES whitespace (`/^Bearer\s/i`, the same shape the
  // original code used): an opaque token that merely starts with the letters
  // "Bearer" (`Bearerabc…`) must be forwarded untouched, not silently turned
  // into a different token. And the left-trim happens BEFORE the test, never a
  // full `trim()` first — trimming `"Bearer "` down to `"Bearer"` destroys the
  // very space that distinguishes an empty-token header from a token that is
  // itself the word "Bearer".
  const leftTrimmed = args.bearer.replace(/^\s+/, "");
  const bearerToken = (
    /^Bearer\s/i.test(leftTrimmed) ? leftTrimmed.slice("Bearer".length) : leftTrimmed
  ).trim();
  // A BLANK bearer never reaches the network, and is answered BEFORE the
  // endpoint config is resolved: an unauthenticated turn is the caller's
  // problem and must read as 401, not inherit the 500 that missing
  // `CONVEX_HTTP_URL` returns below.
  //
  // `Bearer ` with nothing after it is a MALFORMED header, and Convex's
  // `getUserIdentity()` throws on it instead of returning null — so the
  // backend route's catch-all answers 500, both chat-v2 routes collapse a
  // >=500 to 502, and the client attributes any 5xx from our own route to
  // MCPJam. A local Playground turn on a host-bound conversation whose
  // guest/member token hadn't resolved (`/api/mcp/chat-v2` reads the header as
  // `""`) therefore paged us with "Invalid authentication header" instead of
  // asking the user to retry. Fail closed as 401, the way the scenario branch
  // of `mcp/chat-v2.ts` already does before it fetches.
  if (!bearerToken) {
    return {
      ok: false,
      status: 401,
      error:
        "Couldn't authenticate this turn — retry, or sign in if you're not a guest.",
    };
  }
  let url: string;
  try {
    url = new URL("/web/host/runtime-config", getConvexHttpUrl()).toString();
  } catch (err) {
    // Keep missing/invalid Convex config inside the result contract so callers
    // always get the fail-closed { ok: false, status, error } path instead of a
    // thrown exception escaping before the request flow.
    logger.error("[host-runtime-config] missing endpoint config", err);
    return {
      ok: false,
      status: 500,
      error: "Host runtime-config endpoint is not configured",
    };
  }
  const authorization = `Bearer ${bearerToken}`;
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
    },
    body: JSON.stringify({ hostId: args.hostId }),
    signal: args.signal,
  };

  let response: Response;
  try {
    response = await fetch(url, requestInit);
  } catch (err) {
    // This POST is a read-only config lookup. Retrying a single transport
    // failure is safe and prevents a transient DNS/socket blip from stopping
    // a turn before it reaches the engine. Never retry a caller cancellation:
    // the same signal would reject again and Stop must remain immediate.
    if (wasAborted(err, args.signal)) {
      logger.error("[host-runtime-config] network error", err);
      return {
        ok: false,
        status: 502,
        error: "Failed to reach host runtime-config endpoint",
      };
    }

    logger.warn("[host-runtime-config] transient network error; retrying once", {
      hostId: args.hostId,
    });
    await delay(RETRY_DELAY_MS, args.signal);
    if (args.signal?.aborted) {
      return {
        ok: false,
        status: 502,
        error: "Failed to reach host runtime-config endpoint",
      };
    }
    try {
      response = await fetch(url, requestInit);
    } catch (retryError) {
      logger.error("[host-runtime-config] network error after retry", retryError);
      return {
        ok: false,
        status: 502,
        error: "Failed to reach host runtime-config endpoint",
      };
    }
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error: `Host runtime-config returned ${response.status} with non-JSON body`,
    };
  }

  if (!response.ok || payload?.ok !== true || !payload?.config) {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Host runtime-config failed (${response.status})`,
    };
  }

  return {
    ok: true,
    config: normalizeHostRuntimeConfig(payload.config as Record<string, unknown>),
  };
}
