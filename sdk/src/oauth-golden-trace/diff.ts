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
 *
 *     The mode also decides WHAT THE TWO SIDES ARE CALLED. Every message below is
 *     phrased through {@link DIFF_LABELS}, and the resolved pair travels out on
 *     `TraceDiffResult.labels` so the renderer cannot contradict it. Hardcoding
 *     "real host" / "emulator" made a drift diff of two real-host captures blame
 *     an emulator that was never involved.
 */

import { notObserved, observedValue } from "./types.js";
import type {
  GoldenTrace,
  Observation,
  TraceDiffDimension,
  TraceDiffFinding,
  TraceDiffLabels,
  TraceDiffMode,
  TraceDiffResult,
  TraceDiffSeverity,
  TraceExchange,
  TraceLeg,
  TraceScenarioCapabilities,
} from "./types.js";

export type { TraceDiffMode } from "./types.js";

/**
 * What each side is called, per mode. The one source for the differ's prose.
 *
 * `parity` keeps its concrete wording: there the golden side IS a real host and
 * the candidate IS our emulator, and naming them is what makes a difference
 * actionable. `drift` compares the same subject captured twice, where no emulator
 * is involved on either side.
 */
const DIFF_LABELS: Record<TraceDiffMode, TraceDiffLabels> = {
  parity: { golden: "real host", candidate: "emulator" },
  drift: { golden: "baseline capture", candidate: "re-capture" },
};

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

/**
 * Headers added by the HTTP stack, not chosen by the client.
 *
 * These have to be excluded when the two traces were recorded from DIFFERENT
 * VANTAGE POINTS, because the two vantage points genuinely see different things:
 *
 *   - a CLIENT-side capture (`via: "mcpjam-emulator"`) records the headers the
 *     client CODE set, before undici/the browser appends its own;
 *   - a SERVER-side capture (`via: "har"` from our recording server, or a proxy)
 *     records what ARRIVED, including everything the stack added in transit.
 *
 * So `host`, `content-length` and `accept-encoding` show up on the server-side
 * trace and are missing from the client-side one for every request, in both a
 * conformant and a broken emulator. Reporting them would add a fixed tax of false
 * differences to every cross-vantage diff and teach a reviewer to skim past the
 * header dimension — which is where the real findings live.
 *
 * They are NOT excluded when both traces share a vantage point: two server-side
 * captures genuinely can differ here, and that would be a real finding.
 */
const TRANSPORT_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
  "via",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-dest",
]);

/** Client-side or server-side? Determined by how the trace was captured. */
function vantageOf(trace: GoldenTrace): "client" | "server" {
  return trace.capture.method.via === "mcpjam-emulator" ? "client" : "server";
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
  /** Defaults to the `parity` pair, which is what a bare two-trace diff means. */
  labels: TraceDiffLabels = DIFF_LABELS.parity,
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
      message: `${label}: the ${labels.golden} sends nothing, but the ${labels.candidate} sends a value.`,
    };
  }

  if (candidate.state === "absent") {
    return {
      ...base,
      severity: "difference",
      message: `${label}: the ${labels.golden} sends a value, but the ${labels.candidate} sends nothing.`,
    };
  }

  return equal(golden.value, candidate.value)
    ? { ...base, severity: "match", message: `${label} matches.` }
    : {
        ...base,
        severity: "difference",
        message: `${label} differs between the ${labels.golden} and the ${labels.candidate}.`,
      };
}

/**
 * Read a per-leg observation map, materializing a MISSING key as `not-observed`.
 *
 * `headerByLeg` / `userAgent.byLeg` carry a key only for legs the trace captured,
 * so a key one side lacks means precisely "we never watched that leg" — the third
 * state, not a fourth silent one. Skipping the comparison instead (which is what
 * this replaced) discarded exactly the case a reviewer most wants named: one trace
 * observed a header on a leg the other never recorded. Routed through
 * {@link compareObservation}, that now lands as a `gap` in the same wording as
 * every other asymmetry.
 */
function observationForLeg<T>(
  byLeg: Partial<Record<TraceLeg, Observation<T>>>,
  leg: TraceLeg,
  what: string,
): Observation<T> {
  return (
    byLeg[leg] ??
    notObserved(
      `this trace records no \`${leg}\` leg, so ${what} on it was never observed`,
    )
  );
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
  labels: TraceDiffLabels,
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
        labels,
      ),
      compareObservation(
        "subject.oauthImplementation",
        "subject",
        "Resolved OAuth implementation",
        golden.subject.oauthImplementation,
        candidate.subject.oauthImplementation,
        labels,
      ),
    );
  }

  return findings;
}

// ── Wire-level comparisons ───────────────────────────────────────────────

/**
 * EVERY occurrence of a leg, in wire order.
 *
 * Not just the first. A leg can repeat — a retried token request, a discovery
 * ladder that walks two rungs of the same leg — and a second attempt that adds or
 * changes a param is exactly the kind of divergence the acceptance surface has to
 * cover. Comparing only occurrence 0 reported parity for it.
 */
function exchangesForLeg(
  wire: readonly TraceExchange[],
  leg: TraceLeg,
): TraceExchange[] {
  return wire.filter((exchange) => exchange.leg === leg);
}

/**
 * Was the GOLDEN capture simply cut short?
 *
 * True when the golden trace's leg sequence is a strict prefix of the candidate's.
 * That relationship is the signature of a TRUNCATED capture — a real-host recording
 * that stopped because the operator could not drive the browser leg, or the proxy
 * was detached — not of a client that behaves differently.
 *
 * It matters because the alternative is to report every leg past the truncation
 * point as "the emulator hit an endpoint the real host did not", which is false:
 * we did not observe the real host declining to hit it, we stopped watching. Those
 * become gaps instead.
 *
 * Deliberately strict about the PREFIX: if the sequences diverge anywhere inside
 * the overlap, this is real divergence and nothing is downgraded.
 */
function goldenIsTruncatedPrefix(
  golden: GoldenTrace,
  candidate: GoldenTrace,
): boolean {
  const goldenSequence = golden.wire.map((exchange) => exchange.leg);
  const candidateSequence = candidate.wire.map((exchange) => exchange.leg);
  // An EMPTY golden wire satisfies the prefix test vacuously, and calling that
  // "truncated" downgrades the entire diff to gaps and renders a message about
  // stopping after `undefined`. A capture with no exchanges at all is a broken
  // artifact, not a capture that stopped early, and the caller should see it as
  // real divergence.
  if (goldenSequence.length === 0) return false;
  if (goldenSequence.length >= candidateSequence.length) return false;
  return goldenSequence.every((leg, index) => leg === candidateSequence[index]);
}

function orderingFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
  truncated: boolean,
  labels: TraceDiffLabels,
): TraceDiffFinding[] {
  const goldenSequence = golden.wire.map((exchange) => exchange.leg);
  const candidateSequence = candidate.wire.map((exchange) => exchange.leg);

  if (truncated) {
    const extra = candidateSequence.slice(goldenSequence.length);
    return [
      {
        path: "observations.legOrder",
        dimension: "request-ordering",
        severity: "gap",
        message: `Ordering agrees for every stage the golden trace captured, but that capture stopped after \`${goldenSequence[goldenSequence.length - 1]}\`. The ${labels.candidate} continued through ${extra.map((leg) => `\`${leg}\``).join(", ")}, which the ${labels.golden} was never observed either doing or not doing. Complete the golden capture to compare these.`,
        golden: goldenSequence,
        candidate: candidateSequence,
      },
    ];
  }

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
  truncated: boolean,
  labels: TraceDiffLabels,
): TraceDiffFinding[] {
  const findings: TraceDiffFinding[] = [];
  const goldenSet = golden.observations.endpointsHit;
  const candidateSet = candidate.observations.endpointsHit;

  const missing = goldenSet.filter((endpoint) => !candidateSet.includes(endpoint));
  const extra = candidateSet.filter((endpoint) => !goldenSet.includes(endpoint));

  // A truncated golden capture cannot support "the real host does not hit this".
  // Tracked in a flag rather than left implicit in the early return: when the
  // golden side is ALSO missing endpoints the early return does not fire, and the
  // extras excused as a gap here were then reported a second time as a difference
  // below — double-counted, and failing parity on the very truncation artifact
  // this branch exists to neutralize.
  const extraIsBeyondTruncation = truncated && extra.length > 0;
  if (extraIsBeyondTruncation) {
    findings.push({
      path: "observations.endpointsHit",
      dimension: "endpoints",
      severity: "gap",
      message: `The ${labels.candidate} hit ${extra.length} endpoint(s) beyond where the golden capture stopped. Not a difference: the ${labels.golden} was never observed declining to hit them.`,
      golden: null,
      candidate: extra,
    });
    if (missing.length === 0) {
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
  }

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
    // Missing endpoints are reported independently of the truncation flag: the
    // golden side DID hit them, so the candidate not doing so is a real finding
    // whether or not the golden capture also stopped early.
    if (missing.length > 0) {
      findings.push({
        path: "observations.endpointsHit",
        dimension: "endpoints",
        severity: "difference",
        message: `The ${labels.candidate} never hit ${missing.length} endpoint(s) the ${labels.golden} did.`,
        golden: missing,
        candidate: null,
      });
    }
    if (extra.length > 0 && !extraIsBeyondTruncation) {
      findings.push({
        path: "observations.endpointsHit",
        dimension: "endpoints",
        severity: "difference",
        message: `The ${labels.candidate} hit ${extra.length} endpoint(s) the ${labels.golden} did not.`,
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
 * Compare ONE corresponding pair of requests: method, params, headers, form body.
 *
 * `slot` is the path segment identifying the pair — the bare leg name for the
 * first occurrence, `leg#N` for a retry — and `occurrence` is the matching prose
 * suffix. Occurrence 0 therefore produces exactly the paths and messages a
 * single-request leg always produced, which is what keeps the common case from
 * gaining a wall of new findings.
 */
function exchangePairFindings(input: {
  leg: TraceLeg;
  slot: string;
  occurrence: string;
  golden: TraceExchange;
  candidate: TraceExchange;
  ignoreHeaders: Set<string>;
  labels: TraceDiffLabels;
}): TraceDiffFinding[] {
  const { leg, slot, occurrence, golden, candidate, ignoreHeaders, labels } = input;
  const findings: TraceDiffFinding[] = [];
  const at = `\`${leg}\`${occurrence}`;

  findings.push(
    compareValue(
      `wire[leg=${slot}].request.method`,
      "params",
      `${at} HTTP method`,
      golden.request.method,
      candidate.request.method,
    ),
  );

  // ── params ──
  const goldenQuery = golden.request.query ?? {};
  const candidateQuery = candidate.request.query ?? {};
  const queryKeys = [
    ...new Set([...Object.keys(goldenQuery), ...Object.keys(candidateQuery)]),
  ].sort();

  for (const key of queryKeys) {
    const inGolden = key in goldenQuery;
    const inCandidate = key in candidateQuery;
    const path = `wire[leg=${slot}].request.query.${key}`;

    if (!inGolden || !inCandidate) {
      findings.push({
        path,
        dimension: "params",
        severity: "difference",
        message: inGolden
          ? `${at} is missing the \`${key}\` param the ${labels.golden} sends.`
          : `${at} carries a \`${key}\` param the ${labels.golden} does not send.`,
        golden: goldenQuery[key] ?? "<absent>",
        candidate: candidateQuery[key] ?? "<absent>",
      });
      continue;
    }

    findings.push(
      compareValue(
        path,
        "params",
        `${at} param \`${key}\``,
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
    golden.request.headersObserved === false ||
    candidate.request.headersObserved === false
  ) {
    const which =
      golden.request.headersObserved === false &&
      candidate.request.headersObserved === false
        ? "neither side"
        : golden.request.headersObserved === false
          ? "the golden trace"
          : "the candidate trace";
    findings.push({
      path: `wire[leg=${slot}].request.headers`,
      dimension: "headers",
      severity: "gap",
      message: `${at} request headers are not comparable: ${which} intercepted them (the request was reconstructed from a URL the client handed to a browser). Capture this leg through a proxy to close it.`,
      golden: golden.request.headersObserved === false ? "<not intercepted>" : Object.keys(golden.request.headers),
      candidate: candidate.request.headersObserved === false ? "<not intercepted>" : Object.keys(candidate.request.headers),
    });
  } else {
    const goldenHeaders = golden.request.headers;
    const candidateHeaders = candidate.request.headers;
    // Filtered on the LOWERCASED key while the original is kept for lookup and
    // sorting: trace header names are lowercased by convention, not by the type,
    // so a hand-written or third-party-HAR-derived trace can carry `Host` and
    // would slip past a set that only ever holds lowercase entries.
    const headerKeys = [
      ...new Set([...Object.keys(goldenHeaders), ...Object.keys(candidateHeaders)]),
    ]
      .filter((key) => !ignoreHeaders.has(key.toLowerCase()))
      .sort();

    for (const key of headerKeys) {
      const inGolden = key in goldenHeaders;
      const inCandidate = key in candidateHeaders;
      const path = `wire[leg=${slot}].request.headers.${key}`;

      if (!inGolden || !inCandidate) {
        findings.push({
          path,
          dimension: "headers",
          severity: "difference",
          message: inGolden
            ? `${at} is missing the \`${key}\` header the ${labels.golden} sends.`
            : `${at} carries a \`${key}\` header the ${labels.golden} does not send.`,
          golden: goldenHeaders[key] ?? "<absent>",
          candidate: candidateHeaders[key] ?? "<absent>",
        });
        continue;
      }

      findings.push(
        compareValue(
          path,
          "headers",
          `${at} header \`${key}\``,
          goldenHeaders[key],
          candidateHeaders[key],
        ),
      );
    }
  }

  // ── form body fields (token / refresh legs) ──
  const goldenBody = golden.request.body;
  const candidateBody = candidate.request.body;
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
      const path = `wire[leg=${slot}].request.body.${key}`;

      if (!inGolden || !inCandidate) {
        findings.push({
          path,
          dimension: "params",
          severity: "difference",
          message: inGolden
            ? `${at} body is missing the \`${key}\` field the ${labels.golden} sends.`
            : `${at} body carries a \`${key}\` field the ${labels.golden} does not send.`,
          golden: goldenBody.fields[key] ?? "<absent>",
          candidate: candidateBody.fields[key] ?? "<absent>",
        });
        continue;
      }

      findings.push(
        compareValue(
          path,
          "params",
          `${at} body field \`${key}\``,
          goldenBody.fields[key],
          candidateBody.fields[key],
        ),
      );
    }
  } else if (!equal(goldenBody?.encoding, candidateBody?.encoding)) {
    findings.push({
      path: `wire[leg=${slot}].request.body.encoding`,
      dimension: "params",
      severity: "difference",
      message: `${at} request body encoding differs.`,
      golden: goldenBody?.encoding ?? "<no body>",
      candidate: candidateBody?.encoding ?? "<no body>",
    });
  }

  return findings;
}

/**
 * Per-leg parameter and header comparison, over EVERY occurrence of each leg.
 *
 * Only legs BOTH sides captured are compared field by field; a leg only one side
 * has is a `gap`, since we cannot tell an emulator bug from a capture that
 * stopped early (a real host capture often stops at the consent screen).
 *
 * Occurrences are matched BY POSITION within the leg. A retry belongs inside the
 * acceptance surface — a second `/token` attempt that adds a param, or a DCR retry
 * that changes `client_name`, is a real divergence — and comparing only the first
 * occurrence reported parity for it. A count mismatch is reported ONCE and the
 * aligned prefix is still compared, rather than silently pairing occurrence 2 of
 * one side against occurrence 1 of the other.
 */
function perLegFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
  options: TraceDiffOptions,
  truncated: boolean,
  labels: TraceDiffLabels,
): TraceDiffFinding[] {
  const findings: TraceDiffFinding[] = [];
  const ignoreHeaders = new Set(
    (options.ignoreHeaders ?? []).map((header) => header.toLowerCase()),
  );
  // Cross-vantage diffs cannot compare stack-added headers. See TRANSPORT_HEADERS.
  const crossVantage = vantageOf(golden) !== vantageOf(candidate);
  if (crossVantage) {
    for (const header of TRANSPORT_HEADERS) ignoreHeaders.add(header);
  }

  const legs: TraceLeg[] = [];
  for (const leg of [
    ...golden.observations.legOrder,
    ...candidate.observations.legOrder,
  ]) {
    if (!legs.includes(leg)) legs.push(leg);
  }

  for (const leg of legs) {
    const goldenExchanges = exchangesForLeg(golden.wire, leg);
    const candidateExchanges = exchangesForLeg(candidate.wire, leg);

    if (goldenExchanges.length === 0 || candidateExchanges.length === 0) {
      const which =
        goldenExchanges.length === 0 ? "the golden trace" : "the candidate trace";
      findings.push({
        path: `wire[leg=${leg}]`,
        dimension: "params",
        severity: "gap",
        message: `The \`${leg}\` leg is only present on one side (${which} lacks it), so its params and headers are not comparable.`,
        golden: goldenExchanges.length > 0 ? "captured" : "<not observed>",
        candidate: candidateExchanges.length > 0 ? "captured" : "<not observed>",
      });
      continue;
    }

    const paired = Math.min(goldenExchanges.length, candidateExchanges.length);
    if (goldenExchanges.length !== candidateExchanges.length) {
      // A truncated golden capture is the one case where a short count is OUR
      // limitation rather than the client's behavior, so it degrades to a gap for
      // the same reason the endpoint and ordering dimensions do.
      findings.push({
        path: `wire[leg=${leg}].occurrences`,
        dimension: "request-ordering",
        severity: truncated ? "gap" : "difference",
        message: truncated
          ? `The \`${leg}\` leg was sent ${goldenExchanges.length}× by the ${labels.golden} and ${candidateExchanges.length}× by the ${labels.candidate}, but the golden capture stopped early, so the missing attempts were never observed either happening or not. Only the first ${paired} could be compared field by field.`
          : `The \`${leg}\` leg was sent ${goldenExchanges.length}× by the ${labels.golden} and ${candidateExchanges.length}× by the ${labels.candidate}. Only the first ${paired} occurrence(s) could be paired up and compared field by field.`,
        golden: goldenExchanges.length,
        candidate: candidateExchanges.length,
      });
    }

    for (let index = 0; index < paired; index += 1) {
      findings.push(
        ...exchangePairFindings({
          leg,
          slot: index === 0 ? leg : `${leg}#${index}`,
          occurrence: index === 0 ? "" : ` (occurrence ${index + 1})`,
          golden: goldenExchanges[index],
          candidate: candidateExchanges[index],
          ignoreHeaders,
          labels,
        }),
      );
    }
  }

  return findings;
}

// ── Observation-level comparisons ────────────────────────────────────────

function protocolVersionFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
  labels: TraceDiffLabels,
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
      labels,
    ),
    compareObservation(
      "observations.protocolVersion.headerOnOAuthDiscovery",
      "protocol-version",
      "`MCP-Protocol-Version` header on OAuth discovery",
      goldenPv.headerOnOAuthDiscovery,
      candidatePv.headerOnOAuthDiscovery,
      labels,
    ),
    compareObservation(
      "observations.protocolVersion.headerOnMcpTraffic",
      "protocol-version",
      "`MCP-Protocol-Version` header on MCP traffic",
      goldenPv.headerOnMcpTraffic,
      candidatePv.headerOnMcpTraffic,
      labels,
    ),
  ];

  // The split-revision flags are compared explicitly rather than left implicit
  // in the three fields above: an emulator that gets both wires "individually
  // wrong in the same direction" would match on neither field but could still
  // agree on the flag, and vice versa. Surfacing the flag makes the class of
  // bug legible.
  //
  // Routed through `compareObservation`, not `compareValue`: both are tri-state,
  // so a trace that captured only one wire yields a `gap` here instead of a
  // fabricated difference against a trace that captured both.
  findings.push(
    compareObservation(
      "observations.protocolVersion.wiresDisagree",
      "protocol-version",
      "Whether the OAuth wire and the MCP wire carry different protocol versions",
      goldenPv.wiresDisagree,
      candidatePv.wiresDisagree,
      labels,
    ),
    compareObservation(
      "observations.protocolVersion.headerDisagreesWithInitializeBody",
      "protocol-version",
      "Whether the `MCP-Protocol-Version` header disagrees with the `initialize` body",
      goldenPv.headerDisagreesWithInitializeBody,
      candidatePv.headerDisagreesWithInitializeBody,
      labels,
    ),
  );

  const legs = [
    ...new Set([
      ...Object.keys(goldenPv.headerByLeg),
      ...Object.keys(candidatePv.headerByLeg),
    ]),
  ].sort() as TraceLeg[];

  for (const leg of legs) {
    findings.push(
      compareObservation(
        `observations.protocolVersion.headerByLeg.${leg}`,
        "protocol-version",
        `\`MCP-Protocol-Version\` on the \`${leg}\` leg`,
        observationForLeg(goldenPv.headerByLeg, leg, "`MCP-Protocol-Version`"),
        observationForLeg(candidatePv.headerByLeg, leg, "`MCP-Protocol-Version`"),
        labels,
      ),
    );
  }

  return findings;
}

function resourceIndicatorFindings(
  golden: GoldenTrace,
  candidate: GoldenTrace,
  labels: TraceDiffLabels,
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
      labels,
    ),
    compareObservation(
      "observations.resourceIndicator.onToken",
      "resource-indicator",
      "RFC 8707 `resource` on /token",
      goldenRi.onToken,
      candidateRi.onToken,
      labels,
    ),
    compareObservation(
      "observations.resourceIndicator.onRefresh",
      "resource-indicator",
      "RFC 8707 `resource` on token refresh",
      goldenRi.onRefresh,
      candidateRi.onRefresh,
      labels,
    ),
  ];

  const sourceFinding = compareObservation(
    "observations.resourceIndicator.valueSource",
    "resource-indicator",
    "Which URL the `resource` value is taken from",
    goldenRi.valueSource,
    candidateRi.valueSource,
    labels,
  );

  // When the scenario's PRM `resource` is byte-identical to the MCP server URL,
  // "sends the server URL" and "sends the PRM resource" are indistinguishable on
  // the wire. Reporting a difference there would be an artifact of the test
  // fixture, not a finding about the client — so it is downgraded to a gap with
  // the fixture named as the blocker.
  if (
    sourceFinding.severity === "difference" &&
    prmEqualsServer &&
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
  labels: TraceDiffLabels,
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
      labels,
    ),
    compareObservation(
      "observations.dcrIdentity.redirectUris",
      "dcr-body",
      "DCR `redirect_uris` (loopback ports placeheld)",
      goldenDcr.redirectUris,
      candidateDcr.redirectUris,
      labels,
    ),
    compareObservation(
      "observations.dcrIdentity.grantTypes",
      "dcr-body",
      "DCR `grant_types`",
      goldenDcr.grantTypes,
      candidateDcr.grantTypes,
      labels,
    ),
    compareObservation(
      "observations.dcrIdentity.responseTypes",
      "dcr-body",
      "DCR `response_types`",
      goldenDcr.responseTypes,
      candidateDcr.responseTypes,
      labels,
    ),
    compareObservation(
      "observations.dcrIdentity.tokenEndpointAuthMethod",
      "dcr-body",
      "DCR `token_endpoint_auth_method`",
      goldenDcr.tokenEndpointAuthMethod,
      candidateDcr.tokenEndpointAuthMethod,
      labels,
    ),
    compareObservation(
      "observations.dcrIdentity.scope",
      "dcr-body",
      "DCR `scope`",
      goldenDcr.scope,
      candidateDcr.scope,
      labels,
    ),
    // Names AND values, so two bodies differing only in the VALUE of an unmodelled
    // field are a difference rather than reported parity.
    compareObservation(
      "observations.dcrIdentity.extraFields",
      "dcr-body",
      "DCR body fields this schema does not model (name and value)",
      goldenDcr.extraFields,
      candidateDcr.extraFields,
      labels,
    ),
    // A field sent with the wrong JSON type is a real behavioral difference, and
    // one that reporting the field as `absent` used to hide completely.
    compareObservation(
      "observations.dcrIdentity.malformedFields",
      "dcr-body",
      "DCR body fields sent with the wrong JSON type",
      goldenDcr.malformedFields,
      candidateDcr.malformedFields,
      labels,
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
    labels,
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
  labels: TraceDiffLabels,
): TraceDiffFinding[] {
  const findings: TraceDiffFinding[] = [
    compareObservation(
      "observations.pkce.challengeMethod",
      "pkce",
      "PKCE `code_challenge_method`",
      golden.observations.pkce.challengeMethod,
      candidate.observations.pkce.challengeMethod,
      labels,
    ),
    compareObservation(
      "observations.pkce.challengeLength",
      "pkce",
      "PKCE `code_challenge` length",
      golden.observations.pkce.challengeLength,
      candidate.observations.pkce.challengeLength,
      labels,
    ),
    compareObservation(
      "observations.pkce.verifierSentOnToken",
      "pkce",
      "PKCE `code_verifier` present on /token",
      golden.observations.pkce.verifierSentOnToken,
      candidate.observations.pkce.verifierSentOnToken,
      labels,
    ),
  ];

  const legs = [
    ...new Set([
      ...Object.keys(golden.observations.userAgent.byLeg),
      ...Object.keys(candidate.observations.userAgent.byLeg),
    ]),
  ].sort() as TraceLeg[];

  for (const leg of legs) {
    findings.push(
      compareObservation(
        `observations.userAgent.byLeg.${leg}`,
        "user-agent",
        `\`User-Agent\` on the \`${leg}\` leg`,
        observationForLeg(golden.observations.userAgent.byLeg, leg, "`User-Agent`"),
        observationForLeg(candidate.observations.userAgent.byLeg, leg, "`User-Agent`"),
        labels,
      ),
    );
  }

  findings.push(
    // Tri-state, so a trace with a reconstructed leg yields a gap here rather
    // than a fabricated user-agent-consistency difference.
    compareObservation(
      "observations.userAgent.consistent",
      "user-agent",
      "Whether one `User-Agent` is used across every captured leg",
      golden.observations.userAgent.consistent,
      candidate.observations.userAgent.consistent,
      labels,
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
  // Resolved once and threaded through every finding-producing function, so the
  // report cannot name one thing in a message and another in a heading.
  const labels = DIFF_LABELS[mode];

  const gates = gateFindings(golden, candidate);
  const findings: TraceDiffFinding[] = [...gates];

  if (!gates.some((finding) => finding.severity === "incomparable")) {
    // Computed once and threaded through, so the ordering, endpoint and per-leg
    // dimensions agree about whether the golden capture was cut short.
    const truncated = goldenIsTruncatedPrefix(golden, candidate);
    findings.push(
      ...subjectFindings(golden, candidate, mode, labels),
      ...orderingFindings(golden, candidate, truncated, labels),
      ...endpointFindings(golden, candidate, truncated, labels),
      ...perLegFindings(golden, candidate, options, truncated, labels),
      ...protocolVersionFindings(golden, candidate, labels),
      ...resourceIndicatorFindings(golden, candidate, labels),
      ...dcrFindings(golden, candidate, labels),
      ...pkceAndUaFindings(golden, candidate, labels),
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
    mode,
    labels,
    counts,
    findings: sorted,
    summary: summarize(counts),
  };
}
