import type { MCPPrompt } from "@/shared/types";

export interface ListPromptsResponse {
  prompts: MCPPrompt[];
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: {
    type: "text";
    text: string;
  };
}

export interface PromptContentResponse {
  description?: string;
  messages: PromptMessage[];
}

interface PromptContentResponseBody {
  content: PromptContentResponse;
}

export interface PromptsServerMap {
  [serverId: string]: MCPPrompt[];
}

const parseOrThrow = async (res: Response) => {
  try {
    return await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse response: ${message}`);
  }
};

export async function listPrompts(
  serverId: string,
): Promise<ListPromptsResponse> {
  const res = await fetch("/api/mcp/prompts/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId }),
  });

  let body = await parseOrThrow(res);

  if (!res.ok) {
    const error = (body as { error?: string }).error;
    const message = error || `List prompts failed (${res.status})`;
    throw new Error(message);
  }

  // Minimal runtime check
  if (!body || typeof body !== "object" || !Array.isArray(body.prompts)) {
    throw new Error("Invalid list prompts response shape");
  }

  return body as ListPromptsResponse;
}

export async function getPromptContent(
  serverId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<PromptContentResponse> {
  const res = await fetch("/api/mcp/prompts/get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, name, args }),
  });

  let body = await parseOrThrow(res);

  if (!res.ok) {
    const error = (body as { error?: string }).error;
    const message = error || `Get prompt failed (${res.status})`;
    throw new Error(message);
  }

  // Minimal runtime check
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as any).content.messages)
  ) {
    console.error("Invalid get prompt response shape", body);
    throw new Error("Invalid get prompt response shape");
  }

  const result = (body as PromptContentResponseBody).content;
  return result;
}

export const getPromptsByServerIds = async (
  serverIds: string[],
): Promise<PromptsServerMap> => {
  const promptsByServerId: Record<string, MCPPrompt[]> = {};
  await Promise.all(
    serverIds.map(async (serverId) => {
      const prompts = await listPrompts(serverId);
      promptsByServerId[serverId] = prompts.prompts;
    }),
  );
  return promptsByServerId;
};
