import { authFetch } from "@/lib/session-token";
import {
  listHostedResources,
  readHostedResource,
} from "@/lib/apis/web/resources-api";
import { runByMode } from "@/lib/apis/mode-client";
import { WebApiError } from "@/lib/apis/web/base";
import {
  McpRequestError,
  parseInsufficientScopeChallenge,
} from "@/lib/apis/insufficient-scope";

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
    hosted: async () => {
      try {
        return await readHostedResource({ serverNameOrId: serverId, uri });
      } catch (error) {
        // SEP-2350: rethrow as an McpRequestError carrying the challenge the
        // hosted 403 forwarded on `details.insufficientScope`, so the consumer
        // catch can drive the union-scope step-up.
        const insufficientScope =
          error instanceof WebApiError
            ? parseInsufficientScopeChallenge(
                (error.details as any)?.insufficientScope,
              )
            : undefined;
        const message = error instanceof Error ? error.message : String(error);
        throw new McpRequestError(message, {
          insufficientScope,
          status: error instanceof WebApiError ? error.status : undefined,
        });
      }
    },
    local: async () => {
      const response = await authFetch(`/api/mcp/resources/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, uri, refresh: opts?.refresh }),
      });
      let body: any = null;
      try {
        body = await response.json();
      } catch {}
      if (!response.ok) {
        // SEP-2350: the /resources/read route serializes a 403 challenge onto
        // `mcpError.insufficientScope` (via jsonError). Surface it so the
        // consumer can step up. Previously this path returned the error body
        // as if it were a successful read.
        const message =
          body?.error || `Error reading resource (${response.status})`;
        throw new McpRequestError(message, {
          insufficientScope: parseInsufficientScopeChallenge(
            body?.mcpError?.insufficientScope,
          ),
          status: response.status,
        });
      }
      return body;
    },
  });
}
