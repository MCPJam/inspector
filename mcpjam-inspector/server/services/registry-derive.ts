/**
 * Derive an org-registry entry from a pasted URL.
 *
 * The paste-a-link door into an organization's own registry: a member types an
 * address, and everything the entry needs — display name, version, whether it
 * wants OAuth, whether it can register a client dynamically — is read off the
 * live server rather than typed. Typing those by hand is how a shelf fills up
 * with entries that disagree with the servers they point at.
 *
 * TWO THINGS THIS MODULE DELIBERATELY DOES NOT DO.
 *
 * It does not dial anything itself. Every socket goes through
 * `probeThroughEgressGuard`, the same guarded probe the connection-request
 * preflight uses, so the SSRF ordering (pinned DNS, revalidated redirects, a
 * refusal that OUTRANKS the probe's own "just an error") is written once. A
 * second module that dialed a user-supplied URL is exactly what that module's
 * header rules out.
 *
 * And it does not decide who may ask. The route does that first, against the
 * backend, before this is ever called — an unauthenticated derive endpoint is
 * an SSRF oracle with a nice JSON envelope, however well guarded the socket is.
 */
import type { ProbeMcpServerResult } from "@mcpjam/sdk";
import {
  DISCOVERY_TIMEOUT_MS,
  probeThroughEgressGuard,
  type RunDiscoveryPreflightDependencies,
} from "./server-connection-discovery.js";

/** What the add dialog prefills itself from. */
export interface DerivedServerFacts {
  /**
   * `ready` — initialize succeeded with no credential; the entry is open.
   * `oauth_required` — the server challenged; the entry is an OAuth entry.
   *
   * Those are the only two an entry can be created from. A server that
   * answered but is not MCP, and one that did not answer at all, are refusals
   * rather than facts.
   */
  status: "ready" | "oauth_required";
  serverName?: string;
  serverVersion?: string;
  title?: string;
  authRequired: boolean;
  registrationStrategies: Array<"preregistered" | "dcr" | "cimd">;
  /** The URL the probe actually talked to. */
  endpointUrl: string;
}

export type DeriveOutcome =
  | { kind: "derived"; facts: DerivedServerFacts }
  /**
   * The egress guard said no. NEVER RETRIED and never explained in detail: the
   * guard's own message names the reason it refused, and echoing it back to
   * whoever supplied the URL turns a refusal into a network-mapping oracle.
   * One generic sentence, and the request is over.
   */
  | { kind: "refused" }
  /** Nobody learned anything — DNS, TLS, a stall. Trying again is reasonable. */
  | { kind: "unreachable"; detail: string }
  /** The host answered and what it said was not MCP. Retrying cannot fix it. */
  | { kind: "not-mcp"; detail: string };

/** The copy a refusal shows. Says what happened; names nothing. */
export const EGRESS_REFUSAL_MESSAGE =
  "That address can't be reached from MCPJam. Organization registry entries must point at a server on the public internet, over HTTPS.";

/**
 * `serverInfo` is `unknown` on the probe result — it is whatever the target
 * put in its initialize response, which is to say arbitrary JSON from a
 * stranger. Read the three fields we want and ignore the rest; a non-string
 * `name` is absent, not a crash and not an object rendered as "[object
 * Object]" in somebody's registry.
 */
function readServerInfo(serverInfo: unknown): {
  name?: string;
  version?: string;
  title?: string;
} {
  if (!serverInfo || typeof serverInfo !== "object") return {};
  const info = serverInfo as Record<string, unknown>;
  const str = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    // Bounded because these land in a shelf entry every member of the org
    // sees; a server that returns a novel for its name does not get to set
    // the card's height.
    return trimmed ? trimmed.slice(0, 200) : undefined;
  };
  return {
    name: str(info.name),
    version: str(info.version),
    title: str(info.title),
  };
}

function factsFromProbe(probe: ProbeMcpServerResult): DeriveOutcome {
  switch (probe.status) {
    case "ready":
    case "oauth_required": {
      const info = readServerInfo(probe.initialize?.serverInfo);
      return {
        kind: "derived",
        facts: {
          status: probe.status,
          serverName: info.name,
          serverVersion: info.version,
          title: info.title,
          authRequired: probe.oauth.required,
          registrationStrategies: probe.oauth.registrationStrategies,
          endpointUrl: probe.url,
        },
      };
    }
    case "reachable":
      return {
        kind: "not-mcp",
        detail:
          probe.error ??
          "That address answered, but it is not an MCP server (no initialize handshake).",
      };
    case "error":
      return {
        kind: "unreachable",
        detail: probe.error ?? "Could not reach that server.",
      };
  }
}

export async function deriveRegistryEntry(
  input: { url: string; allowLoopback?: boolean; timeoutMs?: number },
  dependencies: RunDiscoveryPreflightDependencies = {}
): Promise<DeriveOutcome> {
  const guarded = await probeThroughEgressGuard(
    {
      serverUrl: input.url,
      allowLoopback: input.allowLoopback,
      timeoutMs: input.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
    },
    dependencies
  );

  switch (guarded.kind) {
    case "refused":
      return { kind: "refused" };
    case "unreachable":
      return { kind: "unreachable", detail: guarded.detail };
    case "probed":
      return factsFromProbe(guarded.probe);
  }
}
