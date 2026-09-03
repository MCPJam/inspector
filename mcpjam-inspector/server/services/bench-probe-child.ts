/**
 * The hosted auth-probe child of a Connector Bench run.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE BENCHMARK PROBES AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * v1's auth evidence was a receipt the CLIENT filed: `client_reported`. That
 * is fine for a self-service report and useless for a badge — nobody outside
 * MCPJam has any reason to believe a number a submitter computed about their
 * own server. A scorecard can only claim `mcpjam_verified` for evidence MCPJam
 * OBSERVED, and this is the observation: one bounded, unauthenticated request
 * from our infrastructure, asking what a stranger sees.
 *
 * The dialing is `probeThroughEgressGuard` — the SAME wiring the connection
 * discovery preflight uses, not a second one written here. Its DNS pinning,
 * per-hop redirect revalidation and refusal ordering are the reason a
 * user-supplied URL can be dialed at all, and a second copy would drift with
 * only one of them fixed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A PROBE THAT DID NOT RUN IS NOT A CLEAN PROBE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The one failure mode this module exists to prevent: reporting an egress
 * refusal, a DNS blip or a deadline as a COMPLETED probe with zero checks. A
 * completed probe with nothing in it looks, to every downstream reader, like a
 * server that had nothing wrong with it — and the backend would stamp the
 * roster row verified on the strength of it. So a probe that could not run
 * reports `failed` or `refused` with a reason and NO checks, and the backend
 * records the row as unavailable instead.
 *
 * `nonCompliantChallengeStatus` is a NUMBER rather than a flag for the same
 * reason: a 403, a 200 and a 500 in place of the 401 the spec requires have
 * three different remediations, and a boolean would say only that one of them
 * happened.
 */

import { probeThroughEgressGuard } from "./server-connection-discovery.js";
import type {
  GuardedProbeResult,
  RunDiscoveryPreflightDependencies,
} from "./server-connection-discovery.js";
import type { ProbeMcpServerResult } from "@mcpjam/sdk";

/** Ids are pinned evidence: renaming one re-keys a scorecard's history. */
export const BENCHMARK_PROBE_CHECK_IDS = {
  unauthenticatedChallenge: "auth_probe_unauthenticated_challenge",
  challengeAdvertisesResourceMetadata:
    "auth_probe_challenge_advertises_resource_metadata",
  resourceMetadataDiscoverable: "auth_probe_resource_metadata_discoverable",
  authorizationServerAdvertised: "auth_probe_authorization_server_advertised",
} as const;

export type BenchmarkProbeCheckOutcome =
  | "passed"
  | "failed"
  | "not_applicable"
  | "could_not_run";

export type BenchmarkProbeCheck = {
  id: string;
  outcome: BenchmarkProbeCheckOutcome;
  /**
   * A violation that is a security property of the target rather than a
   * conformance nit. The scorer's `securityCriticalFailure` gate reads this.
   */
  securityCritical?: boolean;
  detail?: string;
};

/**
 * The probe-evidence payload, HAND-MIRRORED from the backend's probe route.
 * The two repos share no types, so this shape IS the contract.
 */
export type BenchmarkProbeEvidence = {
  /** What was actually dialed, so a reader can tell which endpoint was graded. */
  observedEndpoint: string;
  discovery: {
    resourceMetadataFound: boolean;
    resourceMetadataUrl?: string;
    authorizationServers?: string[];
    scopesSupported?: string[];
    resource?: string;
  };
  /**
   * The status an UNAUTHENTICATED request came back on when it was not the 401
   * the spec requires. Absent for a compliant challenge — and absent is NOT
   * the same as zero.
   */
  nonCompliantChallengeStatus?: number;
  registrationStrategies?: string[];
  checks: BenchmarkProbeCheck[];
  status: "completed" | "failed" | "refused";
  failureReason?: string;
};

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return entries.length > 0 ? entries : undefined;
}

/**
 * Does the challenge name an ABSOLUTE resource metadata URL?
 *
 * RFC 9728 §5.1 requires it absolute; a relative value breaks discovery for
 * every client that did not guess the base. The probe already parsed the
 * challenge, so this reads its result rather than the header again — except
 * for absoluteness, which only the raw value can answer.
 */
function challengeAdvertisesAbsoluteResourceMetadata(
  oauth: ProbeMcpServerResult["oauth"],
): boolean | undefined {
  const header = oauth.wwwAuthenticate;
  if (header === undefined || header.trim() === "") return undefined;
  const match = /resource_metadata\s*=\s*"([^"]*)"/i.exec(header);
  if (!match) return false;
  try {
    const url = new URL(match[1] ?? "");
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Turn one completed probe into graded checks.
 *
 * Pure and exported, because every arm here is a claim a scorecard will carry:
 * a `not_applicable` leaves the denominator entirely, and `could_not_run`
 * stays in it as an unearned point. An authless server has no authorization
 * obligations to violate (authorization is OPTIONAL in every MCP revision), so
 * its auth checks are genuinely inapplicable — that is the ONE place this
 * module is allowed to say so.
 */
export function gradeProbeChecks(
  probe: ProbeMcpServerResult,
): BenchmarkProbeCheck[] {
  const ids = BENCHMARK_PROBE_CHECK_IDS;

  if (probe.status === "ready") {
    const detail =
      "The server completed MCP initialize without credentials, and authorization is OPTIONAL.";
    return Object.values(ids).map((id) => ({
      id,
      outcome: "not_applicable" as const,
      detail,
    }));
  }

  if (probe.status !== "oauth_required") {
    // `reachable` (answered, not MCP) and `error` (never answered) both leave
    // every obligation untested rather than satisfied.
    const detail =
      probe.error ??
      "The server did not produce a usable MCP response, so no authorization obligation could be exercised.";
    return Object.values(ids).map((id) => ({
      id,
      outcome: "could_not_run" as const,
      detail,
    }));
  }

  const { oauth } = probe;
  const checks: BenchmarkProbeCheck[] = [];

  const nonCompliant = oauth.nonCompliantChallengeStatus;
  checks.push(
    nonCompliant === undefined
      ? {
          id: ids.unauthenticatedChallenge,
          outcome: "passed",
          securityCritical: true,
        }
      : {
          id: ids.unauthenticatedChallenge,
          outcome: "failed",
          securityCritical: true,
          detail: `An unauthenticated request was answered with HTTP ${nonCompliant}; RFC 6750 §3 requires 401 with a Bearer challenge.`,
        },
  );

  const advertises = challengeAdvertisesAbsoluteResourceMetadata(oauth);
  checks.push(
    advertises === undefined
      ? {
          id: ids.challengeAdvertisesResourceMetadata,
          outcome: "could_not_run",
          detail:
            "The challenge carried no WWW-Authenticate header to read a resource_metadata parameter from.",
        }
      : {
          id: ids.challengeAdvertisesResourceMetadata,
          outcome: advertises ? "passed" : "failed",
          ...(advertises
            ? {}
            : {
                detail:
                  "RFC 9728 §5.1 requires the Bearer challenge to carry an absolute resource_metadata URL.",
              }),
        },
  );

  const metadataFound = oauth.resourceMetadata !== undefined;
  checks.push({
    id: ids.resourceMetadataDiscoverable,
    outcome: metadataFound ? "passed" : "failed",
    ...(metadataFound
      ? {}
      : {
          detail:
            oauth.discoveryError ??
            "No RFC 9728 protected-resource metadata document could be fetched.",
        }),
  });

  const authorizationServers = stringList(
    (oauth.resourceMetadata as Record<string, unknown> | undefined)
      ?.authorization_servers,
  );
  checks.push(
    !metadataFound
      ? {
          id: ids.authorizationServerAdvertised,
          outcome: "could_not_run",
          detail:
            "Without protected-resource metadata there is no document to name an authorization server in.",
        }
      : {
          id: ids.authorizationServerAdvertised,
          outcome: authorizationServers ? "passed" : "failed",
          ...(authorizationServers
            ? {}
            : {
                detail:
                  "The protected-resource metadata named no authorization_servers, so no client can start a flow.",
              }),
        },
  );

  return checks;
}

/**
 * Build the evidence payload for one guarded probe result.
 *
 * Exported alongside the runner so the mapping — and specifically the two
 * non-completed arms — can be pinned without dialing anything.
 */
export function buildProbeEvidence(
  observedEndpoint: string,
  guarded: GuardedProbeResult,
): BenchmarkProbeEvidence {
  if (guarded.kind !== "probed") {
    // NO CHECKS, and a non-completed status. The backend records the roster
    // row as unavailable and refuses to stamp it verified; a `completed` here
    // would present "we never reached it" as "we found nothing wrong".
    return {
      observedEndpoint,
      discovery: { resourceMetadataFound: false },
      checks: [],
      status: guarded.kind === "refused" ? "refused" : "failed",
      failureReason: guarded.detail,
    };
  }

  const { oauth } = guarded.probe;
  const resourceMetadata = oauth.resourceMetadata as
    | Record<string, unknown>
    | undefined;
  const resource = resourceMetadata?.resource;

  return {
    observedEndpoint,
    discovery: {
      resourceMetadataFound: resourceMetadata !== undefined,
      ...(oauth.resourceMetadataUrl
        ? { resourceMetadataUrl: oauth.resourceMetadataUrl }
        : {}),
      ...(stringList(resourceMetadata?.authorization_servers)
        ? {
            authorizationServers: stringList(
              resourceMetadata?.authorization_servers,
            )!,
          }
        : {}),
      ...(stringList(resourceMetadata?.scopes_supported)
        ? { scopesSupported: stringList(resourceMetadata?.scopes_supported)! }
        : {}),
      ...(typeof resource === "string" ? { resource } : {}),
    },
    ...(typeof oauth.nonCompliantChallengeStatus === "number"
      ? { nonCompliantChallengeStatus: oauth.nonCompliantChallengeStatus }
      : {}),
    ...(oauth.registrationStrategies.length > 0
      ? { registrationStrategies: [...oauth.registrationStrategies] }
      : {}),
    checks: gradeProbeChecks(guarded.probe),
    status: "completed",
  };
}

export type RunBenchmarkAuthProbeArgs = {
  serverUrl: string;
  /**
   * Local-dev opt-in, loopback ONLY. A hosted benchmark never sets it: a
   * scorecard about a server nobody else can reach is not evidence.
   */
  allowLoopback?: boolean;
  timeoutMs?: number;
};

/** Run the probe child and return what the backend should record. */
export async function runBenchmarkAuthProbe(
  args: RunBenchmarkAuthProbeArgs,
  dependencies: RunDiscoveryPreflightDependencies = {},
): Promise<BenchmarkProbeEvidence> {
  const guarded = await probeThroughEgressGuard(
    {
      serverUrl: args.serverUrl,
      ...(args.allowLoopback ? { allowLoopback: true } : {}),
      // Explicitly strict whatever the deployment: the preflight's local
      // default permits private targets, and a scorecard about a server
      // nobody else can reach is still not evidence.
      allowPrivateNetwork: args.allowLoopback === true,
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    },
    dependencies,
  );
  return buildProbeEvidence(args.serverUrl, guarded);
}
