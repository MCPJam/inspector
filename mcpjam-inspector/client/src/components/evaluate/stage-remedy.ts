/**
 * The contract's remedy for a stage reason, rendered for the run page.
 *
 * The sentences are NOT ours. `STAGE_REASON_REMEDIES` is the contract's answer
 * to "what is the one thing to go and change", keyed on the stage reason
 * because the coarse failure category cannot tell "an expected tool call was
 * never made" from "a call was made that the case did not expect" — which want
 * opposite edits. Its text is byte-pinned to the backend's own mirror, so this
 * module reads it and never restates it.
 *
 * ── The absence is the other half of the contract ────────────────────────────
 *
 * That map is deliberately `Partial`, and `STAGE_REASONS_WITHOUT_REMEDY` names
 * the reasons it leaves out: a provider failure of ours, an unverified egress,
 * a stage that was not measured, an earlier stage having failed, and every
 * passing reason. Those say nothing about the server, so there is nothing for
 * a reader to act on and inventing a step would send them after a system that
 * is not involved.
 *
 * This module therefore returns NOTHING for those rather than manufacturing a
 * sentence, and the two exports partition the vocabulary, so a thirtieth reason
 * fails the build on one side or the other before it can reach a reader as a
 * blank line.
 */
import {
  STAGE_REASONS_WITHOUT_REMEDY,
  STAGE_REASON_REMEDIES,
  decisionDiagnosticFirstFailedStage,
  type EvalRunDecisionDiagnostic,
  type StageReason,
  type UserValueStage,
} from "@mcpjam/sdk/contract";

/**
 * How loudly a remedy may speak, derived rather than declared.
 *
 * `none` is the `STAGE_REASONS_WITHOUT_REMEDY` set. `checkWhether` is the two
 * judge reasons that DO carry a remedy — their text already says "read the
 * judge's rationale: either … or …", because a judge score is one model's
 * opinion of another's answer and cannot license an instruction. Everything
 * else measured the system under test and may instruct.
 *
 * Derived from the contract's own sets so there is no second list to keep in
 * step. A judge reason is identified by membership, never by its name's shape:
 * a predicate over spellings silently exempts whatever it did not anticipate.
 */
export type RemedyVoice = "direct" | "checkWhether" | "none";

const JUDGE_REASONS_WITH_REMEDY = new Set<StageReason>([
  "judgeFailed",
  "judgePartial",
]);

const WITHOUT_REMEDY = new Set<StageReason>(STAGE_REASONS_WITHOUT_REMEDY);

export function remedyVoiceFor(reason: StageReason): RemedyVoice {
  if (WITHOUT_REMEDY.has(reason)) return "none";
  return JUDGE_REASONS_WITH_REMEDY.has(reason) ? "checkWhether" : "direct";
}

export type StageRemedy = {
  voice: Exclude<RemedyVoice, "none">;
  /** The contract's sentence, verbatim. */
  text: string;
};

/** The remedy for one reason, or null where the contract records none. */
export function remedyForReason(reason: StageReason): StageRemedy | null {
  const text = (STAGE_REASON_REMEDIES as Partial<Record<StageReason, string>>)[
    reason
  ];
  if (!text) return null;
  const voice = remedyVoiceFor(reason);
  if (voice === "none") return null;
  return { voice, text };
}

export type DiagnosticRemedy = StageRemedy & {
  /** The contract's first failed stage. Null when none was established. */
  stage: UserValueStage | null;
  reason: StageReason;
};

/**
 * The remedy for a diagnostic, or nothing.
 *
 * Null in four cases, all of them honest: the chain did not validate, no row
 * carries a reason, the chain is absent, or the reason is one the contract
 * deliberately leaves without a remedy. Inventing a reason to obtain an action
 * is exactly what the closed vocabulary exists to prevent.
 */
export function remedyForDiagnostic(
  diagnostic: EvalRunDecisionDiagnostic,
): DiagnosticRemedy | null {
  if (diagnostic.chain.status !== "verified") return null;

  const stage = decisionDiagnosticFirstFailedStage(diagnostic) ?? null;
  const row = stage
    ? diagnostic.chain.stages.find((entry) => entry.stage === stage)
    : diagnostic.chain.stages.find(
        (entry) => entry.reason !== undefined && entry.state !== "passed",
      );
  const reason = row?.reason;
  if (!reason) return null;

  const remedy = remedyForReason(reason);
  if (!remedy) return null;

  return {
    ...remedy,
    // The CONTRACT's first failed stage, never the row a reason was read off.
    // A setup abort has a reason and no failed stage, and reporting the row's
    // own stage there would assert a break the contract declined to establish.
    stage,
    reason,
  };
}

/** One line, no fence markers, no backticks, bounded. */
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
