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

import { isUnrunCheck, type OutcomeCheckLike } from "../conformance-outcome.js";

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
 * the HOST, and the ORDER of query parameters do not. Query parameters
 * themselves are compared, because an MCP endpoint that keys on one is a
 * different endpoint.
 *
 * ONLY THE AUTHORITY IS CASE-FOLDED. Scheme and host are case-insensitive by
 * specification; a path and a query value are not, and folding them would
 * accept evidence gathered from `/MCP?tenant=AcmeCorp` as evidence about
 * `/mcp?tenant=acmecorp`. Those can be two different tenants on two different
 * endpoints, which is exactly the confusion this function exists to prevent.
 *
 * An unparseable URL falls back to a trimmed comparison rather than being
 * treated as a mismatch: two callers that both typed the same malformed thing
 * looked at the same thing. That fallback stays case-SENSITIVE for the same
 * reason as above — with no parse there is no authority to fold separately.
 */
export function sameReadinessTarget(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    try {
      const url = new URL(value);
      url.hash = "";
      url.searchParams.sort();
      const path = url.pathname.replace(/\/+$/, "");
      // USERINFO IS PART OF THE IDENTITY. `url.host` drops it, so
      // `https://tenant-a@example.com/mcp` and `https://tenant-b@example.com/mcp`
      // would compare equal — and with no config fingerprint on either side,
      // one tenant's evidence would be adopted as the other's. Case-SENSITIVE,
      // unlike the host beside it: a username is not a hostname.
      const userinfo = url.username
        ? `${url.username}${url.password ? `:${url.password}` : ""}@`
        : "";
      // The host alone is folded — not the whole authority string — so the
      // fold cannot reach the userinfo beside it, and no index arithmetic has
      // to stay in step with the length of the scheme.
      const host = url.host.toLowerCase();
      return `${url.protocol}//${userinfo}${host}${path}${url.search}`;
    } catch {
      return value.trim();
    }
  };
  return normalize(left) === normalize(right);
}

/**
 * Whether a suite run actually exercised everything it selected.
 *
 * NOT `outcome !== "incomplete"`, which is the tempting one-liner and is
 * wrong. `decideConformanceOutcome` returns `"failed"` the moment any check
 * violates, WITHOUT looking at how many others never ran — so a run with one
 * violation and five checks that could not run is `"failed"`, and reading that
 * as "it looked at everything" adopts the silence of the five as evidence.
 * Only `"passed"` and `"incomplete"` are decided by counting unrun checks, and
 * the first of those is not the question either: a failing run looked at
 * plenty and its findings are exactly what readiness wants to cite.
 *
 * A run with no checks establishes nothing, whatever its outcome says.
 */
export function conformanceRunIsComplete(
  checks: readonly OutcomeCheckLike[],
): boolean {
  return checks.length > 0 && !checks.some(isUnrunCheck);
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
