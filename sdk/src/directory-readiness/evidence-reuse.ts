/**
 * Whether an existing suite result may be reused as readiness evidence.
 *
 * WHY READINESS COMPOSES AT ALL. A conformance run has already dialled the
 * server, read its tools, fetched its widget resources and graded them.
 * Re-observing all of that inside a readiness run would double the traffic to
 * somebody else's server and — worse — let the two runs DISAGREE about it. The
 * first question anyone asks about a disagreement is which one to believe, and
 * there is no good answer.
 *
 * WHY IT IS GUARDED. Reuse is only honest when the earlier run looked at the
 * SAME THING. Three ways it silently is not:
 *
 *   - a different target. Two servers in one project, one URL typed slightly
 *     differently, a staging host: the result renders identically and grades
 *     the wrong server.
 *   - a different config. A suite run with a bearer token sees tools an
 *     anonymous run does not, so its listing is not the listing a directory
 *     reviewer would see.
 *   - an incomplete source. A run that could not finish carries checks that
 *     never ran, and adopting its evidence turns "nobody looked" into
 *     "everything was fine".
 *
 * Every refusal here leaves the readiness lane exactly as it would have been
 * with no source at all: `not-evaluated`, with the input named. That is the
 * whole design — an incompatible source must degrade to MISSING, never to a
 * pass and never to a failure.
 *
 * Pure data reasoning. No transport.
 */

/** What a reused result was, and what it looked at. */
export interface AttributableEvidenceSource {
  /** Suite kind, e.g. `"apps-conformance"`. Names the provenance in reports. */
  kind: string;
  /**
   * The source run's own id, when the caller has one.
   *
   * Carried so a finding can say WHICH run it rests on. A readiness report
   * that cites "the apps suite" without saying which run is unauditable the
   * moment a second run exists.
   */
  runId?: string;
  /** The target the source run graded, exactly as that run named it. */
  target: string;
  /**
   * A digest of the configuration the source run used — headers, auth,
   * selected checks. Opaque here: this module compares it, it does not
   * compute it, because what belongs in a config fingerprint is the caller's
   * question and a shared guess would be wrong for every caller.
   */
  configFingerprint?: string;
  /** Whether the source run itself finished everything it selected. */
  complete: boolean;
}

/** What the readiness run needs the source to have looked at. */
export interface EvidenceReuseExpectation {
  target: string;
  /**
   * The fingerprint the readiness run is grading under.
   *
   * When BOTH sides carry one they must match. When either side has none, the
   * comparison is skipped rather than failed: a caller that does not fingerprint
   * its configs is not thereby claiming they differ, and refusing every such
   * reuse would make the whole mechanism unusable for the callers most likely
   * to need it.
   */
  configFingerprint?: string;
}

export const EVIDENCE_REUSE_REFUSALS = [
  "target_mismatch",
  "config_mismatch",
  "source_incomplete",
] as const;

export type EvidenceReuseRefusal = (typeof EVIDENCE_REUSE_REFUSALS)[number];

export type EvidenceReuse<Evidence> =
  | {
      ok: true;
      evidence: Evidence;
      /**
       * The provenance string a finding's `derivedFrom` carries, e.g.
       * `"apps-conformance:run_123"`.
       */
      sourceRef: string;
    }
  | { ok: false; refusal: EvidenceReuseRefusal; detail: string };

/**
 * Compare two target URLs the way a reader would.
 *
 * Scheme, host, port and path decide; a trailing slash, a case difference in
 * the host, and the ORDER of query parameters do not. Query parameters
 * themselves are compared, because an MCP endpoint that keys on one is a
 * different endpoint.
 *
 * An unparseable URL falls back to a trimmed string comparison rather than
 * being treated as a mismatch: two callers that both typed the same malformed
 * thing looked at the same thing.
 */
export function sameReadinessTarget(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    try {
      const url = new URL(value);
      url.hash = "";
      url.searchParams.sort();
      const path = url.pathname.replace(/\/+$/, "");
      return `${url.protocol}//${url.host}${path}${url.search}`.toLowerCase();
    } catch {
      return value.trim().toLowerCase();
    }
  };
  return normalize(left) === normalize(right);
}

/**
 * Decide whether a source may be adapted, in the order a reader would ask.
 *
 * Target first: an answer about the wrong server is wrong whatever else is
 * true of it, and reporting "the source run was incomplete" for a result that
 * graded a different host sends the reader to fix the wrong thing.
 */
export function checkEvidenceReuse(
  source: AttributableEvidenceSource,
  expectation: EvidenceReuseExpectation,
):
  | { ok: true; sourceRef: string }
  | { ok: false; refusal: EvidenceReuseRefusal; detail: string } {
  if (!sameReadinessTarget(source.target, expectation.target)) {
    return {
      ok: false,
      refusal: "target_mismatch",
      detail: `the ${source.kind} result graded ${source.target}, not ${expectation.target}`,
    };
  }

  if (
    source.configFingerprint !== undefined &&
    expectation.configFingerprint !== undefined &&
    source.configFingerprint !== expectation.configFingerprint
  ) {
    return {
      ok: false,
      refusal: "config_mismatch",
      detail: `the ${source.kind} result was produced under a different configuration`,
    };
  }

  if (!source.complete) {
    return {
      ok: false,
      refusal: "source_incomplete",
      detail: `the ${source.kind} result did not finish, so its evidence would report unlooked-at checks as clean`,
    };
  }

  return {
    ok: true,
    sourceRef: source.runId ? `${source.kind}:${source.runId}` : source.kind,
  };
}
