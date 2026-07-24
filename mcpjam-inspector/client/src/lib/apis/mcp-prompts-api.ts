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

export async function listPrompts(
  serverId: string,
  opts?: { forceHosted?: boolean; cursor?: string },
): Promise<MCPPrompt[]> {
  const { prompts } = await listPromptsPage(serverId, opts);
  return prompts;
}

// Cursor-aware variant of `listPrompts`, additive alongside it: omitting
// `cursor` still returns the full aggregate (unchanged default behavior);
// passing one returns exactly one raw page plus `nextCursor` when the server
// has more. This is the plumbing a future paginated Prompts UI would call.
export async function listPromptsPage(
  serverId: string,
  opts?: { forceHosted?: boolean; cursor?: string },
): Promise<{ prompts: MCPPrompt[]; nextCursor?: string }> {
  return runByMode({
    forceHosted: opts?.forceHosted,
    hosted: async () => {
      const body = await listHostedPrompts({
        serverNameOrId: serverId,
        cursor: opts?.cursor,
      });
      return {
        prompts: Array.isArray(body?.prompts)
          ? (body.prompts as MCPPrompt[])
          : [],
        ...(typeof body?.nextCursor === "string"
          ? { nextCursor: body.nextCursor }
          : {}),
      };
    },
    local: async () => {
      const res = await authFetch("/api/mcp/prompts/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId,
          ...(opts?.cursor ? { cursor: opts.cursor } : {}),
        }),
      });

      let body: any = null;
      try {
        body = await res.json();
      } catch {}

      if (!res.ok) {
        const message = body?.error || `List prompts failed (${res.status})`;
        throw new Error(message);
      }

      return {
        prompts: Array.isArray(body?.prompts)
          ? (body.prompts as MCPPrompt[])
          : [],
        ...(typeof body?.nextCursor === "string"
          ? { nextCursor: body.nextCursor }
          : {}),
      };
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
