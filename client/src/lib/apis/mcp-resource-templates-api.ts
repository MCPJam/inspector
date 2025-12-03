import type { MCPResourceTemplate } from "@/sdk";

export async function listResourceTemplates(
  serverId: string,
): Promise<MCPResourceTemplate[]> {
  const res = await fetch("/api/mcp/resource-templates/list", {
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
