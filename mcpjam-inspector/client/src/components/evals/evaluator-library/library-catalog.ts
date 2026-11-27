import type { Predicate } from "@mcpjam/sdk/predicates";
import type {
  CustomJudge,
  RubricCheckQuestion,
} from "@/components/shared/session-quality/judge-config";
import {
  AlignLeft,
  Braces,
  MessageSquareText,
  Target,
  CircleCheck,
  MessageCircleWarning,
  Quote,
  FileWarning,
  Route,
  ShieldAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { hostedCriterionId } from "@/shared/hosted-criterion-id";
import type { BuiltFromPart, EvaluatorTone } from "./evaluator-library-types";

/**
 * One library evaluator: a named bundle of assertions that already exist.
 * Adding it writes `checks` to the suite.
 */
export type LibraryEvaluator = {
  id: string;
  version: number;
  name: string;
  /** About this run, never about the server in general. */
  question: string;
  icon: LucideIcon;
  tone: EvaluatorTone;
  checks: readonly Predicate[];
  /**
   * Yes/no questions a model answers on the rubric-check pass, which rides
   * the goal-completion judge. Advisory, like every rubric check.
   */
  questions?: readonly LibraryQuestion[];
  /** Judge prompts, each its own model call per trial. Advisory. */
  judges?: readonly LibraryJudge[];
};

/** A library judge before it is given its id and tag. */
export type LibraryJudge = {
  slug: string;
  label: string;
  prompt: string;
  output: CustomJudge["output"];
};

/** What a suite already has, for "In this suite" and for what to add. */
export type LibrarySuiteParts = {
  predicates: readonly Predicate[];
  questions?: readonly RubricCheckQuestion[];
  judges?: readonly CustomJudge[];
};

/** What one library evaluator adds that the suite does not have yet. */
export type LibraryAddition = {
  checks: Predicate[];
  questions: RubricCheckQuestion[];
  judges: CustomJudge[];
};

/** What this deployment can save. */
export type LibrarySupport = {
  authorableKinds?: readonly Predicate["type"][];
  canAskYesNo?: boolean;
  canJudge?: boolean;
};

/** A library question before it is given its id and tag. */
export type LibraryQuestion = {
  slug: string;
  label: string;
  instructions: string;
  passOn: "yes" | "no";
};

export const LIBRARY_EVALUATORS: readonly LibraryEvaluator[] = [
  {
    id: "no-wasted-calls",
    version: 1,
    name: "No Wasted Calls",
    question:
      "Did the agent stay under 10 tool calls without repeating an identical call?",
    icon: Route,
    tone: "tools",
    checks: [
      { type: "toolCallCountUnder", count: 10 },
      // An observation: a repeat is what a poll loop looks like too, so the
      // schema only lets it advise.
      { type: "noRepeatedIdenticalCall", role: "advisory" },
    ],
  },
  {
    id: "valid-tool-arguments",
    version: 1,
    name: "Valid Tool Arguments",
    question: "Did every call send arguments that match the tool's schema?",
    icon: Wrench,
    tone: "tools",
    checks: [{ type: "argumentsMatchToolSchema" }],
  },
  {
    id: "results-match-output-schema",
    version: 1,
    name: "Results Match Output Schema",
    question:
      "Did every tool result in this run match the tool's declared output schema?",
    icon: Braces,
    tone: "tools",
    checks: [{ type: "toolResultMatchesSchema", schema: "declared" }],
  },
  {
    id: "delivers-final-answer",
    version: 1,
    name: "Delivers a Final Answer",
    question:
      "Did the agent end with an answer instead of an empty message or a question?",
    icon: CircleCheck,
    tone: "answer",
    checks: [
      { type: "finalAssistantMessageNonEmpty" },
      { type: "noEndingQuestion", role: "advisory" },
    ],
  },
  {
    id: "actionable-tool-errors",
    version: 1,
    name: "Actionable Tool Errors",
    question:
      "Did every tool call succeed, and did any error name the bad input?",
    icon: FileWarning,
    tone: "errors",
    checks: [
      { type: "noToolErrors" },
      { type: "toolErrorNamesInput", role: "advisory" },
    ],
  },
  {
    id: "reports-tool-errors",
    version: 1,
    name: "Reports Tool Errors",
    question:
      "When a tool failed, did the final answer say so instead of inventing a result?",
    icon: MessageCircleWarning,
    tone: "errors",
    checks: [],
    questions: [
      {
        slug: "reports-failures",
        label: "Answer reports each tool failure",
        instructions:
          "Find every tool call that failed or returned an error. Answer yes if no tool failed, or if the final answer tells the user about each failure instead of presenting a result that tool did not return. Answer no if any failure is left out or covered by an invented result.",
        passOn: "yes",
      },
    ],
  },
  {
    id: "answer-grounded-in-results",
    version: 1,
    name: "Answer Grounded in Results",
    question:
      "Is every factual claim in the answer backed by a tool result from this run?",
    icon: Quote,
    tone: "answer",
    checks: [],
    questions: [
      {
        slug: "grounded",
        label: "Every claim is backed by a tool result",
        instructions:
          "List the factual claims in the final answer and check each against the tool results in the recording. Answer yes only if every claim is supported.",
        passOn: "yes",
      },
    ],
  },
  {
    id: "answers-the-question",
    version: 1,
    name: "Answers the Question",
    question: "Did the final answer address what the user asked?",
    icon: MessageSquareText,
    tone: "answer",
    checks: [],
    judges: [
      {
        slug: "answers",
        label: "Answers what the user asked",
        prompt:
          "Judge only the content of the final answer: does it give the user what they asked for? Pass if the user would not need to ask again or rephrase. Do not judge how the agent got there, such as which tools it called; other checks cover that.\n\nUser's request:\n{{user_prompt}}\n\nFinal answer:\n{{final_answer}}",
        output: { kind: "passfail" },
      },
    ],
  },
  {
    id: "meets-expected-outcome",
    version: 1,
    name: "Meets the Expected Outcome",
    question: "Did the run reach the outcome this case expects?",
    icon: Target,
    tone: "answer",
    checks: [],
    judges: [
      {
        slug: "meets",
        label: "Reaches the expected outcome",
        prompt:
          "Compare the run with the expected output. Pass only if the tool results and the final answer show the outcome was reached, not just described.\n\nExpected output:\n{{expected_output}}\n\nTool results:\n{{tool_results}}\n\nFinal answer:\n{{final_answer}}",
        output: { kind: "passfail" },
      },
    ],
  },
  {
    id: "clear-concise-answer",
    version: 1,
    name: "Clear, Concise Answer",
    question: "How clear and to the point was the final answer?",
    icon: AlignLeft,
    tone: "answer",
    checks: [],
    judges: [
      {
        slug: "clarity",
        label: "Clear and concise",
        prompt:
          "Rate how clear and concise the final answer is for this request, from 0 (confusing, padded or off topic) to 1 (clear and to the point).\n\nRequest:\n{{user_prompt}}\n\nFinal answer:\n{{final_answer}}",
        output: { kind: "score", threshold: 0.7 },
      },
    ],
  },
  {
    id: "avoids-risky-tools",
    version: 1,
    name: "Avoids Risky Tools",
    question:
      "Did the agent stay away from tools marked destructive or deprecated?",
    icon: ShieldAlert,
    tone: "security",
    checks: [
      { type: "noDestructiveToolCalled" },
      { type: "noDeprecatedToolCalled", role: "advisory" },
    ],
  },
];

/** The evaluator's checks, each tagged with where it came from. */
export function taggedChecks(evaluator: LibraryEvaluator): Predicate[] {
  return evaluator.checks.map((check) => ({
    ...check,
    evaluator: { id: evaluator.id, version: evaluator.version },
  }));
}

export function findLibraryEvaluator(id: string): LibraryEvaluator | undefined {
  return LIBRARY_EVALUATORS.find((evaluator) => evaluator.id === id);
}

/** Every check except the ones added from this evaluator. */
export function withoutEvaluator(
  predicates: readonly Predicate[],
  evaluatorId: string,
): Predicate[] {
  return predicates.filter((p) => p.evaluator?.id !== evaluatorId);
}

/** The evaluator's questions, each with a stable id and its tag. */
export function taggedQuestions(
  evaluator: LibraryEvaluator,
): RubricCheckQuestion[] {
  return (evaluator.questions ?? []).map((q) => ({
    id: `${evaluator.id}-${q.slug}`,
    kind: "yesno",
    label: q.label,
    instructions: q.instructions,
    pass: { answer: q.passOn },
    evaluator: { id: evaluator.id, version: evaluator.version },
  }));
}

/** The evaluator's judges, each with a stable id and its tag. */
export function taggedJudges(evaluator: LibraryEvaluator): CustomJudge[] {
  return (evaluator.judges ?? []).map((j) => ({
    id: `${evaluator.id}-${j.slug}`,
    label: j.label,
    prompt: j.prompt,
    output: j.output,
    evaluator: { id: evaluator.id, version: evaluator.version },
  }));
}

/** Everything the evaluator adds that the suite does not have yet. */
export function missingParts(
  evaluator: LibraryEvaluator,
  suite: LibrarySuiteParts,
): LibraryAddition {
  const questionIds = new Set(
    suite.questions?.filter((q) => q.evaluator?.id === evaluator.id).map((q) => q.id),
  );
  const judgeIds = new Set(
    suite.judges?.filter((j) => j.evaluator?.id === evaluator.id).map((j) => j.id),
  );
  return {
    checks: missingChecks(evaluator, suite.predicates),
    questions: taggedQuestions(evaluator).filter((q) => !questionIds.has(q.id)),
    judges: taggedJudges(evaluator).filter((j) => !judgeIds.has(j.id)),
  };
}

export function hasLibraryIdConflict(
  evaluator: LibraryEvaluator,
  suite: Pick<LibrarySuiteParts, "questions" | "judges">,
): boolean {
  return (
    taggedQuestions(evaluator).some((expected) =>
      suite.questions?.some((q) => q.id === expected.id && q.evaluator?.id !== evaluator.id),
    ) ||
    taggedJudges(evaluator).some((expected) =>
      suite.judges?.some((j) => j.id === expected.id && j.evaluator?.id !== evaluator.id),
    )
  );
}

/**
 * The evaluator's tagged checks the suite does not already have. Compared by
 * criterion identity (the check without its role, severity or origin), so an
 * authored check with different arguments does not count as a copy.
 */
export function missingChecks(
  evaluator: LibraryEvaluator,
  predicates: readonly Predicate[],
): Predicate[] {
  const present = new Set(predicates.map((p) => hostedCriterionId(p)));
  return taggedChecks(evaluator).filter(
    (check) => !present.has(hostedCriterionId(check)),
  );
}

/**
 * Replaces an evaluator's checks with its current library version. Checks
 * the author already removed come back, because the new version defines the
 * set; per-check edits are replaced too. A check the suite already has from
 * elsewhere is not added again.
 */
export function withEvaluatorUpdated(
  predicates: readonly Predicate[],
  evaluatorId: string,
): Predicate[] {
  const entry = findLibraryEvaluator(evaluatorId);
  if (!entry) return [...predicates];
  const rest = withoutEvaluator(predicates, evaluatorId);
  return [...rest, ...missingChecks(entry, rest)];
}

/** "2 assertions · 1 yes/no question", for the card footer. */
export function builtFrom(evaluator: LibraryEvaluator): BuiltFromPart[] {
  const parts: BuiltFromPart[] = [];
  const n = evaluator.checks.length;
  if (n) {
    parts.push({
      kind: "assertions",
      label: `${n} ${n === 1 ? "assertion" : "assertions"}`,
    });
  }
  const q = evaluator.questions?.length ?? 0;
  if (q) {
    parts.push({
      kind: "question",
      label: `${q} yes/no ${q === 1 ? "question" : "questions"}`,
    });
  }
  const j = evaluator.judges?.length ?? 0;
  if (j) {
    parts.push({ kind: "judge", label: `${j} ${j === 1 ? "judge" : "judges"}` });
  }
  return parts;
}

/** True when the suite already has everything this evaluator adds. */
export function isInSuite(
  evaluator: LibraryEvaluator,
  suite: LibrarySuiteParts,
): boolean {
  const missing = missingParts(evaluator, suite);
  return (
    missing.checks.length === 0 &&
    missing.questions.length === 0 &&
    missing.judges.length === 0
  );
}

/** True when this deployment can save everything the evaluator adds. */
export function isAuthorable(
  evaluator: LibraryEvaluator,
  support: LibrarySupport = {},
): boolean {
  if (evaluator.questions?.length && !support.canAskYesNo) return false;
  if (evaluator.judges?.length && !support.canJudge) return false;
  const kinds = support.authorableKinds;
  if (!kinds) return true;
  return evaluator.checks.every((check) => kinds.includes(check.type));
}
