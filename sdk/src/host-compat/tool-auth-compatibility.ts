import type { HostCompatCatalog } from "./catalog.js";
import type { HostCompatTool } from "./server-requirements.js";
import { weakestProvenance } from "./evaluator.js";
import type {
  CompatFinding,
  CompatLane,
  CompatLaneVerdict,
  CompatProvenance,
} from "./types.js";
import {
  AUTH_CHALLENGE_POLICY_DEFAULTS,
  authChallengePolicyFrom,
  hasOAuth2Scheme,
  resolveToolSecuritySchemes,
} from "../mcp-client-manager/auth-challenge.js";

/**
 * Hosts that would show a tool-result sign-in challenge as an ordinary error,
 * for a server whose tools rely on one.
 *
 * WHAT "RELIES ON ONE" MEANS HERE. A tool whose `securitySchemes` (top level,
 * then `_meta.securitySchemes`) include `oauth2` is declaring the pattern in
 * which a protected call answers with an `isError` result carrying
 * `_meta["mcp/www_authenticate"]`. That is one host's contract, not the MCP
 * spec's, and a host whose resolved `toolResultAuthChallenge` is `passthrough`
 * — the default when its profile says nothing — shows that result as a plain
 * failure and never starts sign-in.
 *
 * `info`, and appended without moving the verdict: the declaration says what
 * the server INTENDS, not what it sends. A server may also refuse the same
 * call with an HTTP 401, which every host acts on, and only a driven call
 * could tell the two apart. A host whose profile states nothing gets
 * `assumed` provenance, because the `passthrough` it is graded on is a
 * default rather than a recorded fact about that host.
 *
 * Exported for direct testing against a synthetic catalog.
 */
export function toolResultAuthChallengeFindings(
  tools: readonly HostCompatTool[],
  host: {
    hostLabel: string;
    provenance: CompatProvenance;
    mcpProfile?: unknown;
  }
): CompatFinding[] {
  const declared = authChallengePolicyFrom(host.mcpProfile);
  const action =
    declared?.toolResultAuthChallenge ??
    AUTH_CHALLENGE_POLICY_DEFAULTS.toolResultAuthChallenge;
  if (action !== "passthrough") return [];

  const relying = tools
    .filter((tool) =>
      hasOAuth2Scheme(
        resolveToolSecuritySchemes({
          declaration: {
            securitySchemes: tool.securitySchemes,
            _meta: tool._meta,
          },
        })
      )
    )
    .map((tool) => tool.name)
    .sort();
  if (relying.length === 0) return [];

  return [
    {
      lane: "server",
      severity: "info",
      code: "tool_result_auth_challenge_ignored",
      title: "Sign-in challenges in tool results are shown as errors",
      detail: `${host.hostLabel} shows a tool result carrying _meta["mcp/www_authenticate"] as an ordinary error and does not start sign-in from it. These tools declare an oauth2 security scheme, the pattern that asks for sign-in that way: ${relying.join(
        ", "
      )}.`,
      remediation:
        'To ask for sign-in in the way the MCP spec defines, refuse the unauthenticated call with HTTP 401 and a `WWW-Authenticate: Bearer resource_metadata="…"` header; hosts that read the _meta challenge can be served it alongside.',
      tools: relying,
      provenance:
        declared?.toolResultAuthChallenge !== undefined
          ? host.provenance
          : "assumed",
    },
  ];
}

/** Append the tool-result sign-in finding to every host it applies to. */
export function withToolResultAuthChallengeFindings<
  Report extends {
    hostId: string;
    hostLabel: string;
    provenance: CompatProvenance;
    findings: CompatFinding[];
    lanes?: Record<CompatLane, CompatLaneVerdict>;
  },
>(
  reports: readonly Report[],
  tools: readonly HostCompatTool[],
  catalog: HostCompatCatalog
): Report[] {
  return reports.map((report) => {
    const host = Object.hasOwn(catalog.hostsById, report.hostId)
      ? catalog.hostsById[report.hostId]
      : undefined;
    const extra = toolResultAuthChallengeFindings(tools, {
      hostLabel: report.hostLabel,
      provenance: report.provenance,
      mcpProfile: host?.mcpProfile,
    });
    if (extra.length === 0) return report;
    // The verdict stays; the server lane's provenance is the weakest among
    // its findings, so an `assumed` finding lowers it.
    return {
      ...report,
      findings: [...report.findings, ...extra],
      ...(report.lanes
        ? {
            lanes: {
              ...report.lanes,
              server: {
                ...report.lanes.server,
                provenance: weakestProvenance(
                  extra,
                  report.lanes.server.provenance
                ),
              },
            },
          }
        : {}),
    };
  });
}
