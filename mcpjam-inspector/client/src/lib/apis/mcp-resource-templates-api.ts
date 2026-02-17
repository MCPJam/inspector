import type { MCPResourceTemplate } from "@mcpjam/sdk";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";

export async function listResourceTemplates(
  serverId: string,
): Promise<MCPResourceTemplate[]> {
  if (HOSTED_MODE) {
    throw new Error("Resource templates are not supported in hosted mode");
  }

  const res = await authFetch("/api/mcp/resource-templates/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message =
      body?.error || `List resource templates failed (${res.status})`;
    throw new Error(message);
  }

  return Array.isArray(body?.resourceTemplates)
    ? (body.resourceTemplates as MCPResourceTemplate[])
    : [];
}
