import { authFetch } from "@/lib/session-token";
import {
  listHostedResources,
  readHostedResource,
} from "@/lib/apis/web/resources-api";
import { runByMode } from "@/lib/apis/mode-client";

/** SEP-2549 cache-serve provenance (§11.2) — present ONLY on an actual hit. */
export type ServedFromCache = { ageMs: number };

export type ListResourcesResult = {
  resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
  }>;
  nextCursor?: string;
  servedFromCache?: ServedFromCache;
};

export async function listResources(
  serverId: string,
  cursor?: string,
  opts?: { forceHosted?: boolean; refresh?: boolean },
): Promise<ListResourcesResult> {
  return runByMode({
    forceHosted: opts?.forceHosted,
    hosted: async () => {
      const body = await listHostedResources({
        serverNameOrId: serverId,
        cursor,
      });
      // Hosted direct-ops always bypass the response cache server-side.
      return {
        resources: body.resources || [],
        nextCursor: body.nextCursor,
      };
    },
    local: async () => {
      const res = await authFetch("/api/mcp/resources/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, cursor, refresh: opts?.refresh }),
      });

      let body: any = null;
      try {
        body = await res.json();
      } catch {}

      if (!res.ok) {
        throw new Error(body?.error || `List resources failed (${res.status})`);
      }

      return {
        resources: body.resources || [],
        nextCursor: body.nextCursor,
        servedFromCache: body.servedFromCache,
      };
    },
  });
}

export async function readResource(
  serverId: string,
  uri: string,
  opts?: { forceHosted?: boolean; refresh?: boolean },
) {
  return runByMode({
    forceHosted: opts?.forceHosted,
    hosted: async () => readHostedResource({ serverNameOrId: serverId, uri }),
    local: async () => {
      const response = await authFetch(`/api/mcp/resources/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, uri, refresh: opts?.refresh }),
      });
      return response.json();
    },
  });
}
