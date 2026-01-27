import type { MCPPrompt } from "@mcpjam/sdk";
import { authFetch } from "@/lib/session-token";

export interface PromptContentResponse {
  content: any;
}

export interface BatchPromptsResponse {
  prompts: Record<string, MCPPrompt[]>;
  errors?: Record<string, string>;
}

export async function listPrompts(serverId: string): Promise<MCPPrompt[]> {
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
