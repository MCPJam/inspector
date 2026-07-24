import type { MCPPrompt } from "@mcpjam/sdk/browser";
import { authFetch } from "@/lib/session-token";
import {
  getHostedPrompt,
  listHostedPrompts,
  listHostedPromptsMulti,
} from "@/lib/apis/web/prompts-api";
import { resolveHostedServerId } from "@/lib/apis/web/context";
import { runByMode } from "@/lib/apis/mode-client";

export interface PromptContentResponse {
  content: any;
}

export interface BatchPromptsResponse {
  prompts: Record<string, MCPPrompt[]>;
  errors?: Record<string, string>;
}

/** SEP-2549 cache-serve provenance (§11.2) — present ONLY on an actual hit. */
export type ServedFromCache = { ageMs: number };

/**
 * `listPrompts` keeps its historical bare-array return shape (many callers
 * destructure it directly); provenance is attached as a non-enumerable-ish
 * extra property so it survives without forcing every call site to unwrap an
 * envelope. Present ONLY when a hit actually occurred.
 */
export type PromptListWithProvenance = MCPPrompt[] & {
  servedFromCache?: ServedFromCache;
};

export async function listPrompts(
  serverId: string,
  opts?: { forceHosted?: boolean; refresh?: boolean },
): Promise<PromptListWithProvenance> {
  return runByMode({
    forceHosted: opts?.forceHosted,
    hosted: async () => {
      const body = await listHostedPrompts({ serverNameOrId: serverId });
      // Hosted direct-ops always bypass the response cache server-side.
      return (
        Array.isArray(body?.prompts) ? (body.prompts as MCPPrompt[]) : []
      ) as PromptListWithProvenance;
    },
    local: async () => {
      const res = await authFetch("/api/mcp/prompts/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, refresh: opts?.refresh }),
      });

      let body: any = null;
      try {
        body = await res.json();
      } catch {}

      if (!res.ok) {
        const message = body?.error || `List prompts failed (${res.status})`;
        throw new Error(message);
      }

      const prompts = (
        Array.isArray(body?.prompts) ? (body.prompts as MCPPrompt[]) : []
      ) as PromptListWithProvenance;
      if (body?.servedFromCache) {
        // Non-enumerable so object-spread / for-in / Object.entries over the
        // bare array stay unchanged (matches the documented contract above);
        // provenance is still directly accessible as `.servedFromCache`.
        Object.defineProperty(prompts, "servedFromCache", {
          value: body.servedFromCache,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
      return prompts;
    },
  });
}

export async function getPrompt(
  serverId: string,
  name: string,
  args?: Record<string, string>,
): Promise<PromptContentResponse> {
  return runByMode({
    hosted: async () =>
      (await getHostedPrompt({
        serverNameOrId: serverId,
        promptName: name,
        arguments: args,
      })) as PromptContentResponse,
    local: async () => {
      const res = await authFetch("/api/mcp/prompts/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, name, args }),
      });

      let body: any = null;
      try {
        body = await res.json();
      } catch {}

      if (!res.ok) {
        const message = body?.error || `Get prompt failed (${res.status})`;
        throw new Error(message);
      }

      return body as PromptContentResponse;
    },
  });
}

export async function listPromptsForServers(
  serverIds: string[],
): Promise<BatchPromptsResponse> {
  return runByMode({
    hosted: async () => {
      const body = await listHostedPromptsMulti({
        serverNamesOrIds: serverIds,
      });
      const remappedPrompts: Record<string, MCPPrompt[]> = {};
      const remappedErrors: Record<string, string> = {};
      const reverseMap = Object.fromEntries(
        serverIds.map((serverName) => [
          resolveHostedServerId(serverName),
          serverName,
        ]),
      );

      for (const [serverId, prompts] of Object.entries(
        (body?.prompts ?? {}) as Record<string, MCPPrompt[]>,
      )) {
        remappedPrompts[reverseMap[serverId] ?? serverId] = prompts;
      }

      for (const [serverId, message] of Object.entries(
        (body?.errors ?? {}) as Record<string, string>,
      )) {
        remappedErrors[reverseMap[serverId] ?? serverId] = message;
      }

      return {
        prompts: remappedPrompts,
        errors:
          Object.keys(remappedErrors).length > 0 ? remappedErrors : undefined,
      };
    },
    local: async () => {
      const res = await authFetch("/api/mcp/prompts/list-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverIds }),
      });

      let body: any = null;
      try {
        body = await res.json();
      } catch {}

      if (!res.ok) {
        const message =
          body?.error || `Batch list prompts failed (${res.status})`;
        throw new Error(message);
      }

      return {
        prompts: (body?.prompts ?? {}) as Record<string, MCPPrompt[]>,
        errors: body?.errors as Record<string, string> | undefined,
      };
    },
  });
}
