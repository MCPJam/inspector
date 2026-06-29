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
 * Mirrors {@link fetchChatboxRuntimeConfig}. Backed by
 * `convex/http.ts:/web/host/runtime-config`, which walks `host → hostConfig`
 * via `internalGetHostRuntimeConfig` (project-membership gated).
 */

import { type Harness } from "@mcpjam/sdk/host-config/internal";
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
};

export type HostRuntimeConfigResult =
  | { ok: true; config: HostRuntimeConfig }
  | { ok: false; status: number; error: string };

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for host runtime-config");
  }
  return convexHttpUrl;
}

export async function fetchHostRuntimeConfig(args: {
  hostId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<HostRuntimeConfigResult> {
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
  const trimmedBearer = args.bearer.trim();
  const authorization = /^Bearer\s/i.test(trimmedBearer)
    ? trimmedBearer
    : `Bearer ${trimmedBearer}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify({ hostId: args.hostId }),
      signal: args.signal,
    });
  } catch (err) {
    logger.error("[host-runtime-config] network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach host runtime-config endpoint",
    };
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

  return { ok: true, config: payload.config as HostRuntimeConfig };
}
