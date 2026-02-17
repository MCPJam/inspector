import type { MCPPrompt } from "@mcpjam/sdk";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import {
  getHostedPrompt,
  listHostedPrompts,
  listHostedPromptsMulti,
} from "@/lib/apis/web/prompts-api";
import { resolveHostedServerId } from "@/lib/apis/web/context";

export interface PromptContentResponse {
  content: any;
}

export interface BatchPromptsResponse {
  prompts: Record<string, MCPPrompt[]>;
  errors?: Record<string, string>;
}

export async function listPrompts(serverId: string): Promise<MCPPrompt[]> {
  if (HOSTED_MODE) {
    const body = await listHostedPrompts({ serverNameOrId: serverId });
    return Array.isArray(body?.prompts) ? (body.prompts as MCPPrompt[]) : [];
  }

  const res = await authFetch("/api/mcp/prompts/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message = body?.error || `List prompts failed (${res.status})`;
    throw new Error(message);
  }

  return Array.isArray(body?.prompts) ? (body.prompts as MCPPrompt[]) : [];
}

export async function getPrompt(
  serverId: string,
  name: string,
  args?: Record<string, string>,
): Promise<PromptContentResponse> {
  if (HOSTED_MODE) {
    return (await getHostedPrompt({
      serverNameOrId: serverId,
      promptName: name,
      arguments: args,
    })) as PromptContentResponse;
  }

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
}

export async function listPromptsForServers(
  serverIds: string[],
): Promise<BatchPromptsResponse> {
  if (HOSTED_MODE) {
    const body = await listHostedPromptsMulti({ serverNamesOrIds: serverIds });
    const remappedPrompts: Record<string, MCPPrompt[]> = {};
    const remappedErrors: Record<string, string> = {};
    const reverseMap = Object.fromEntries(
      serverIds.map((serverName) => [resolveHostedServerId(serverName), serverName]),
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
      errors: Object.keys(remappedErrors).length > 0 ? remappedErrors : undefined,
    };
  }

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
    const message = body?.error || `Batch list prompts failed (${res.status})`;
    throw new Error(message);
  }

  return {
    prompts: (body?.prompts ?? {}) as Record<string, MCPPrompt[]>,
    errors: body?.errors as Record<string, string> | undefined,
  };
}
