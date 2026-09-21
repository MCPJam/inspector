/**
 * Adapting an apps-conformance result into Claude readiness evidence.
 *
 * WHAT IS SEMANTICALLY IDENTICAL, and therefore adaptable. The apps suite
 * already dialled this server, listed its widget tools, read its widget
 * resources and graded their `_meta`. Readiness asks a different QUESTION of
 * that material — would Anthropic list this — but the material itself is the
 * same material. Re-reading it inside a readiness run would double the traffic
 * to somebody else's server and let two readings of one server disagree.
 *
 * WHAT IS NOT ADAPTABLE, and why the guard is not optional. A result graded
 * against a different URL, produced under a different configuration, or from a
 * run that never finished is not evidence about this readiness run's target.
 * Adopting it would be worse than having nothing: nothing reports
 * `not-evaluated` and names the input, while a wrong adoption reports a clean
 * apps lane for a server nobody looked at.
 *
 * WHY THE RAW TOOLS AND CONTENTS ARE ARGUMENTS. The suite's RESULT carries
 * counts and verdicts, not the per-tool `_meta` and per-resource HTML the
 * readiness checks read. So the caller passes the material it already has in
 * hand, and the result is consumed for its ATTRIBUTION and its completeness —
 * which is exactly the split `derivedFrom` exists to record.
 *
 * Pure data reasoning. No transport.
 */

import type { OutcomeCheckLike } from "../conformance-outcome.js";
import {
  checkEvidenceReuse,
  conformanceRunIsComplete,
  type AttributableEvidenceSource,
  type EvidenceReuse,
  type EvidenceReuseExpectation,
} from "../directory-readiness/evidence-reuse.js";
import {
  claudeAppResourceEvidenceFrom,
  claudeAppToolEvidenceFrom,
  type ClaudeAppResourceEvidence,
  type ClaudeAppsEvidence,
  type ClaudeAppToolEvidence,
} from "./checks/apps.js";

/** The suite kind this adapter reads, as it appears in `derivedFrom`. */
export const CLAUDE_APPS_EVIDENCE_KIND = "apps-conformance";

/** The subset of an apps-conformance result this adapter reads. */
export interface AdaptableAppsConformanceResult {
  target: string;
  /**
   * The run's own verdict. Carried for the citation, NOT consulted for
   * completeness — see `checks`.
   */
  outcome: string;
  /**
   * The run's checks, which are what say whether it finished.
   *
   * Required, because the outcome cannot answer this: `"failed"` is returned
   * on the first violation without counting the checks that never ran, so a
   * run that looked at almost nothing can carry it. A run whose checks could
   * not run holds no statement about the widgets it never reached, and
   * adopting its evidence would report those as clean.
   */
  checks: readonly OutcomeCheckLike[];
}

export interface AdaptAppsResultToClaudeOptions {
  result: AdaptableAppsConformanceResult;
  /** The readiness target and config the adapted evidence has to match. */
  expectation: EvidenceReuseExpectation;
  /** The source run's identity, for the `derivedFrom` citation. */
  runId?: string;
  configFingerprint?: string;
  /** The tool listing the suite run held, with `_meta` intact. */
  tools?: readonly { name: string; _meta?: unknown }[];
  /** The resource contents the suite run read, with their bodies. */
  resourceContents?: readonly {
    uri?: string;
    mimeType?: string;
    text?: string;
    _meta?: unknown;
  }[];
  /** The widget's OAuth is owned by the app rather than the connector. */
  appOwnedOAuth?: boolean;
  /** How a rendering observation was obtained, when the suite made one. */
  renderEngine?: ClaudeAppsEvidence["renderEngine"];
}

/**
 * Adapt an apps-conformance result, or refuse with a reason.
 *
 * Refusal is not an error path — it is the ordinary outcome for a caller that
 * happens to hold an unrelated result, and the caller's correct response is to
 * pass no apps evidence at all. Then the apps lane reports `not-evaluated`
 * naming `appsResult`, which is a true statement about what this run looked
 * at.
 */
export function adaptAppsResultToClaudeEvidence(
  options: AdaptAppsResultToClaudeOptions,
): EvidenceReuse<ClaudeAppsEvidence> {
  const source: AttributableEvidenceSource = {
    kind: CLAUDE_APPS_EVIDENCE_KIND,
    runId: options.runId,
    target: options.result.target,
    configFingerprint: options.configFingerprint,
    // `passed` is not the question and never was. A suite run that FAILED may
    // still have looked at everything it selected, and its findings are
    // exactly what readiness wants to cite; a run that could not finish is the
    // one whose silence would be mistaken for a clean bill of health. Which of
    // those it is comes from the checks, because the outcome cannot tell them
    // apart.
    complete: conformanceRunIsComplete(options.result.checks),
  };

  const verdict = checkEvidenceReuse(source, options.expectation);
  if (!verdict.ok) return verdict;

  const tools: ClaudeAppToolEvidence[] = (options.tools ?? [])
    .map((tool) => claudeAppToolEvidenceFrom(tool))
    .filter(
      (evidence): evidence is ClaudeAppToolEvidence => evidence !== undefined,
    );

  const resources: ClaudeAppResourceEvidence[] = (
    options.resourceContents ?? []
  ).map((content) => claudeAppResourceEvidenceFrom(content));

  return {
    ok: true,
    sourceRef: verdict.sourceRef,
    evidence: {
      // The READINESS target, not the source's. They compare equal by
      // `sameReadinessTarget` and may still differ in spelling, and every
      // finding downstream derives Claude's content domain from this string —
      // so the run's own target is the one that has to be carried.
      enteredUrl: options.expectation.target,
      appsSuiteRan: true,
      tools,
      resources,
      appOwnedOAuth: options.appOwnedOAuth,
      renderEngine: options.renderEngine,
    },
  };
}
