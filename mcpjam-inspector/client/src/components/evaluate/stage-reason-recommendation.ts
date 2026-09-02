/**
 * The contract's per-reason recommendation, filled in with a trial's evidence.
 *
 * `STAGE_REASON_RECOMMENDATIONS` holds the sentence and the licence to say it;
 * this fills its `{expected}`, `{observed}` and `{errorCode}` placeholders from
 * the diagnostic the reader is actually looking at, so "the expected call to
 * {expected} never happened" becomes a sentence naming their tool.
 *
 * Substitution is the only thing here. The wording, and therefore whether the
 * page instructs, asks or declines to blame the server, is decided in the
 * contract beside the vocabulary it is keyed on.
 *
 * ── Why the values are sanitized ─────────────────────────────────────────────
 *
 * Tool names come from the snapshot the server under test published. They land
 * in an instruction line that a coding agent will read, so a newline or a fence
 * marker inside one is not a cosmetic problem: it is a way for the system under
 * test to write instructions into the prompt describing it. The helpers below
 * mirror `shared/actionable-insights/finding-prompts.ts`, which is not exported
 * — duplicated rather than exported because that module belongs to the swarm
 * and user-testing surfaces, and widening its API for this page would couple
 * two products that currently share nothing.
 */
import {
  STAGE_REASON_RECOMMENDATIONS,
  decisionDiagnosticFirstFailedStage,
  type EvalRunDecisionDiagnostic,
  type StageReason,
  type StageReasonRecommendationWording,
  type UserValueStage,
} from "@mcpjam/sdk/contract";

export type StageReasonEvidence = {
  expectedToolNames?: readonly string[];
  observedToolNames?: readonly string[];
  errorCode?: string | number | null;
};

export type FormattedStageRecommendation = {
  wording: StageReasonRecommendationWording;
  text: string;
};

/** One line, no fence markers, no backticks, bounded. See the module note. */
export function sanitizeIdentifier(value: string, max = 120): string {
  const flattened = value
    .replace(/<<<[^>]*>>>/g, "")
    .replace(/[`\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bounded =
    flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened;
  return bounded.length > 0 ? bounded : "(unnamed)";
}

/** Fence-safe body text, bounded. The producer already clipped; this backstops. */
export function sanitizeFenced(text: string, max = 600): string {
  const flattened = text
    .replace(/<<<[^>]*>>>/g, "[…]")
    .replace(/\r/g, "")
    .trim();
  return flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened;
}

function nameList(names: readonly string[] | undefined): string | null {
  if (!names || names.length === 0) return null;
  return names.map((name) => sanitizeIdentifier(name)).join(", ");
}

/**
 * Fill one reason's recommendation from the evidence at hand.
 *
 * A placeholder with no evidence behind it becomes a generic noun rather than a
 * visible brace: "the expected tool" is vague and true, `{expected}` is a bug
 * the reader sees.
 */
export function formatStageReasonRecommendation(
  reason: StageReason,
  evidence: StageReasonEvidence = {},
): FormattedStageRecommendation {
  const entry = STAGE_REASON_RECOMMENDATIONS[reason];
  const expected = nameList(evidence.expectedToolNames) ?? "the expected tool";
  const observed =
    nameList(evidence.observedToolNames) ?? "the tools that were called";
  const errorCode =
    evidence.errorCode === null || evidence.errorCode === undefined
      ? "no error code recorded"
      : sanitizeIdentifier(String(evidence.errorCode), 60);

  const text = entry.action
    .replaceAll("{expected}", expected)
    .replaceAll("{observed}", observed)
    .replaceAll("{errorCode}", errorCode);

  return { wording: entry.wording, text };
}

export type DiagnosticRecommendation = FormattedStageRecommendation & {
  /** Present only when the contract established a first failed stage. */
  stage: UserValueStage | null;
  reason: StageReason;
};

/**
 * The recommendation for a diagnostic, or nothing.
 *
 * Null rather than a guess in three cases: the chain did not validate, so its
 * rows are withheld; no stage row carries a reason, so there is nothing keyed
 * to look up; or the chain is absent entirely. Inventing a reason to get an
 * action would be the exact failure the reason vocabulary exists to prevent.
 */
export function recommendationForDiagnostic(
  diagnostic: EvalRunDecisionDiagnostic,
): DiagnosticRecommendation | null {
  if (diagnostic.chain.status !== "verified") return null;

  const stage = decisionDiagnosticFirstFailedStage(diagnostic) ?? null;
  const row = stage
    ? diagnostic.chain.stages.find((entry) => entry.stage === stage)
    : diagnostic.chain.stages.find(
        (entry) => entry.reason !== undefined && entry.state !== "passed",
      );
  const reason = row?.reason;
  if (!reason) return null;

  return {
    ...formatStageReasonRecommendation(reason, {
      expectedToolNames: diagnostic.expected?.toolNames,
      observedToolNames: diagnostic.observed?.toolNames,
    }),
    // The stage is the CONTRACT's first failed stage, never the row we happened
    // to read a reason off. A setup abort has a reason and no failed stage, and
    // reporting the row's own stage there would assert a break the contract
    // declined to establish.
    stage,
    reason,
  };
}
