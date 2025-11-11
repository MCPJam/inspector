/**
 * API helper for counting tokens in MCP server tools
 */

export async function countMCPToolsTokens(
  selectedServers: string[],
  modelId: string,
): Promise<Record<string, number>> {
  const res = await fetch("/api/mcp/tokenizer/count-tools", {
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
