import type { UIMessage } from "ai";
import { authFetch } from "@/lib/session-token";

interface SerializedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface XRayPayloadResponse {
  system: string;
  tools: Record<string, SerializedTool>;
  messages: unknown[];
}

export interface XRayPayloadRequest {
  messages: UIMessage[];
  systemPrompt?: string;
  selectedServers?: string[];
}

export async function getXRayPayload(
  request: XRayPayloadRequest,
): Promise<XRayPayloadResponse> {
  const res = await authFetch("/api/mcp/xray-payload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message =
      body?.error || `Failed to get X-Ray payload (${res.status})`;
    throw new Error(message);
  }

  if (
    body === null ||
    typeof body !== "object" ||
    typeof body.system !== "string" ||
    typeof body.tools !== "object" ||
    !Array.isArray(body.messages)
  ) {
    throw new Error("Failed to parse X-Ray payload");
  }

  return body as XRayPayloadResponse;
}
