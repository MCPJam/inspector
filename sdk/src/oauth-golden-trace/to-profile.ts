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
import type { GoldenTrace, TraceLeg, TraceSubject } from "./types.js";

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

  // No captured leg carried `resource`. Before that can become a `false` claim,
  // EVERY leg that could have carried it has to have been watched: "the request
  // was captured and the parameter was not there" (`absent`) is a finding, while
  // "we never saw that request" (`not-observed`) is a gap, and collapsing the
  // second into the first is the HP-17 failure mode this schema exists to
  // prevent. A half-observed pair — a capture that stopped before the token
  // exchange, or an `/authorize` handed to a browser we could not watch — cannot
  // rule out that the missing leg sent it.
  const unobserved = [
    onAuthorize.state === "not-observed"
      ? { leg: "/authorize", reason: onAuthorize.reason }
      : undefined,
    onToken.state === "not-observed" ? { leg: "/token", reason: onToken.reason } : undefined,
  ].filter((entry): entry is { leg: string; reason: string } => entry != null);

  if (unobserved.length > 0) {
    const detail = unobserved.map(({ leg, reason }) => `${leg}: ${reason}`).join("; ");
    return {
      status: "unverifiable",
      reason:
        unobserved.length === 2
          ? `Neither the /authorize nor the /token leg was captured (${detail}). Re-capture a handshake that reaches the token exchange.`
          : `No \`resource\` appeared on the captured leg, but the ${unobserved[0].leg} leg was never captured (${detail}), so its absence there is UNKNOWN rather than observed — a half-observed pair cannot justify \`false\`. Re-capture a handshake that reaches the token exchange.`,
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

/** Same client, or a different one wearing a familiar host id? */
function sameSubject(a: TraceSubject, b: TraceSubject): boolean {
  return (
    a.hostId === b.hostId &&
    a.kind === b.kind &&
    a.build === b.build &&
    a.surface === b.surface
  );
}

/**
 * Why a supplied `contrastTrace` cannot carry the pin-vs-negotiate experiment,
 * or `undefined` when it can.
 *
 * The experiment is "the SAME client against a SECOND server advertising a
 * DIFFERENT protocol version". All three conditions are checkable from the
 * artifacts and every one of them is enforced here — the advertised versions via
 * `scenario.capabilities.serverProtocolVersion`, which exists for exactly this.
 *
 * Without this gate the strongest claim in the module rested on a caller
 * promise: passing a trace its own self, an unrelated host's, or a second run
 * against an identically-versioned server produced a `verified` pin out of
 * nothing. Two of those are caught by identity alone; the third is not, and it
 * is the likeliest one to happen by accident, because re-running the same
 * capture server twice is the path of least resistance.
 */
function contrastTraceRejection(
  trace: GoldenTrace,
  contrast: GoldenTrace,
): string | undefined {
  if (!sameSubject(trace.subject, contrast.subject)) {
    return `it captured a different subject (\`${contrast.subject.hostId}\`/${contrast.subject.kind}${contrast.subject.build ? ` build ${contrast.subject.build}` : ""}, not \`${trace.subject.hostId}\`/${trace.subject.kind}${trace.subject.build ? ` build ${trace.subject.build}` : ""}), so the two captures are not the same client and a shared value proves nothing about pinning`;
  }
  if (contrast.scenario.scenarioId === trace.scenario.scenarioId) {
    return `it ran the SAME scenario (\`${trace.scenario.scenarioId}\`), so there is no second server in the comparison — an identical value across two runs of one scenario is what a negotiating client produces too`;
  }

  // The load-bearing half. Two scenarios can carry different ids and still have
  // advertised the same protocol version, in which case a matching value is
  // exactly what a NEGOTIATING client produces and reading it as a pin inverts
  // the answer.
  const here = trace.scenario.capabilities.serverProtocolVersion;
  const there = contrast.scenario.capabilities.serverProtocolVersion;
  if (here == null || there == null) {
    const unknown =
      here == null && there == null
        ? `neither \`${trace.scenario.scenarioId}\` nor \`${contrast.scenario.scenarioId}\` records`
        : here == null
          ? `\`${trace.scenario.scenarioId}\` does not record`
          : `\`${contrast.scenario.scenarioId}\` does not record`;
    return `${unknown} the protocol version its server ADVERTISED (\`scenario.capabilities.serverProtocolVersion\`), so it cannot be shown that the two servers differed — and against two same-version servers a negotiating client emits the same value a pinning one does. Re-capture with the advertised version recorded`;
  }
  if (here === there) {
    return `both scenarios ran against a server advertising the SAME protocol version (\`${here}\`), so a matching value across them is precisely what a NEGOTIATING client produces — the comparison cannot distinguish the two modes it exists to separate. Capture the contrast against a server advertising a different version`;
  }
  return undefined;
}

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
  // turns an observation into a pin-vs-negotiate answer — but only if it really
  // is that experiment. See {@link contrastTraceRejection}.
  const contrast = options.contrastTrace;
  const rejection = contrast ? contrastTraceRejection(trace, contrast) : undefined;
  if (contrast && rejection == null) {
    const here = observedValue(pv.initializeBody);
    const there = observedValue(contrast.observations.protocolVersion.initializeBody);
    const hereAdvertised = trace.scenario.capabilities.serverProtocolVersion;
    const thereAdvertised = contrast.scenario.capabilities.serverProtocolVersion;
    const hereScenario = `scenario \`${trace.scenario.scenarioId}\` (server advertised \`${hereAdvertised}\`)`;
    const thereScenario = `scenario \`${contrast.scenario.scenarioId}\` (server advertised \`${thereAdvertised}\`, contrast trace \`${contrast.traceId}\`)`;
    if (here != null && there != null) {
      return here === there
        ? {
            status: "verified",
            value: { mode: "pinned", version: here },
            source: citation(
              trace,
              options.tracePath,
              `the \`initialize\` body carried \`${here}\` in both ${hereScenario} and ${thereScenario} — two servers that advertised DIFFERENT versions — so the value does not follow the server and is a client-owned pin`,
            ),
            capturedAt,
          }
        : {
            status: "verified",
            value: { mode: "negotiated" },
            source: citation(
              trace,
              options.tracePath,
              `the \`initialize\` body carried \`${here}\` in ${hereScenario} and \`${there}\` in ${thereScenario}, so the client follows the server rather than pinning`,
            ),
            capturedAt,
          };
    }
  }

  const singleCapture =
    "No `MCP-Protocol-Version` header was observed on OAuth discovery, and only one capture is available. A single trace cannot distinguish a pin from a negotiation: a client that negotiates emits exactly the same byte as one that pins when talking to one server. Settle it by capturing the same client against a second server advertising a DIFFERENT protocol version and passing it as `contrastTrace` — the trap that already produced wrong answers for SDK-delegated clients, whose single observed version was their bundled SDK's negotiated outcome.";

  return {
    status: "unverifiable",
    reason:
      rejection == null
        ? singleCapture
        : `${singleCapture} A \`contrastTrace\` WAS supplied but does not run that experiment: ${rejection}.`,
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
 *
 * Merge it with {@link mergeTraceOAuthProfile}, NOT with a plain spread. Every
 * field this projection could not settle is present as an `unverifiable` entry —
 * that is the module's most useful output, since it names the experiment that
 * would settle the field — but it means `{ ...existing, ...projection }` would
 * overwrite evidence a source-reading already verified with "a trace cannot
 * settle this". That is evidence loss dressed up as an update.
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

// ── Merging a projection over an existing profile ────────────────────────

/**
 * Keep whichever of the two evidence entries actually settled something.
 *
 * A projected `unverifiable` never displaces an existing `verified` / `refuted`
 * entry: "one trace cannot enumerate every auth model" is a statement about this
 * experiment's reach, not a retraction of a source-reading that already answered
 * the field. In every other case the trace wins, because a capture is stronger
 * evidence than a doc for the fields it does settle.
 */
function preferSettled<T>(
  base: OAuthProfileEvidence<T> | undefined,
  projected: OAuthProfileEvidence<T> | undefined,
): OAuthProfileEvidence<T> | undefined {
  if (!projected) return base;
  if (projected.status === "unverifiable" && base && base.status !== "unverifiable") {
    return base;
  }
  return projected;
}

/**
 * Merge a trace projection over an existing profile without downgrading it.
 *
 * This is the merge {@link traceToOAuthProfile}'s doc comment promises. Field by
 * field it applies {@link preferSettled}; `extensions` are SHALLOW-merged with
 * the trace's keys last, so a projection adds its `trace*` observations without
 * dropping extensions another source wrote.
 *
 * `undefined` base returns the projection unchanged — a first projection onto a
 * host that has never been investigated.
 */
export function mergeTraceOAuthProfile(
  base: HostConfigOAuthProfileV1 | undefined,
  projection: HostConfigOAuthProfileV1,
): HostConfigOAuthProfileV1 {
  if (!base) return projection;

  const sendsResourceIndicator = preferSettled(
    base.sendsResourceIndicator,
    projection.sendsResourceIndicator,
  );
  // Same bug class, one field deeper: a trace can only ever justify a behavioral
  // FLOOR, so letting it displace an existing `basis: "constant"` claim — the
  // exact revision set read out of the client's source — would trade a precise
  // fact for a weaker one that is simultaneously true.
  const baseSpecVersion = base.oauthSpecVersion;
  const oauthSpecVersion =
    baseSpecVersion &&
    baseSpecVersion.status !== "unverifiable" &&
    baseSpecVersion.value.basis === "constant"
      ? baseSpecVersion
      : preferSettled(baseSpecVersion, projection.oauthSpecVersion);
  const protocolVersionPinning = preferSettled(
    base.protocolVersionPinning,
    projection.protocolVersionPinning,
  );
  const dcrIdentity = preferSettled(base.dcrIdentity, projection.dcrIdentity);
  const authModel = preferSettled(base.authModel, projection.authModel);
  const extensions =
    base.extensions || projection.extensions
      ? { ...base.extensions, ...projection.extensions }
      : undefined;

  // Conditional spreads rather than `key: undefined`: an absent field must stay
  // absent so an uninvestigated host keeps hashing like a pre-feature row.
  return {
    ...base,
    profileVersion: 1,
    ...(sendsResourceIndicator ? { sendsResourceIndicator } : {}),
    ...(oauthSpecVersion ? { oauthSpecVersion } : {}),
    ...(protocolVersionPinning ? { protocolVersionPinning } : {}),
    ...(dcrIdentity ? { dcrIdentity } : {}),
    ...(authModel ? { authModel } : {}),
    ...(extensions ? { extensions } : {}),
  };
}
