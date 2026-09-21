/**
 * The pre-run disclosure read for an eval suite launch plan (G4b).
 *
 * Same shape as `directory-readiness-api.ts`: `PlatformApiClient` already
 * speaks this endpoint with typed parameters and URL encoding, so this wraps
 * it rather than hand-rolling a second `fetch`. The transport is wrapped for
 * the same reason too — the client would otherwise set its own
 * `Authorization` header, which makes `authFetch` treat the caller as owning
 * its own auth and skip both its header AND its 401 refresh-and-retry. See
 * that module's header for the full reasoning.
 */
import { PlatformApiClient } from "@mcpjam/sdk/platform";
import type { PlatformEvalRunDisclosure } from "@mcpjam/sdk/platform";
import { authFetch } from "@/lib/session-token";

const disclosureFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  return authFetch(input as Parameters<typeof authFetch>[0], {
    ...init,
    headers,
  });
};

function client(): PlatformApiClient {
  return new PlatformApiClient({
    baseUrl: "/api/v1",
    // Empty on purpose — `disclosureFetch` strips it and `authFetch` supplies
    // the real one, so the bearer has exactly one owner.
    getAuth: () => "",
    fetch: disclosureFetch,
  });
}

export async function fetchRunDisclosure(
  params: {
    projectId: string;
    suiteId: string;
    caseIds?: readonly string[];
    environmentId?: string;
    environmentIds?: readonly string[];
    /** Host-axis launch plan (G4c) — mutually exclusive with the environment selectors. */
    namedHostId?: string;
  },
  signal?: AbortSignal,
): Promise<PlatformEvalRunDisclosure> {
  return client().getEvalRunDisclosure(
    {
      projectId: params.projectId,
      suiteId: params.suiteId,
      ...(params.caseIds?.length ? { caseIds: [...params.caseIds] } : {}),
      ...(params.environmentId ? { environmentId: params.environmentId } : {}),
      ...(params.environmentIds?.length
        ? { environmentIds: [...params.environmentIds] }
        : {}),
      ...(params.namedHostId ? { namedHostId: params.namedHostId } : {}),
    },
    { signal },
  );
}
