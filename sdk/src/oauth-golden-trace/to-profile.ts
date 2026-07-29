/**
 * HP-44 — project a golden trace onto {@link HostConfigOAuthProfileV1}.
 *
 * A trace is the strongest possible `source` for a profile field: it is a
 * recorded artifact a reviewer can open, not a claim. This module is where that
 * strength gets spent — carefully, because a trace proves LESS than it appears
 * to about several fields, and overstating it would recreate the exact failure
 * this whole line of work is a reaction to.
 *
 * ── What one trace can and cannot settle ──────────────────────────────────
 *
 * CAN:
 *   - `sendsResourceIndicator`, when the scenario published a PRM document. With
 *     no PRM, absence is the CORRECT behavior for several clients and proves
 *     nothing about what they do when PRM exists.
 *   - `dcrIdentity` — `client_name`, redirect-URI pattern, User-Agent. These are
 *     literal bytes on the wire and a capture is definitive.
 *   - `protocolVersionPinning`, but ONLY from the `MCP-Protocol-Version` header on
 *     OAuth DISCOVERY. At discovery time no `initialize` has happened, so there
 *     is nothing to have negotiated with: whatever value appears there is a
 *     client-chosen constant, i.e. a pin by definition. This is precisely how
 *     `rmcp`'s hardcoded `2024-11-05` on discovery is provable from a capture
 *     while being invisible in any vendor doc.
 *
 * CANNOT:
 *   - `protocolVersionPinning` from the `initialize` body. One capture against
 *     one server shows one value, and a client that NEGOTIATES would produce
 *     exactly the same byte. Distinguishing a pin from a negotiation needs two
 *     captures against servers advertising DIFFERENT versions. This is the trap
 *     that already caught cline and n8n, where a single observed version was the
 *     bundled SDK's negotiated outcome rather than a client-owned pin.
 *   - `authModel`. The field is "every model the client supports, in preference
 *     order"; a trace shows the one path taken against one server's capabilities.
 *     Enumerating support is a source-reading or vendor-doc job.
 *   - `oauthSpecVersion` as `basis: "constant"`. A trace can only ever justify
 *     `basis: "behavioral"` with a minimum-revision FLOOR — a literal revision
 *     string is a claim about the client's code or its docs, not its wire.
 *
 * Every field this module cannot settle is emitted as `unverifiable` with the
 * specific experiment that WOULD settle it, and the underlying observation is
 * preserved in `extensions` so no evidence is thrown away.
 */

import type {
  HostConfigOAuthProfileV1,
  OAuthAuthModel,
  OAuthDcrIdentity,
  OAuthProfileEvidence,
  OAuthProtocolVersionPinning,
  OAuthSpecVersionClaim,
} from "../host-config/types.js";
import { observedValue } from "./types.js";
import type { GoldenTrace, TraceLeg } from "./types.js";

/** How a trace cites itself as evidence. `E2` per the HP-47 evidence classes. */
function citation(trace: GoldenTrace, path: string | undefined, detail: string): string {
  const location = path ? ` (${path})` : "";
  return `E2 — golden trace \`${trace.traceId}\`${location}: ${detail}`;
}

export type TraceToProfileOptions = {
  /**
   * Repo-relative path the trace is committed at, so the `source` string is a
   * citation a reviewer can follow rather than an opaque id.
   */
  tracePath?: string;
  /**
   * A second trace of the same host captured against a server advertising a
   * DIFFERENT protocol version. Supplying it is the only way
   * `protocolVersionPinning` can be settled for the `initialize` body — with one
   * trace the field stays `unverifiable` no matter how clean the capture was.
   */
  contrastTrace?: GoldenTrace;
};

// ── sendsResourceIndicator ───────────────────────────────────────────────

function mapResourceIndicator(
  trace: GoldenTrace,
  options: TraceToProfileOptions,
): OAuthProfileEvidence<boolean> {
  const { onAuthorize, onToken } = trace.observations.resourceIndicator;
  const capturedAt = trace.capture.capturedAt;

  if (onAuthorize.state === "not-observed" && onToken.state === "not-observed") {
    return {
      status: "unverifiable",
      reason: `Neither the /authorize nor the /token leg was captured (${onAuthorize.reason}). Re-capture a handshake that reaches the token exchange.`,
      capturedAt,
    };
  }

  const sentOnAuthorize = onAuthorize.state === "present";
  const sentOnToken = onToken.state === "present";

  if (sentOnAuthorize || sentOnToken) {
    const legs = [
      sentOnAuthorize ? "/authorize" : undefined,
      sentOnToken ? "/token" : undefined,
    ].filter(Boolean);
    return {
      status: "verified",
      value: true,
      source: citation(
        trace,
        options.tracePath,
        `RFC 8707 \`resource\` observed on ${legs.join(" and ")}; value source classified as ${observedValue(trace.observations.resourceIndicator.valueSource) ?? "unclassified"}`,
      ),
      capturedAt,
    };
  }

  // Both legs captured, neither carried `resource`. Whether that is a finding
  // depends entirely on whether the server gave the client a PRM document to
  // read the resource FROM — several clients omit `resource` when PRM discovery
  // fails, and doing so is correct.
  if (!trace.scenario.capabilities.publishesPrm) {
    return {
      status: "unverifiable",
      reason:
        "No `resource` was sent, but this scenario's server publishes no RFC 9728 PRM document. Several clients omit `resource` entirely when PRM discovery fails, so absence here does not distinguish \"never sends it\" from \"sends it only when PRM exists\". Re-capture against a PRM-publishing server.",
      capturedAt,
    };
  }

  return {
    status: "verified",
    value: false,
    source: citation(
      trace,
      options.tracePath,
      "both /authorize and /token were captured against a PRM-publishing server and neither carried an RFC 8707 `resource` parameter",
    ),
    capturedAt,
  };
}

// ── oauthSpecVersion ────────────────────────────────────────────────────

/**
 * A trace justifies only a behavioral FLOOR, never an exact revision.
 *
 * The ladder rungs are ordered: a CIMD fetch implies 2025-11-25 or later; an RFC
 * 9728 PRM fetch implies 2025-06-18 or later. Anything weaker cannot be turned
 * into a floor, because a client that skipped PRM may simply have been talking to
 * a server that published none.
 */
function mapOAuthSpecVersion(
  trace: GoldenTrace,
  options: TraceToProfileOptions,
): OAuthProfileEvidence<OAuthSpecVersionClaim> {
  const legs = new Set<TraceLeg>(trace.observations.legOrder);
  const capturedAt = trace.capture.capturedAt;

  if (legs.has("cimd-fetch")) {
    return {
      status: "verified",
      value: { basis: "behavioral", minimumRevision: "2025-11-25" },
      source: citation(
        trace,
        options.tracePath,
        "the client fetched a Client ID Metadata Document, which is a 2025-11-25 mechanism; recorded as a FLOOR, not an exact revision",
      ),
      capturedAt,
    };
  }

  if (legs.has("prm-discovery")) {
    return {
      status: "verified",
      value: { basis: "behavioral", minimumRevision: "2025-06-18" },
      source: citation(
        trace,
        options.tracePath,
        "the client ran an RFC 9728 protected-resource-metadata discovery step, which entered the MCP authorization spec at 2025-06-18; recorded as a FLOOR, not an exact revision",
      ),
      capturedAt,
    };
  }

  if (trace.scenario.capabilities.publishesPrm) {
    return {
      status: "unverifiable",
      reason:
        "The server published a PRM document and the client did not fetch it, which places the client BELOW 2025-06-18 — but a floor cannot be expressed downwards, and the exact revision is a claim about the client's code rather than its wire. Read the client's source or its vendor docs to name a revision.",
      capturedAt,
    };
  }

  return {
    status: "unverifiable",
    reason:
      "No PRM or CIMD discovery was observed, and this scenario's server published neither, so the absence is a property of the test server rather than of the client. Re-capture against a server that publishes both.",
    capturedAt,
  };
}

// ── protocolVersionPinning ──────────────────────────────────────────────

function mapProtocolVersionPinning(
  trace: GoldenTrace,
  options: TraceToProfileOptions,
): OAuthProfileEvidence<OAuthProtocolVersionPinning> {
  const pv = trace.observations.protocolVersion;
  const capturedAt = trace.capture.capturedAt;
  const discoveryValues = observedValue(pv.headerOnOAuthDiscovery);

  // The one arm a single trace can prove. At OAuth-discovery time no
  // `initialize` has occurred, so the header cannot be a negotiated value.
  if (discoveryValues && discoveryValues.length === 1) {
    return {
      status: "verified",
      value: { mode: "pinned", version: discoveryValues[0] },
      source: citation(
        trace,
        options.tracePath,
        `\`MCP-Protocol-Version: ${discoveryValues[0]}\` was sent on OAuth discovery, BEFORE any \`initialize\` exchange — so it cannot be a negotiated value and is a client-chosen constant. Scope: the OAuth wire only. The \`initialize\` body version is recorded separately in \`extensions.traceProtocolVersion\` and is NOT evidence of a pin`,
      ),
      capturedAt,
    };
  }

  if (discoveryValues && discoveryValues.length > 1) {
    // More than one distinct value across discovery legs is NOT a negotiation
    // (there is nothing to negotiate with at discovery time) and NOT a single
    // pin either — it is several different hardcoded constants, which the
    // two-arm target type cannot spell.
    return {
      status: "unverifiable",
      reason: `OAuth discovery carried ${discoveryValues.length} DIFFERENT \`MCP-Protocol-Version\` values (${discoveryValues.join(", ")}). None of them is negotiated — discovery precedes any \`initialize\` — so this is several distinct hardcoded constants on different legs, which \`OAuthProtocolVersionPinning\` has no arm for. The per-leg breakdown is in \`extensions.traceProtocolVersion.headerByLeg\`; a client behaving this way needs a schema arm, not a re-capture.`,
      capturedAt,
    };
  }

  // A contrast trace against a server advertising a different version is what
  // turns an observation into a pin-vs-negotiate answer.
  const contrast = options.contrastTrace;
  if (contrast) {
    const here = observedValue(pv.initializeBody);
    const there = observedValue(contrast.observations.protocolVersion.initializeBody);
    if (here != null && there != null) {
      return here === there
        ? {
            status: "verified",
            value: { mode: "pinned", version: here },
            source: citation(
              trace,
              options.tracePath,
              `the \`initialize\` body carried \`${here}\` against two servers advertising different protocol versions (contrast trace \`${contrast.traceId}\`), so the value does not follow the server and is a client-owned pin`,
            ),
            capturedAt,
          }
        : {
            status: "verified",
            value: { mode: "negotiated" },
            source: citation(
              trace,
              options.tracePath,
              `the \`initialize\` body carried \`${here}\` here and \`${there}\` in contrast trace \`${contrast.traceId}\`, so the client follows the server rather than pinning`,
            ),
            capturedAt,
          };
    }
  }

  return {
    status: "unverifiable",
    reason:
      "No `MCP-Protocol-Version` header was observed on OAuth discovery, and only one capture is available. A single trace cannot distinguish a pin from a negotiation: a client that negotiates emits exactly the same byte as one that pins when talking to one server. Settle it by capturing the same client against a second server advertising a DIFFERENT protocol version and passing it as `contrastTrace` — the trap that already produced wrong answers for SDK-delegated clients, whose single observed version was their bundled SDK's negotiated outcome.",
    capturedAt,
  };
}

// ── dcrIdentity ─────────────────────────────────────────────────────────

/**
 * The single User-Agent this host used, or `undefined` when there isn't one.
 *
 * `undefined` deliberately covers two cases the target type cannot distinguish —
 * "no UA was sent at all" and "the UA varied across legs" — so the caller records
 * a caveat and preserves the per-leg detail in `extensions.traceUserAgent`.
 * Goose is the live example: its UA is verified on the MCP transport but whether
 * it reaches the authorization server is not, because `rmcp` may build its own
 * HTTP client.
 */
function singleUserAgent(trace: GoldenTrace): string | undefined {
  const { byLeg, consistent } = trace.observations.userAgent;
  const values = new Set<string>();
  for (const observation of Object.values(byLeg)) {
    for (const value of observedValue(observation) ?? []) values.add(value);
  }
  return values.size === 1 && consistent ? [...values][0] : undefined;
}

function mapDcrIdentity(
  trace: GoldenTrace,
  options: TraceToProfileOptions,
): OAuthProfileEvidence<OAuthDcrIdentity> {
  const dcr = trace.observations.dcrIdentity;
  const capturedAt = trace.capture.capturedAt;

  if (dcr.clientName.state === "not-observed" && dcr.redirectUris.state === "not-observed") {
    return {
      status: "unverifiable",
      reason: `No dynamic client registration request was captured (${dcr.clientName.state === "not-observed" ? dcr.clientName.reason : "no registration leg"}). A client using CIMD or a pre-registered client_id never sends one, so re-capture only if this host is expected to use DCR.`,
      capturedAt,
    };
  }

  const clientName = observedValue(dcr.clientName);
  const redirectUris = observedValue(dcr.redirectUris);
  const userAgent = singleUserAgent(trace);

  const value: OAuthDcrIdentity = {
    ...(clientName != null ? { clientName } : {}),
    ...(redirectUris != null ? { redirectUris } : {}),
    ...(userAgent != null ? { userAgent } : {}),
  };

  if (Object.keys(value).length === 0) {
    return {
      status: "unverifiable",
      reason:
        "A registration request was captured but it carried none of `client_name`, `redirect_uris`, or a `User-Agent`. That is itself notable — see `extensions.traceDcrIdentity` for the raw observation.",
      capturedAt,
    };
  }

  const notes: string[] = [];
  if (redirectUris?.some((uri) => uri.includes("{port}"))) {
    notes.push(
      "loopback ports are placeheld as `{port}` because they are ephemeral; the ports actually seen are in `extensions.traceDcrIdentity.observedLoopbackPorts`",
    );
  }
  if (!userAgent) {
    notes.push(
      "no single `User-Agent` could be attributed: either none was sent or it varied across legs, and `OAuthDcrIdentity` has no way to distinguish those — see `extensions.traceUserAgent`",
    );
  }

  return {
    status: "verified",
    value,
    source: citation(
      trace,
      options.tracePath,
      `dynamic client registration body observed on the wire${notes.length > 0 ? `. Caveats: ${notes.join("; ")}` : ""}`,
    ),
    capturedAt,
  };
}

// ── authModel ───────────────────────────────────────────────────────────

function mapAuthModel(
  trace: GoldenTrace,
): OAuthProfileEvidence<OAuthAuthModel[]> {
  // No cast needed: the `unverifiable` arm carries no value, which is exactly the
  // property that makes unverified lore unrepresentable in this type.
  return {
    status: "unverifiable",
    reason:
      "`authModel` is defined as every auth model the client supports, in preference order. A trace records the ONE path the client took against ONE server's advertised capabilities, which cannot enumerate what else it supports — a server offering only DCR gives a CIMD-capable client no opportunity to reveal that. The observed path is preserved in `extensions.traceAuthPath`. Settle this from the client's source or its vendor documentation.",
    capturedAt: trace.capture.capturedAt,
  };
}

// ── Entry point ─────────────────────────────────────────────────────────

/**
 * Project a trace onto a host-config OAuth profile.
 *
 * The returned profile is intended to be MERGED over an existing profile, not to
 * replace it: a trace is stronger evidence than a doc for the fields it settles,
 * and silent about the rest. `extensions` carries every observation the target
 * type cannot express, so a schema gap never costs us a finding.
 */
export function traceToOAuthProfile(
  trace: GoldenTrace,
  options: TraceToProfileOptions = {},
): HostConfigOAuthProfileV1 {
  const pv = trace.observations.protocolVersion;

  return {
    profileVersion: 1,
    sendsResourceIndicator: mapResourceIndicator(trace, options),
    oauthSpecVersion: mapOAuthSpecVersion(trace, options),
    protocolVersionPinning: mapProtocolVersionPinning(trace, options),
    dcrIdentity: mapDcrIdentity(trace, options),
    authModel: mapAuthModel(trace),
    extensions: {
      // Provenance: which artifact these fields came from.
      traceProvenance: {
        traceId: trace.traceId,
        ...(options.tracePath ? { tracePath: options.tracePath } : {}),
        scenarioId: trace.scenario.scenarioId,
        capturedAt: trace.capture.capturedAt,
        subjectKind: trace.subject.kind,
        hostVersion: trace.subject.hostVersion,
        oauthImplementation: trace.subject.oauthImplementation,
      },
      // The two-headed protocol-version finding, kept whole. `protocolVersionPinning`
      // above can only carry one arm of this; discarding the rest would average
      // away the most interesting observation in the trace.
      traceProtocolVersion: {
        initializeBody: pv.initializeBody,
        headerOnOAuthDiscovery: pv.headerOnOAuthDiscovery,
        headerOnMcpTraffic: pv.headerOnMcpTraffic,
        headerByLeg: pv.headerByLeg,
        wiresDisagree: pv.wiresDisagree,
        headerDisagreesWithInitializeBody: pv.headerDisagreesWithInitializeBody,
      },
      // The per-leg / conditional resource-indicator detail a boolean cannot hold.
      traceResourceIndicator: trace.observations.resourceIndicator,
      traceDcrIdentity: trace.observations.dcrIdentity,
      traceUserAgent: trace.observations.userAgent,
      traceAuthPath: {
        legOrder: trace.observations.legOrder,
        endpointsHit: trace.observations.endpointsHit,
        discoveryLadder: trace.observations.discoveryLadder,
      },
      tracePkce: trace.observations.pkce,
    },
  };
}
