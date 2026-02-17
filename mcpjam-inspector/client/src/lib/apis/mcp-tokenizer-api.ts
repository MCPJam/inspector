/**
 * API helper for counting tokens in MCP server tools
 */

import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";

export async function countMCPToolsTokens(
  selectedServers: string[],
  modelId: string,
): Promise<Record<string, number>> {
  if (HOSTED_MODE) {
    void selectedServers;
    void modelId;
    return {};
  }

  const res = await authFetch("/api/mcp/tokenizer/count-tools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selectedServers, modelId }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message = body?.error || `Count tokens failed (${res.status})`;
    throw new Error(message);
  }

  if (!body.ok) {
    throw new Error(body.error || "Failed to count tokens");
  }

  return body.tokenCounts ?? {};
}

/**
 * API helper for counting tokens in arbitrary text
 */
export async function countTextTokens(
  text: string,
  modelId: string,
): Promise<number> {
  if (HOSTED_MODE) {
    void text;
    void modelId;
    return 0;
  }

  const res = await authFetch("/api/mcp/tokenizer/count-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, modelId }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message = body?.error || `Count tokens failed (${res.status})`;
    throw new Error(message);
  }

  if (!body.ok) {
    throw new Error(body.error || "Failed to count tokens");
  }

  return body.tokenCount ?? 0;
}
