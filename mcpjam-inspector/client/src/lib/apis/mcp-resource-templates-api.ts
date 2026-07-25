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
  opts?: { cursor?: string; refresh?: boolean },
): Promise<ResourceTemplateListWithProvenance> {
  const { resourceTemplates, servedFromCache } =
    await listResourceTemplatesPage(serverId, opts);
  const withProvenance =
    resourceTemplates as ResourceTemplateListWithProvenance;
  if (servedFromCache) {
    // Non-enumerable so object-spread / for-in over the bare array stay
    // unchanged; provenance is still accessible as `.servedFromCache`.
    Object.defineProperty(withProvenance, "servedFromCache", {
      value: servedFromCache,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return withProvenance;
}

// Cursor-aware variant of `listResourceTemplates`, additive alongside it:
// omitting `cursor` still returns the full aggregate (unchanged default
// behavior); passing one returns exactly one raw page plus `nextCursor` when
// the server has more. This is the plumbing a future paginated Resource
// Templates UI would call.
export async function listResourceTemplatesPage(
  serverId: string,
  opts?: { cursor?: string; refresh?: boolean },
): Promise<{
  resourceTemplates: MCPResourceTemplate[];
  nextCursor?: string;
  servedFromCache?: ServedFromCache;
}> {
  ensureLocalMode("Resource templates are not supported in hosted mode");

  const res = await authFetch("/api/mcp/resource-templates/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serverId,
      ...(opts?.cursor ? { cursor: opts.cursor } : {}),
      ...(opts?.refresh === true ? { refresh: true } : {}),
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
    ...(body?.servedFromCache
      ? { servedFromCache: body.servedFromCache as ServedFromCache }
      : {}),
  };
}
