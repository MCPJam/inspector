import type { MCPResourceTemplate } from "@mcpjam/sdk/browser";
import { authFetch } from "@/lib/session-token";
import { ensureLocalMode } from "@/lib/apis/mode-client";

/** SEP-2549 cache-serve provenance (§11.2) — present ONLY on an actual hit. */
export type ServedFromCache = { ageMs: number };

/** Bare-array return with provenance attached — see `mcp-prompts-api.ts`. */
export type ResourceTemplateListWithProvenance = MCPResourceTemplate[] & {
  servedFromCache?: ServedFromCache;
};

export async function listResourceTemplates(
  serverId: string,
  opts?: { refresh?: boolean },
): Promise<ResourceTemplateListWithProvenance> {
  ensureLocalMode("Resource templates are not supported in hosted mode");

  const res = await authFetch("/api/mcp/resource-templates/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, refresh: opts?.refresh }),
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

  const templates = (
    Array.isArray(body?.resourceTemplates)
      ? (body.resourceTemplates as MCPResourceTemplate[])
      : []
  ) as ResourceTemplateListWithProvenance;
  if (body?.servedFromCache) {
    templates.servedFromCache = body.servedFromCache;
  }
  return templates;
}
