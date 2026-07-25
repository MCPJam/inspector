import type { MCPResourceTemplate } from "@mcpjam/sdk/browser";
import { authFetch } from "@/lib/session-token";
import { ensureLocalMode } from "@/lib/apis/mode-client";

export async function listResourceTemplates(
  serverId: string,
  opts?: { cursor?: string },
): Promise<MCPResourceTemplate[]> {
  const { resourceTemplates } = await listResourceTemplatesPage(
    serverId,
    opts,
  );
  return resourceTemplates;
}

// Cursor-aware variant of `listResourceTemplates`, additive alongside it:
// omitting `cursor` still returns the full aggregate (unchanged default
// behavior); passing one returns exactly one raw page plus `nextCursor` when
// the server has more. This is the plumbing a future paginated Resource
// Templates UI would call.
export async function listResourceTemplatesPage(
  serverId: string,
  opts?: { cursor?: string },
): Promise<{ resourceTemplates: MCPResourceTemplate[]; nextCursor?: string }> {
  ensureLocalMode("Resource templates are not supported in hosted mode");

  const res = await authFetch("/api/mcp/resource-templates/list", {
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
    const message =
      body?.error || `List resource templates failed (${res.status})`;
    throw new Error(message);
  }

  return {
    resourceTemplates: Array.isArray(body?.resourceTemplates)
      ? (body.resourceTemplates as MCPResourceTemplate[])
      : [],
    ...(typeof body?.nextCursor === "string"
      ? { nextCursor: body.nextCursor }
      : {}),
  };
}
