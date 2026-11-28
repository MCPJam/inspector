import { DECLARED_OUTPUT_SCHEMA, type Predicate } from "@mcpjam/sdk/predicates";
import {
  MAX_RUBRIC_CHECK_QUESTIONS,
  type CustomJudge,
  type RubricCheckQuestion,
} from "@/components/shared/session-quality/judge-config";
import {
  AlignLeft,
  Braces,
  MessageSquareText,
  Target,
  CircleCheck,
  MessageCircleWarning,
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
  category:
    | "tool-calls"
    | "final-answer"
    | "tool-errors"
    | "server-output"
    | "security";
  version: number;
  name: string;
  /** About this run, never about the server in general. */
  question: string;
  /** The situation in which this preset is worth adding. */
  useCase: string;
  icon: LucideIcon;
  tone: EvaluatorTone;
  checks: readonly Predicate[];
  /**
   * Yes/no questions a model answers on the rubric-check pass, which rides
   * the goal-completion judge. Advisory, like every rubric check.
   */
  questions?: readonly LibraryQuestion[];
  /** Judge prompts, each its own model call per iteration. Advisory. */
  judges?: readonly LibraryJudge[];
};

/** A library judge before it is given its id and tag. */
type LibraryJudge = {
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
    category: "tool-calls",
    version: 1,
    name: "No Wasted Calls",
    question:
      "Did the agent stay under 10 tool calls without repeating an identical call?",
    useCase:
      "Catch agents that take too many tool calls on cases with a short, predictable path.",
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
    category: "tool-calls",
    version: 1,
    name: "Valid Tool Arguments",
    question: "Did every call send arguments that match the tool's schema?",
    useCase:
      "Find calls with missing required fields or values of the wrong type.",
    icon: Wrench,
    tone: "tools",
    checks: [{ type: "argumentsMatchToolSchema" }],
  },
  {
    id: "results-match-output-schema",
    category: "server-output",
    version: 1,
    name: "Results Match Output Schema",
    question:
      "Did every tool result in this run match the tool's declared output schema?",
    useCase:
      "Catch changes to structured results that could break clients that rely on the declared output schema.",
    icon: Braces,
    tone: "tools",
    checks: [{ type: "toolResultMatchesSchema", schema: DECLARED_OUTPUT_SCHEMA }],
  },
  {
    id: "delivers-final-answer",
    category: "final-answer",
    version: 1,
    name: "Delivers a Final Answer",
    question:
      "Did the agent end with an answer instead of an empty message or a question?",
    useCase:
      "Use this for cases where the agent has enough information to give a final answer without a follow-up.",
    icon: CircleCheck,
    tone: "answer",
    checks: [
      { type: "finalAssistantMessageNonEmpty" },
      { type: "noEndingQuestion", role: "advisory" },
    ],
  },
  {
    id: "actionable-tool-errors",
    category: "tool-errors",
    version: 1,
    name: "Actionable Tool Errors",
    question:
      "Did every tool call succeed, and did any error name the bad input?",
    useCase:
      "Catch tool failures on cases expected to succeed and see whether error messages point to the input to fix.",
    icon: FileWarning,
    tone: "errors",
    checks: [
      { type: "noToolErrors" },
      { type: "toolErrorNamesInput", role: "advisory" },
    ],
  },
  {
    id: "reports-tool-errors",
    category: "tool-errors",
    version: 1,
    name: "Reports Tool Errors",
    question:
      "When a tool returned an error, did the final answer say so instead of inventing a result? Fails when the run is too long for the grader to see every call.",
    useCase:
      "Use this for cases that intentionally trigger tool errors so you can check what the agent tells the user.",
    icon: MessageCircleWarning,
    tone: "errors",
    checks: [],
    // The grader sees only the last steps of a long run, clipped. A pass
    // therefore needs every call in view: an error it cannot see must fail
    // the question, never pass it.
    questions: [
      {
        slug: "reports-failures",
        label: "Answer reports each tool error",
        instructions:
          "Answer yes only if the tool trajectory shows every tool call the run made (its tool step count matches the steps it lists, and none are omitted or cut off) and the final answer tells the user about each step marked as an error instead of presenting a result that step did not return. If the run made no tool calls, answer yes. Answer no in every other case, including when the trajectory or the final answer is cut off.",
        passOn: "yes",
      },
    ],
  },
  {
    id: "answers-the-question",
    category: "final-answer",
    version: 1,
    name: "Answers the Question",
    question: "Did the final answer address what the user asked?",
    useCase:
      "Catch answers that leave the user asking again, even when the tool calls succeeded.",
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
    category: "final-answer",
    version: 1,
    name: "Meets the Expected Outcome",
    question: "Did the run reach the outcome this case expects?",
    useCase:
      "Use this on cases with an expected output to check whether the agent actually completed the task.",
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
    category: "final-answer",
    version: 1,
    name: "Clear, Concise Answer",
    question: "How clear and to the point was the final answer?",
    useCase:
      "Spot replies that bury the answer in extra detail or drift away from the request.",
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
    category: "security",
    version: 1,
    name: "Avoids Risky Tools",
    question:
      "Did the agent stay away from tools marked destructive or deprecated?",
    useCase:
      "Use this when a case should avoid changing data or relying on tools scheduled for removal.",
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

// Score rows keep only the question ID, so authored questions must use other IDs.
export const LIBRARY_QUESTION_IDS: ReadonlyMap<string, string> = new Map(
  LIBRARY_EVALUATORS.flatMap((evaluator) =>
    taggedQuestions(evaluator).map((question) => [question.id, evaluator.id]),
  ),
);

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
  // Customize swaps the tagged judge for a copy carrying `basedOn`; offering
  // the judge again would grade and charge each iteration twice.
  const customized = suite.judges?.some((j) => j.basedOn?.id === evaluator.id);
  return {
    checks: missingChecks(
      evaluator,
      suite.predicates.filter((p) => p.evaluator?.id === evaluator.id),
    ),
    questions: taggedQuestions(evaluator).filter((q) => !questionIds.has(q.id)),
    judges: customized
      ? []
      : taggedJudges(evaluator).filter((j) => !judgeIds.has(j.id)),
  };
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

/** Reuse matching assertions and preserve their existing role and settings. */
export function withLibraryChecks(
  predicates: readonly Predicate[],
  checks: readonly Predicate[],
): Predicate[] {
  const byCriterion = new Map(
    checks.map((check) => [hostedCriterionId(check), check]),
  );
  const present = new Set<string>();
  const attached = predicates.map((predicate) => {
    const id = hostedCriterionId(predicate);
    present.add(id);
    const check = byCriterion.get(id);
    return check?.evaluator && !predicate.evaluator
      ? { ...predicate, evaluator: check.evaluator }
      : predicate;
  });
  return [
    ...attached,
    ...checks.filter((check) => !present.has(hostedCriterionId(check))),
  ];
}

/**
 * Replaces an evaluator's checks with its current library version. Checks
 * the author already removed come back, because the new version defines the
 * set; per-check edits are replaced too. A check the suite already has from
 * elsewhere is not added again; a hand-written one is tagged, as on add.
 */
export function withEvaluatorUpdated(
  predicates: readonly Predicate[],
  evaluatorId: string,
): Predicate[] {
  const entry = findLibraryEvaluator(evaluatorId);
  if (!entry) return [...predicates];
  return withLibraryChecks(withoutEvaluator(predicates, evaluatorId), taggedChecks(entry));
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

/**
 * The suite's questions after an edit, or why the edit cannot be made. A
 * refusal is shown where the action would be, so nothing is dropped or
 * skipped silently.
 */
type QuestionsEdit =
  | { questions: RubricCheckQuestion[]; refused?: undefined }
  | { refused: string };

type Tagged = { id: string; evaluator?: { id: string } };

/** An id these items need that an item from elsewhere already holds. */
function takenId(
  incoming: readonly Tagged[],
  current: readonly Tagged[],
): string | undefined {
  return incoming.find((wanted) =>
    current.some(
      (q) => q.id === wanted.id && q.evaluator?.id !== wanted.evaluator?.id,
    ),
  )?.id;
}

/** Refuses an edit that grows the list past the cap; a shrinking one is fine. */
function overCap(
  questions: RubricCheckQuestion[],
  before: number,
  action: string,
): QuestionsEdit {
  const over = questions.length - MAX_RUBRIC_CHECK_QUESTIONS;
  if (over <= 0 || questions.length <= before) return { questions };
  return {
    refused: `Suites can ask up to ${MAX_RUBRIC_CHECK_QUESTIONS} rubric-check questions, and ${action} would make ${questions.length}. Remove ${over === 1 ? "a question" : `${over} questions`} first.`,
  };
}

/**
 * The suite's questions with an evaluator's tagged questions appended. One
 * the suite already has from the same evaluator is not added twice.
 */
export function questionsWithAdded(
  questions: readonly RubricCheckQuestion[],
  adding: readonly RubricCheckQuestion[],
): QuestionsEdit {
  const taken = takenId(adding, questions);
  if (taken) {
    return {
      refused: `A question already uses the ID "${taken}". Rename or remove it to add this evaluator.`,
    };
  }
  const ids = new Set(questions.map((q) => q.id));
  return overCap(
    [...questions, ...adding.filter((q) => !ids.has(q.id))],
    questions.length,
    "adding this evaluator",
  );
}

/**
 * The suite's questions with this evaluator's replaced by its current
 * version. Each keeps its place, so an update that changes nothing but the
 * version leaves the list, and the suite's config revision, as it was. A
 * question the new version drops goes; one it adds goes last.
 */
export function questionsWithEvaluatorUpdated(
  evaluator: LibraryEvaluator,
  questions: readonly RubricCheckQuestion[],
): QuestionsEdit {
  const fresh = taggedQuestions(evaluator);
  const taken = takenId(fresh, questions);
  if (taken) {
    return {
      refused: `A question already uses the ID "${taken}". Rename or remove it to update this evaluator.`,
    };
  }
  return overCap(
    replacedFromEvaluator(questions, evaluator.id, fresh),
    questions.length,
    "updating this evaluator",
  );
}

/**
 * `items` with the evaluator's replaced by `fresh`. Each keeps its place; one
 * `fresh` drops goes, and one it adds goes last.
 */
function replacedFromEvaluator<T extends Tagged>(
  items: readonly T[],
  evaluatorId: string,
  fresh: readonly T[],
): T[] {
  const current = new Map(fresh.map((item) => [item.id, item]));
  const next: T[] = [];
  for (const item of items) {
    if (item.evaluator?.id !== evaluatorId) next.push(item);
    else {
      const replacement = current.get(item.id);
      if (replacement) next.push(replacement);
      current.delete(item.id);
    }
  }
  return [...next, ...current.values()];
}

/** The suite's judges after an edit, or why the edit cannot be made. */
type JudgesEdit =
  | { judges: CustomJudge[]; refused?: undefined }
  | { refused: string };

/** Refuses an edit that grows the list past the backend's judge limit. */
function overJudgeLimit(
  judges: CustomJudge[],
  before: number,
  limit: number,
  action: string,
): JudgesEdit {
  const over = judges.length - limit;
  if (over <= 0 || judges.length <= before) return { judges };
  return {
    refused: `Suites can have up to ${limit} ${limit === 1 ? "judge" : "judges"}, and ${action} would make ${judges.length}. Remove ${over === 1 ? "a judge" : `${over} judges`} first.`,
  };
}

/** The suite's judges with an evaluator's judges appended, as for questions. */
export function judgesWithAdded(
  judges: readonly CustomJudge[],
  adding: readonly CustomJudge[],
  limit: number,
): JudgesEdit {
  const taken = takenId(adding, judges);
  if (taken) {
    return {
      refused: `A judge already uses the ID "${taken}". Remove that judge to add this one.`,
    };
  }
  const ids = new Set(judges.map((j) => j.id));
  return overJudgeLimit(
    [...judges, ...adding.filter((j) => !ids.has(j.id))],
    judges.length,
    limit,
    "adding this evaluator",
  );
}

/** The suite's judges with this evaluator's at its current version. */
export function judgesWithEvaluatorUpdated(
  evaluator: LibraryEvaluator,
  judges: readonly CustomJudge[],
  limit: number,
): JudgesEdit {
  const fresh = taggedJudges(evaluator);
  const taken = takenId(fresh, judges);
  if (taken) {
    return {
      refused: `A judge already uses the ID "${taken}". Remove that judge to update this one.`,
    };
  }
  return overJudgeLimit(
    replacedFromEvaluator(judges, evaluator.id, fresh),
    judges.length,
    limit,
    "updating this evaluator",
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
