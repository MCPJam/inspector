import { authFetch } from "@/lib/session-token";
import {
  listHostedResources,
  readHostedResource,
} from "@/lib/apis/web/resources-api";
import { runByMode } from "@/lib/apis/mode-client";

export type ListResourcesResult = {
  resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
  }>;
  nextCursor?: string;
};

export async function listResources(
  serverId: string,
  cursor?: string,
): Promise<ListResourcesResult> {
  return runByMode({
    hosted: async () => {
      const body = await listHostedResources({
        serverNameOrId: serverId,
        cursor,
      });
      return {
        resources: body.resources || [],
        nextCursor: body.nextCursor,
      };
    },
    local: async () => {
      const res = await authFetch("/api/mcp/resources/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, cursor }),
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
      };
    },
  });
}

export async function readResource(serverId: string, uri: string) {
  return runByMode({
    hosted: async () => readHostedResource({ serverNameOrId: serverId, uri }),
    local: async () => {
      const response = await authFetch(`/api/mcp/resources/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, uri }),
      });
      return response.json();
    },
  });
}
