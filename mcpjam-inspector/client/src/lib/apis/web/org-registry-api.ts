import { webPost } from "./base";

/**
 * Typed wrapper for `POST /api/web/registry/derive` — the paste-a-link half of
 * the organization registry.
 *
 * The Inspector server probes; the browser never dials the pasted address
 * itself. That is not only an SSRF question (a browser cannot reach a private
 * network on our behalf anyway) — the probe needs an MCP initialize handshake
 * and redirect-revalidating egress, neither of which belongs in a tab.
 */
export interface DerivedServerFacts {
  /** `ready` — open server. `oauth_required` — it challenged. */
  status: "ready" | "oauth_required";
  serverName?: string;
  serverVersion?: string;
  title?: string;
  authRequired: boolean;
  registrationStrategies: Array<"preregistered" | "dcr" | "cimd">;
  /** The URL the probe actually reached — after redirects. */
  endpointUrl: string;
}

export async function deriveOrgRegistryServer(input: {
  url: string;
  projectId: string;
}): Promise<DerivedServerFacts> {
  return await webPost<typeof input, DerivedServerFacts>(
    "/api/web/registry/derive",
    input
  );
}

/**
 * The `derived` snapshot the Convex mutations store.
 *
 * Built here rather than server-side because PROMOTE produces one without any
 * probe at all — the facts are already in the browser, on
 * `initializationInfo`. One shape, two sources, so a promoted entry and a
 * pasted one are the same kind of row.
 */
export interface OrgRegistryDerivedSnapshot {
  probedAt: number;
  endpointUrl: string;
  serverName?: string;
  serverVersion?: string;
  authRequired?: boolean;
  supportsDcr?: boolean;
  supportsCimd?: boolean;
}

export function snapshotFromDerivedFacts(
  facts: DerivedServerFacts,
  now: number = Date.now()
): OrgRegistryDerivedSnapshot {
  return {
    probedAt: now,
    endpointUrl: facts.endpointUrl,
    serverName: facts.serverName,
    serverVersion: facts.serverVersion,
    authRequired: facts.authRequired,
    supportsDcr: facts.registrationStrategies.includes("dcr"),
    supportsCimd: facts.registrationStrategies.includes("cimd"),
  };
}
