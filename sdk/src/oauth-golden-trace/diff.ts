/**
 * HP-44 — the trace differ. This is the acceptance oracle.
 *
 * Given a GOLDEN trace (recorded from a real host) and a CANDIDATE trace
 * (produced by our emulator for that host against the same scenario), report
 * field-by-field where they diverge: request ordering, endpoints hit, params
 * present/absent, headers, DCR body.
 *
 * ── Three rules that make the output trustworthy ──────────────────────────
 *
 *  1. A GAP IS NEVER A PASS AND NEVER A FAILURE. If either side did not capture
 *     the leg carrying a field, the finding is `gap` — not `match` (which would
 *     claim parity we did not observe) and not `difference` (which would blame
 *     the emulator for our own missing capture). {@link compareObservation} is
 *     the single place this is decided, so it cannot be got wrong field by field.
 *
 *  2. INCOMPARABLE TRACES SHORT-CIRCUIT. Two traces of different scenarios, or
 *     of different hosts, produce exactly one `incomparable` finding rather than
 *     a cascade of forty bogus differences. A wall of red that all stems from
 *     one misconfiguration teaches a reviewer to ignore the tool.
 *
 *  3. SUBJECT METADATA IS DIFFED ONLY IN DRIFT MODE. In `parity` mode the two
 *     sides differ by construction — the golden side is `rmcp` inside a real
 *     host, the candidate side is our own state machine — so reporting that as
 *     a difference would be noise. In `drift` mode (the same subject captured on
 *     two dates, which is HP-38's job) a version change is precisely the signal.
 */

import { observedValue } from "./types.js";
import type {
  GoldenTrace,
  Observation,
  TraceDiffDimension,
  TraceDiffFinding,
  TraceDiffResult,
  TraceDiffSeverity,
  TraceExchange,
  TraceLeg,
  TraceScenarioCapabilities,
} from "./types.js";

export type TraceDiffMode =
  /** Emulator vs real host. Subject metadata differences are expected. */
  | "parity"
  /** Same subject, two captures. Subject metadata differences ARE the finding. */
  | "drift";

export type TraceDiffOptions = {
  /** Defaults to `drift` when both subjects have the same `kind`, else `parity`. */
  mode?: TraceDiffMode;
  /**
   * Headers excluded from value comparison. Defaults to none: the normalizer
   * already placeholds every value that varies run-to-run, so anything still
   * differing here is a real behavioral difference worth seeing.
   */
  ignoreHeaders?: string[];
};

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function renderObservation<T>(observation: Observation<T>): unknown {
  switch (observation.state) {
    case "present":
      return observation.value;
    case "absent":
      return "<absent on the wire>";
    case "not-observed":
      return `<not observed: ${observation.reason}>`;
  }
}

/**
 * The one comparator every field routes through.
 *
 * `absent` vs `present` is a real difference — a host that sends no
 * `MCP-Protocol-Version` on MCP traffic genuinely differs from an emulator that
 * does. `not-observed` on either side is a gap, full stop.
 */
export function compareObservation<T>(
  path: string,
  dimension: TraceDiffDimension,
  label: string,
  golden: Observation<T>,
  candidate: Observation<T>,
): TraceDiffFinding {
  const base = {
    path,
    dimension,
    golden: renderObservation(golden),
    candidate: renderObservation(candidate),
  };

  if (golden.state === "not-observed" || candidate.state === "not-observed") {
    const which =
      golden.state === "not-observed" && candidate.state === "not-observed"
        ? "neither trace"
        : golden.state === "not-observed"
          ? "the golden trace"
          : "the candidate trace";
    return {
      ...base,
      severity: "gap",
      message: `${label} is not comparable: ${which} observed it.`,
    };
  }

  if (golden.state === "absent" && candidate.state === "absent") {
    return { ...base, severity: "match", message: `${label} is absent on both sides.` };
  }

  if (golden.state === "absent") {
    return {
      ...base,
      severity: "difference",
      message: `${label}: the real host sends nothing, but the emulator sends a value.`,
    };
  }

  if (candidate.state === "absent") {
    return {
      ...base,
      severity: "difference",
      message: `${label}: the real host sends a value, but the emulator sends nothing.`,
    };
  }

  return equal(golden.value, candidate.value)
    ? { ...base, severity: "match", message: `${label} matches.` }
    : {
        ...base,
        severity: "difference",
        message: `${label} differs between the real host and the emulator.`,
      };
}

/** Compare two plain (always-observed) values. */
function compareValue(
  path: string,
  dimension: TraceDiffDimension,
  label: string,
  golden: unknown,
  candidate: unknown,
): TraceDiffFinding {
  return equal(golden, candidate)
    ? { path, dimension, severity: "match", message: `${label} matches.`, golden, candidate }
    : {
        path,
        dimension,
        severity: "difference",
        message: `${label} differs.`,
        golden,
        candidate,
      };
}

// ── Scenario / subject gates ─────────────────────────────────────────────

function capabilityDifferences(
  golden: TraceScenarioCapabilities,
  candidate: TraceScenarioCapabilities,
): string[] {
  const keys = Object.keys({ ...golden, ...candidate }) as Array<
    keyof TraceScenarioCapabilities
  >;
  return keys
    .filter((key) => !equal(golden[key], candidate[key]))
    .map(
      (key) =>
        `${key}: golden=${JSON.stringify(golden[key])} candidate=${JSON.stringify(candidate[key])}`,
    );
}

function gateFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
): TraceDiffFinding[] {
  const findings: TraceDiffFinding[] = [];

  if (golden.subject.hostId !== candidate.subject.hostId) {
    findings.push({
      path: "subject.hostId",
      dimension: "subject",
      severity: "incomparable",
      message:
        "These traces describe different hosts. A parity diff across two hosts has no meaning — no host is supposed to behave like another one.",
      golden: golden.subject.hostId,
      candidate: candidate.subject.hostId,
    });
  }

  if (golden.scenario.scenarioId !== candidate.scenario.scenarioId) {
    findings.push({
      path: "scenario.scenarioId",
      dimension: "scenario",
      severity: "incomparable",
      message:
        "These traces were captured against different scenarios. Re-run the emulator against the same test server the golden trace used.",
      golden: golden.scenario.scenarioId,
      candidate: candidate.scenario.scenarioId,
    });
    return findings;
  }

  const capabilityDiffs = capabilityDifferences(
    golden.scenario.capabilities,
    candidate.scenario.capabilities,
  );
  if (capabilityDiffs.length > 0) {
    findings.push({
      path: "scenario.capabilities",
      dimension: "scenario",
      severity: "incomparable",
      message: `The two scenarios share an id but not their server capabilities, so client behavior is not comparable (${capabilityDiffs.join("; ")}). A client that omits \`resource\` when PRM discovery fails is behaving correctly, and diffing it against a with-PRM capture would report that correct behavior as a failure.`,
      golden: golden.scenario.capabilities,
      candidate: candidate.scenario.capabilities,
    });
  }

  return findings;
}

function subjectFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
  mode: TraceDiffMode,
): TraceDiffFinding[] {
  const findings: TraceDiffFinding[] = [];

  // Always report a missing version stamp: a trace that cannot say which build
  // it recorded goes stale without anyone noticing, which is the durability
  // failure HP-38 exists to catch.
  for (const [side, trace] of [
    ["golden", golden],
    ["candidate", candidate],
  ] as const) {
    if (trace.subject.hostVersion.state === "not-observed") {
      findings.push({
        path: `subject.hostVersion (${side})`,
        dimension: "subject",
        severity: "gap",
        message: `The ${side} trace does not record a host version, so it cannot be told apart from a capture of a different build.`,
        golden: renderObservation(golden.subject.hostVersion),
        candidate: renderObservation(candidate.subject.hostVersion),
      });
    }
    if (trace.subject.oauthImplementation.state === "not-observed") {
      findings.push({
        path: `subject.oauthImplementation (${side})`,
        dimension: "subject",
        severity: "gap",
        message: `The ${side} trace does not record which OAuth implementation produced it. Five of six source-verified clients inherit OAuth from a dependency, so without a resolved package version this trace goes stale on a dependency bump with no visible signal.`,
        golden: renderObservation(golden.subject.oauthImplementation),
        candidate: renderObservation(candidate.subject.oauthImplementation),
      });
    }
  }

  if (mode === "drift") {
    findings.push(
      compareObservation(
        "subject.hostVersion",
        "subject",
        "Host version",
        golden.subject.hostVersion,
        candidate.subject.hostVersion,
      ),
      compareObservation(
        "subject.oauthImplementation",
        "subject",
        "Resolved OAuth implementation",
        golden.subject.oauthImplementation,
        candidate.subject.oauthImplementation,
      ),
    );
  }

  return findings;
}

// ── Wire-level comparisons ───────────────────────────────────────────────

function firstExchangeForLeg(
  wire: readonly TraceExchange[],
  leg: TraceLeg,
): TraceExchange | undefined {
  return wire.find((exchange) => exchange.leg === leg);
}

function orderingFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
): TraceDiffFinding[] {
  const findings: TraceDiffFinding[] = [
    compareValue(
      "observations.legOrder",
      "request-ordering",
      "Leg ordering (first appearance of each stage)",
      golden.observations.legOrder,
      candidate.observations.legOrder,
    ),
  ];

  // The full sequence catches repeat-count differences the first-appearance
  // order hides — e.g. a client that retries AS discovery at a second rung.
  const goldenSequence = golden.wire.map((exchange) => exchange.leg);
  const candidateSequence = candidate.wire.map((exchange) => exchange.leg);
  if (!equal(goldenSequence, candidateSequence)) {
    findings.push({
      path: "wire[].leg",
      dimension: "request-ordering",
      severity: "difference",
      message:
        "The full request sequence differs (counts or order), even where the set of stages agrees.",
      golden: goldenSequence,
      candidate: candidateSequence,
    });
  }

  return findings;
}

function endpointFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
): TraceDiffFinding[] {
  const findings: TraceDiffFinding[] = [];
  const goldenSet = golden.observations.endpointsHit;
  const candidateSet = candidate.observations.endpointsHit;

  const missing = goldenSet.filter((endpoint) => !candidateSet.includes(endpoint));
  const extra = candidateSet.filter((endpoint) => !goldenSet.includes(endpoint));

  if (missing.length === 0 && extra.length === 0) {
    findings.push({
      path: "observations.endpointsHit",
      dimension: "endpoints",
      severity: "match",
      message: "Both sides hit the same set of endpoints.",
      golden: goldenSet,
      candidate: candidateSet,
    });
  } else {
    if (missing.length > 0) {
      findings.push({
        path: "observations.endpointsHit",
        dimension: "endpoints",
        severity: "difference",
        message: `The emulator never hit ${missing.length} endpoint(s) the real host did.`,
        golden: missing,
        candidate: null,
      });
    }
    if (extra.length > 0) {
      findings.push({
        path: "observations.endpointsHit",
        dimension: "endpoints",
        severity: "difference",
        message: `The emulator hit ${extra.length} endpoint(s) the real host did not.`,
        golden: null,
        candidate: extra,
      });
    }
  }

  findings.push(
    compareValue(
      "observations.discoveryLadder",
      "endpoints",
      "Discovery ladder (well-known paths, in order tried)",
      golden.observations.discoveryLadder,
      candidate.observations.discoveryLadder,
    ),
  );

  return findings;
}

/**
 * Per-leg parameter and header comparison.
 *
 * Only legs BOTH sides captured are compared field by field; a leg only one side
 * has is a `gap`, since we cannot tell an emulator bug from a capture that
 * stopped early (a real host capture often stops at the consent screen).
 */
function perLegFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
  options: TraceDiffOptions,
): TraceDiffFinding[] {
  const findings: TraceDiffFinding[] = [];
  const ignoreHeaders = new Set(
    (options.ignoreHeaders ?? []).map((header) => header.toLowerCase()),
  );

  const legs: TraceLeg[] = [];
  for (const leg of [
    ...golden.observations.legOrder,
    ...candidate.observations.legOrder,
  ]) {
    if (!legs.includes(leg)) legs.push(leg);
  }

  for (const leg of legs) {
    const goldenExchange = firstExchangeForLeg(golden.wire, leg);
    const candidateExchange = firstExchangeForLeg(candidate.wire, leg);

    if (!goldenExchange || !candidateExchange) {
      const which = !goldenExchange ? "the golden trace" : "the candidate trace";
      findings.push({
        path: `wire[leg=${leg}]`,
        dimension: "params",
        severity: "gap",
        message: `The \`${leg}\` leg is only present on one side (${which} lacks it), so its params and headers are not comparable.`,
        golden: goldenExchange ? "captured" : "<not observed>",
        candidate: candidateExchange ? "captured" : "<not observed>",
      });
      continue;
    }

    findings.push(
      compareValue(
        `wire[leg=${leg}].request.method`,
        "params",
        `\`${leg}\` HTTP method`,
        goldenExchange.request.method,
        candidateExchange.request.method,
      ),
    );

    // ── params ──
    const goldenQuery = goldenExchange.request.query ?? {};
    const candidateQuery = candidateExchange.request.query ?? {};
    const queryKeys = [
      ...new Set([...Object.keys(goldenQuery), ...Object.keys(candidateQuery)]),
    ].sort();

    for (const key of queryKeys) {
      const inGolden = key in goldenQuery;
      const inCandidate = key in candidateQuery;
      const path = `wire[leg=${leg}].request.query.${key}`;

      if (!inGolden || !inCandidate) {
        findings.push({
          path,
          dimension: "params",
          severity: "difference",
          message: inGolden
            ? `\`${leg}\` is missing the \`${key}\` param the real host sends.`
            : `\`${leg}\` carries a \`${key}\` param the real host does not send.`,
          golden: goldenQuery[key] ?? "<absent>",
          candidate: candidateQuery[key] ?? "<absent>",
        });
        continue;
      }

      findings.push(
        compareValue(
          path,
          "params",
          `\`${leg}\` param \`${key}\``,
          goldenQuery[key],
          candidateQuery[key],
        ),
      );
    }

    // ── headers ──
    // A leg whose headers were never intercepted on either side (a browser-driven
    // `/authorize`) yields one gap, not a per-header cascade of fabricated
    // differences.
    if (
      goldenExchange.request.headersObserved === false ||
      candidateExchange.request.headersObserved === false
    ) {
      const which =
        goldenExchange.request.headersObserved === false &&
        candidateExchange.request.headersObserved === false
          ? "neither side"
          : goldenExchange.request.headersObserved === false
            ? "the golden trace"
            : "the candidate trace";
      findings.push({
        path: `wire[leg=${leg}].request.headers`,
        dimension: "headers",
        severity: "gap",
        message: `\`${leg}\` request headers are not comparable: ${which} intercepted them (the request was reconstructed from a URL the client handed to a browser). Capture this leg through a proxy to close it.`,
        golden: goldenExchange.request.headersObserved === false ? "<not intercepted>" : Object.keys(goldenExchange.request.headers),
        candidate: candidateExchange.request.headersObserved === false ? "<not intercepted>" : Object.keys(candidateExchange.request.headers),
      });
    } else {
      const goldenHeaders = goldenExchange.request.headers;
      const candidateHeaders = candidateExchange.request.headers;
      const headerKeys = [
        ...new Set([...Object.keys(goldenHeaders), ...Object.keys(candidateHeaders)]),
      ]
        .filter((key) => !ignoreHeaders.has(key))
        .sort();

      for (const key of headerKeys) {
        const inGolden = key in goldenHeaders;
        const inCandidate = key in candidateHeaders;
        const path = `wire[leg=${leg}].request.headers.${key}`;

        if (!inGolden || !inCandidate) {
          findings.push({
            path,
            dimension: "headers",
            severity: "difference",
            message: inGolden
              ? `\`${leg}\` is missing the \`${key}\` header the real host sends.`
              : `\`${leg}\` carries a \`${key}\` header the real host does not send.`,
            golden: goldenHeaders[key] ?? "<absent>",
            candidate: candidateHeaders[key] ?? "<absent>",
          });
          continue;
        }

        findings.push(
          compareValue(
            path,
            "headers",
            `\`${leg}\` header \`${key}\``,
            goldenHeaders[key],
            candidateHeaders[key],
          ),
        );
      }
    }

    // ── form body fields (token / refresh legs) ──
    const goldenBody = goldenExchange.request.body;
    const candidateBody = candidateExchange.request.body;
    if (goldenBody?.encoding === "form" && candidateBody?.encoding === "form") {
      const fieldKeys = [
        ...new Set([
          ...Object.keys(goldenBody.fields),
          ...Object.keys(candidateBody.fields),
        ]),
      ].sort();

      for (const key of fieldKeys) {
        const inGolden = key in goldenBody.fields;
        const inCandidate = key in candidateBody.fields;
        const path = `wire[leg=${leg}].request.body.${key}`;

        if (!inGolden || !inCandidate) {
          findings.push({
            path,
            dimension: "params",
            severity: "difference",
            message: inGolden
              ? `\`${leg}\` body is missing the \`${key}\` field the real host sends.`
              : `\`${leg}\` body carries a \`${key}\` field the real host does not send.`,
            golden: goldenBody.fields[key] ?? "<absent>",
            candidate: candidateBody.fields[key] ?? "<absent>",
          });
          continue;
        }

        findings.push(
          compareValue(
            path,
            "params",
            `\`${leg}\` body field \`${key}\``,
            goldenBody.fields[key],
            candidateBody.fields[key],
          ),
        );
      }
    } else if (!equal(goldenBody?.encoding, candidateBody?.encoding)) {
      findings.push({
        path: `wire[leg=${leg}].request.body.encoding`,
        dimension: "params",
        severity: "difference",
        message: `\`${leg}\` request body encoding differs.`,
        golden: goldenBody?.encoding ?? "<no body>",
        candidate: candidateBody?.encoding ?? "<no body>",
      });
    }
  }

  return findings;
}

// ── Observation-level comparisons ────────────────────────────────────────

function protocolVersionFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
): TraceDiffFinding[] {
  const goldenPv = golden.observations.protocolVersion;
  const candidatePv = candidate.observations.protocolVersion;

  const findings: TraceDiffFinding[] = [
    compareObservation(
      "observations.protocolVersion.initializeBody",
      "protocol-version",
      "`initialize.params.protocolVersion` (MCP body)",
      goldenPv.initializeBody,
      candidatePv.initializeBody,
    ),
    compareObservation(
      "observations.protocolVersion.headerOnOAuthDiscovery",
      "protocol-version",
      "`MCP-Protocol-Version` header on OAuth discovery",
      goldenPv.headerOnOAuthDiscovery,
      candidatePv.headerOnOAuthDiscovery,
    ),
    compareObservation(
      "observations.protocolVersion.headerOnMcpTraffic",
      "protocol-version",
      "`MCP-Protocol-Version` header on MCP traffic",
      goldenPv.headerOnMcpTraffic,
      candidatePv.headerOnMcpTraffic,
    ),
  ];

  // The split-revision flags are compared explicitly rather than left implicit
  // in the three fields above: an emulator that gets both wires "individually
  // wrong in the same direction" would match on neither field but could still
  // agree on the flag, and vice versa. Surfacing the flag makes the class of
  // bug legible.
  findings.push(
    compareValue(
      "observations.protocolVersion.wiresDisagree",
      "protocol-version",
      "Whether the OAuth wire and the MCP wire carry different protocol versions",
      goldenPv.wiresDisagree,
      candidatePv.wiresDisagree,
    ),
    compareValue(
      "observations.protocolVersion.headerDisagreesWithInitializeBody",
      "protocol-version",
      "Whether the `MCP-Protocol-Version` header disagrees with the `initialize` body",
      goldenPv.headerDisagreesWithInitializeBody,
      candidatePv.headerDisagreesWithInitializeBody,
    ),
  );

  const legs = [
    ...new Set([
      ...Object.keys(goldenPv.headerByLeg),
      ...Object.keys(candidatePv.headerByLeg),
    ]),
  ].sort() as TraceLeg[];

  for (const leg of legs) {
    const goldenObservation = goldenPv.headerByLeg[leg];
    const candidateObservation = candidatePv.headerByLeg[leg];
    if (!goldenObservation || !candidateObservation) continue;
    findings.push(
      compareObservation(
        `observations.protocolVersion.headerByLeg.${leg}`,
        "protocol-version",
        `\`MCP-Protocol-Version\` on the \`${leg}\` leg`,
        goldenObservation,
        candidateObservation,
      ),
    );
  }

  return findings;
}

function resourceIndicatorFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
): TraceDiffFinding[] {
  const goldenRi = golden.observations.resourceIndicator;
  const candidateRi = candidate.observations.resourceIndicator;
  const prmEqualsServer =
    golden.scenario.capabilities.prmResource != null &&
    golden.scenario.capabilities.prmResource.replace(/\/$/, "") ===
      golden.scenario.mcpServerUrl.replace(/\/$/, "");

  const findings = [
    compareObservation(
      "observations.resourceIndicator.onAuthorize",
      "resource-indicator",
      "RFC 8707 `resource` on /authorize",
      goldenRi.onAuthorize,
      candidateRi.onAuthorize,
    ),
    compareObservation(
      "observations.resourceIndicator.onToken",
      "resource-indicator",
      "RFC 8707 `resource` on /token",
      goldenRi.onToken,
      candidateRi.onToken,
    ),
    compareObservation(
      "observations.resourceIndicator.onRefresh",
      "resource-indicator",
      "RFC 8707 `resource` on token refresh",
      goldenRi.onRefresh,
      candidateRi.onRefresh,
    ),
  ];

  const sourceFinding = compareObservation(
    "observations.resourceIndicator.valueSource",
    "resource-indicator",
    "Which URL the `resource` value is taken from",
    goldenRi.valueSource,
    candidateRi.valueSource,
  );

  // When the scenario's PRM `resource` is byte-identical to the MCP server URL,
  // "sends the server URL" and "sends the PRM resource" are indistinguishable on
  // the wire. Reporting a difference there would be an artifact of the test
  // fixture, not a finding about the client — so it is downgraded to a gap with
  // the fixture named as the blocker.
  if (
    sourceFinding.severity === "difference" &&
    prmEqualsServer &&
    new Set([
      observedValue(goldenRi.valueSource),
      observedValue(candidateRi.valueSource),
    ]).size <= 2 &&
    [observedValue(goldenRi.valueSource), observedValue(candidateRi.valueSource)].every(
      (value) => value === "mcp-server-url" || value === "prm-resource",
    )
  ) {
    findings.push({
      ...sourceFinding,
      severity: "gap",
      message:
        "Cannot tell `resource: <server URL>` from `resource: <PRM resource>`: this scenario's PRM document publishes a `resource` identical to the MCP server URL, so the two behaviors are byte-identical on the wire. Capture against a scenario where they differ to settle it.",
    });
  } else {
    findings.push(sourceFinding);
  }

  return findings;
}

function dcrFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
): TraceDiffFinding[] {
  const goldenDcr = golden.observations.dcrIdentity;
  const candidateDcr = candidate.observations.dcrIdentity;

  const findings: TraceDiffFinding[] = [
    compareObservation(
      "observations.dcrIdentity.clientName",
      "dcr-body",
      "DCR `client_name`",
      goldenDcr.clientName,
      candidateDcr.clientName,
    ),
    compareObservation(
      "observations.dcrIdentity.redirectUris",
      "dcr-body",
      "DCR `redirect_uris` (loopback ports placeheld)",
      goldenDcr.redirectUris,
      candidateDcr.redirectUris,
    ),
    compareObservation(
      "observations.dcrIdentity.grantTypes",
      "dcr-body",
      "DCR `grant_types`",
      goldenDcr.grantTypes,
      candidateDcr.grantTypes,
    ),
    compareObservation(
      "observations.dcrIdentity.responseTypes",
      "dcr-body",
      "DCR `response_types`",
      goldenDcr.responseTypes,
      candidateDcr.responseTypes,
    ),
    compareObservation(
      "observations.dcrIdentity.tokenEndpointAuthMethod",
      "dcr-body",
      "DCR `token_endpoint_auth_method`",
      goldenDcr.tokenEndpointAuthMethod,
      candidateDcr.tokenEndpointAuthMethod,
    ),
    compareObservation(
      "observations.dcrIdentity.scope",
      "dcr-body",
      "DCR `scope`",
      goldenDcr.scope,
      candidateDcr.scope,
    ),
    compareObservation(
      "observations.dcrIdentity.extraFields",
      "dcr-body",
      "DCR body fields this schema does not model",
      goldenDcr.extraFields,
      candidateDcr.extraFields,
    ),
  ];

  // Loopback ports are context, never a difference: two runs of the SAME client
  // legitimately differ here, so a `difference` severity would make every diff
  // fail for a reason nobody can fix.
  const ports = compareObservation(
    "observations.dcrIdentity.observedLoopbackPorts",
    "dcr-body",
    "Observed loopback redirect ports",
    goldenDcr.observedLoopbackPorts,
    candidateDcr.observedLoopbackPorts,
  );
  findings.push({
    ...ports,
    severity: ports.severity === "difference" ? "match" : ports.severity,
    message:
      ports.severity === "difference"
        ? "Observed loopback redirect ports differ. This is recorded as context, not a parity difference — ephemeral ports vary between runs of the same client. The port RANGE is still a per-host fact worth reading."
        : ports.message,
  });

  return findings;
}

function pkceAndUaFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
): TraceDiffFinding[] {
  const findings: TraceDiffFinding[] = [
    compareObservation(
      "observations.pkce.challengeMethod",
      "pkce",
      "PKCE `code_challenge_method`",
      golden.observations.pkce.challengeMethod,
      candidate.observations.pkce.challengeMethod,
    ),
    compareObservation(
      "observations.pkce.challengeLength",
      "pkce",
      "PKCE `code_challenge` length",
      golden.observations.pkce.challengeLength,
      candidate.observations.pkce.challengeLength,
    ),
    compareObservation(
      "observations.pkce.verifierSentOnToken",
      "pkce",
      "PKCE `code_verifier` present on /token",
      golden.observations.pkce.verifierSentOnToken,
      candidate.observations.pkce.verifierSentOnToken,
    ),
  ];

  const legs = [
    ...new Set([
      ...Object.keys(golden.observations.userAgent.byLeg),
      ...Object.keys(candidate.observations.userAgent.byLeg),
    ]),
  ].sort() as TraceLeg[];

  for (const leg of legs) {
    const goldenUa = golden.observations.userAgent.byLeg[leg];
    const candidateUa = candidate.observations.userAgent.byLeg[leg];
    if (!goldenUa || !candidateUa) continue;
    findings.push(
      compareObservation(
        `observations.userAgent.byLeg.${leg}`,
        "user-agent",
        `\`User-Agent\` on the \`${leg}\` leg`,
        goldenUa,
        candidateUa,
      ),
    );
  }

  findings.push(
    compareValue(
      "observations.userAgent.consistent",
      "user-agent",
      "Whether one `User-Agent` is used across every captured leg",
      golden.observations.userAgent.consistent,
      candidate.observations.userAgent.consistent,
    ),
  );

  return findings;
}

// ── Entry point ──────────────────────────────────────────────────────────

function summarize(counts: Record<TraceDiffSeverity, number>): string {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (counts.incomparable > 0) {
    return `incomparable: ${counts.incomparable} blocking issue(s) — no field-level comparison was attempted`;
  }
  const parts = [
    `${counts.difference} difference(s)`,
    `${counts.gap} gap(s)`,
    `${counts.match} match(es)`,
  ];
  return `${parts.join(", ")} across ${total} comparison(s)`;
}

/**
 * Diff a candidate trace against a golden one.
 *
 * `parity` is true only when there are zero `difference` and zero
 * `incomparable` findings. Gaps do not fail parity — an unobserved leg is not
 * evidence of divergence — but they are counted separately, and a caller that
 * needs full coverage should assert `counts.gap === 0` too. That split is the
 * point: "the emulator matches on everything we could see, and here is exactly
 * what we could not see" is a more honest result than a single boolean.
 */
export function diffGoldenTraces(
  golden: GoldenTrace,
  candidate: GoldenTrace,
  options: TraceDiffOptions = {},
): TraceDiffResult {
  const mode =
    options.mode ??
    (golden.subject.kind === candidate.subject.kind ? "drift" : "parity");

  const gates = gateFindings(golden, candidate);
  const findings: TraceDiffFinding[] = [...gates];

  if (!gates.some((finding) => finding.severity === "incomparable")) {
    findings.push(
      ...subjectFindings(golden, candidate, mode),
      ...orderingFindings(golden, candidate),
      ...endpointFindings(golden, candidate),
      ...perLegFindings(golden, candidate, options),
      ...protocolVersionFindings(golden, candidate),
      ...resourceIndicatorFindings(golden, candidate),
      ...dcrFindings(golden, candidate),
      ...pkceAndUaFindings(golden, candidate),
    );
  }

  const counts: Record<TraceDiffSeverity, number> = {
    match: 0,
    difference: 0,
    gap: 0,
    incomparable: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;

  // Order the report by severity so the actionable findings are not buried
  // under a hundred matches.
  const severityRank: Record<TraceDiffSeverity, number> = {
    incomparable: 0,
    difference: 1,
    gap: 2,
    match: 3,
  };
  const sorted = [...findings].sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      left.path.localeCompare(right.path),
  );

  return {
    parity: counts.difference === 0 && counts.incomparable === 0,
    goldenTraceId: golden.traceId,
    candidateTraceId: candidate.traceId,
    counts,
    findings: sorted,
    summary: summarize(counts),
  };
}
