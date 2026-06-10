/**
 * Fetch the live runtime execution config for a chatbox.
 *
 * The chat-v2 endpoints call this when a request carries a `chatboxId` so
 * the server can override client-supplied `model` / `systemPrompt` /
 * `temperature` / `requireToolApproval` with whatever the chatbox's host
 * currently resolves to. Without this re-resolution the inspector trusts
 * the client body verbatim — which lets a stale playgroundSession or a
 * tampered request route a chatbox session through a different model or
 * skip tool approval. The host's `hostConfigs` row is the source of truth.
 *
 * Backed by `convex/http.ts:/web/chatbox/runtime-config`, which in turn
 * walks `chatbox → host → hostConfig` via `internalGetChatboxRuntimeConfig`.
 */

import { logger } from "./logger.js";

export type ChatboxRuntimeConfig = {
  chatboxId: string;
  accessVersion: number;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;
  // Optional for compatibility with backends that predate SEP-1865
  // visibility filtering on runtime-config.
  respectToolVisibility?: boolean;
  hostStyle: string;
  // Host-level opt-in for progressive MCP tool discovery, mirrored from
  // the chatbox's pinned HostConfigV2. Optional so a backend older than
  // mcpjam-backend PR #334 (which adds the field) returns omitted →
  // undefined and the inspector falls back to its auto policy.
  progressiveToolDiscovery?: boolean;
  // Built-in tool ids from the pinned HostConfigV2 (e.g. ["web_search"]).
  // Optional so a backend older than mcpjam-backend PR #484 (which adds
  // the field to runtime-config) returns omitted → no built-in tools.
  builtInToolIds?: string[];
};

export type ChatboxRuntimeConfigResult =
  | { ok: true; config: ChatboxRuntimeConfig }
  | { ok: false; status: number; error: string };

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for chatbox runtime-config");
  }
  return convexHttpUrl;
}

export async function fetchChatboxRuntimeConfig(args: {
  chatboxId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<ChatboxRuntimeConfigResult> {
  const url = new URL(
    "/web/chatbox/runtime-config",
    getConvexHttpUrl()
  ).toString();
  const authorization = args.bearer.startsWith("Bearer ")
    ? args.bearer
    : `Bearer ${args.bearer}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify({ chatboxId: args.chatboxId }),
      signal: args.signal,
    });
  } catch (err) {
    logger.error("[chatbox-runtime-config] network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach chatbox runtime-config endpoint",
    };
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error: `Chatbox runtime-config returned ${response.status} with non-JSON body`,
    };
  }

  if (!response.ok || payload?.ok !== true || !payload?.config) {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Chatbox runtime-config failed (${response.status})`,
    };
  }

  return { ok: true, config: payload.config as ChatboxRuntimeConfig };
}
