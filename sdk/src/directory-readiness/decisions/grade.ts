/**
 * The decision model's answers graded into one finding per question. A
 * verdict counts only when its quote occurs verbatim in its candidate's text,
 * so a reader sees text a rule proposed, never a paraphrase; any other answer
 * is dropped and counted, never a finding. A violation at or above the
 * confidence threshold violates. `unsure`, or any verdict below it, is
 * inconclusive: `informational`, marked with the model's low confidence, which
 * placement reads as inconclusive and a gate as no verdict, never a pass.
 * With no threshold the scan is off, as it stays until MCPJam sets one from
 * measured accuracy: each check says so as one no run gathers evidence for.
 * Pure. Safe from the browser entry.
 */

import {
  createFindingConstructors,
  UNGATHERED_EVIDENCE_DETAIL_KEY,
  type DirectoryCheckDefinition,
  type DirectoryCheckStamp,
} from "../helpers.js";
import type { DirectoryReadinessFinding } from "../types.js";
import {
  DIRECTORY_DECISION_UNSURE,
  directoryDecisionQuestion,
  type DirectoryDecisionAnswer,
  type DirectoryDecisionItem,
} from "./catalog.js";

/** What every decision check is: a model's heuristic, touching nothing. */
export const DIRECTORY_DECISION_CHECK = {
  class: "heuristic",
  provenance: "llm",
  intrusiveness: "passive",
} as const;

export type DirectoryDecisionOutcome = "violated" | "inconclusive" | "passed";

/** One candidate's kept verdict. */
export interface DirectoryDecisionResult {
  key: string;
  tool?: string;
  field: string;
  verdict: string;
  /** Found verbatim in the candidate's text. */
  quote: string;
  confidence: number;
  outcome: DirectoryDecisionOutcome;
}

/** The decision scan's part of a run's evidence. */
export interface DirectoryDecisionScan {
  /** `items` and `unasked` as `selectDecisionItems` returned them. */
  items: readonly DirectoryDecisionItem[];
  unasked?: Readonly<Record<string, number>>;
  answers: readonly DirectoryDecisionAnswer[];
  /** From 0 to 1, with no default: until one is set the scan is off. */
  confidenceThreshold?: number;
}

const SCAN_OFF =
  "MCPJam's decision scan is off until a confidence threshold is set from measured accuracy, so no model judged this check.";

/** The answer's verdict for its candidate, or `undefined` when it is dropped. */
export function judgeDecisionAnswer(
  item: DirectoryDecisionItem,
  answer: Pick<DirectoryDecisionAnswer, "verdict" | "quote" | "confidence">,
  confidenceThreshold: number
): DirectoryDecisionResult | undefined {
  const question = directoryDecisionQuestion(item.questionId);
  const { key, tool, field, text } = item.candidate;
  const { verdict, quote, confidence } = answer;
  const verbatim =
    typeof quote === "string" && /\S/.test(quote) && text.includes(quote);
  if (!verbatim || !question?.verdicts.includes(verdict)) return undefined;
  // A confidence that is not a number fails the comparison: inconclusive.
  const settled =
    verdict !== DIRECTORY_DECISION_UNSURE && confidence >= confidenceThreshold;
  const outcome = !settled
    ? "inconclusive"
    : verdict === question.violation
      ? "violated"
      : "passed";
  const named = tool === undefined ? {} : { tool };
  return { key, ...named, field, verdict, quote, confidence, outcome };
}

/**
 * One finding per check, each under its question's id and citing its rule.
 * `listing` is the tool listing the candidates came from, absent when the run
 * has no server; while it is missing or partial nothing is judged.
 */
export function gradeDecisionAnswers<
  Lane extends string,
  SourceRef,
  Capability extends string,
>(
  candidates: readonly DirectoryDecisionItem[],
  answers: readonly DirectoryDecisionAnswer[],
  options: {
    confidenceThreshold?: number;
    checks: readonly DirectoryCheckDefinition<Lane, SourceRef, Capability>[];
    engineVersion: string;
    stamp: DirectoryCheckStamp;
    unasked?: Readonly<Record<string, number>>;
    listing?: { read: boolean; complete?: boolean; error?: string };
    missingInput?: string;
  }
): {
  findings: DirectoryReadinessFinding<Lane, SourceRef, Capability>[];
  dropped: number;
} {
  const build = createFindingConstructors<Lane, SourceRef, Capability>(options);
  const { checks, stamp, confidenceThreshold: threshold, listing } = options;
  if (threshold === undefined || !(threshold >= 0 && threshold <= 1)) {
    const off = { [UNGATHERED_EVIDENCE_DETAIL_KEY]: "decisionAnswers" };
    const findings = checks.map((check) =>
      build.notEvaluated(check, stamp, SCAN_OFF, off)
    );
    return { findings, dropped: 0 };
  }
  const partial = !listing?.read
    ? listing && "no tool listing was captured for this run"
    : listing.complete === false &&
      (listing.error ?? "the tool listing was truncated");
  if (partial) {
    const reason = `${partial}, so the decision scan cannot cover every tool`;
    const gap = { missingInput: options.missingInput };
    const findings = checks.map((check) =>
      build.notEvaluated(check, stamp, reason, gap)
    );
    return { findings, dropped: 0 };
  }
  const pair = (questionId: string, key: string) =>
    JSON.stringify([questionId, key]);
  const answered = new Map(
    answers.map((answer) => [
      pair(answer.questionId, answer.candidateKey),
      answer,
    ])
  );
  let dropped = 0;
  const findings = checks.map((check) => {
    const question = directoryDecisionQuestion(check.id);
    if (!question) return build.notEvaluated(check, stamp, "No such question");
    const asked = candidates.filter((item) => item.questionId === check.id);
    const results: DirectoryDecisionResult[] = [];
    let unanswered = 0;
    for (const item of asked) {
      const answer = answered.get(pair(check.id, item.candidate.key));
      const result = answer && judgeDecisionAnswer(item, answer, threshold);
      if (result) results.push(result);
      if (!answer) unanswered += 1;
    }
    const unkept = asked.length - unanswered - results.length;
    const unasked = options.unasked?.[check.id] ?? 0;
    dropped += unkept;
    const details = {
      candidates: results,
      asked: asked.length,
      unasked,
      unanswered,
      dropped: unkept,
      confidenceThreshold: threshold,
    };
    const where = (outcome: DirectoryDecisionOutcome) => {
      const hits = results.filter((result) => result.outcome === outcome);
      const [{ tool, field }] = hits;
      const more = hits.length > 1 ? ` and ${hits.length - 1} more` : "";
      return `${tool ? `${tool} ${field}` : field}${more}`;
    };
    if (results.some((result) => result.outcome === "violated")) {
      const found = `MCPJam's decision model found ${question.problem} in ${where("violated")}.`;
      return build.violated(check, stamp, `${found} ${question.fix}`, details);
    }
    if (results.some((result) => result.outcome === "inconclusive")) {
      const note = `MCPJam's decision model could not settle ${where("inconclusive")}. Read the quoted text and decide whether it is ${question.problem}.`;
      const low = { ...details, confidence: "low" };
      return build.informational(check, stamp, low, note);
    }
    const missing = unasked + unanswered + unkept;
    if (missing === 0) return build.satisfied(check, stamp, details);
    const reason = `No verdict for ${missing} of ${missing + results.length} candidates: ${unasked} not asked, ${unanswered} not answered, ${unkept} quoting text the source does not contain.`;
    return build.notEvaluated(check, stamp, reason, details);
  });
  return { findings, dropped };
}
