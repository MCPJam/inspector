/**
 * Checks proposed from what a run actually did.
 *
 * Two rules decide everything here, and both exist because "it happened three
 * times" is not the same claim as "it should be required".
 *
 * 1. A REQUIREMENT (Gate) is only offered when every observed trial in the
 *    batch carries a success signal — the judge scored it as accomplishing the
 *    goal, or the case already had a gate and the trial passed it. Three runs
 *    that call the wrong tool agree with each other perfectly; without a
 *    signal, repetition would harden the bug.
 * 2. A claim must hold in EVERY trial, and a trial whose trace could not be
 *    read counts as not holding. "We never looked" is not evidence.
 *
 * When a trial did not succeed, the batch produces a DIAGNOSIS instead: what
 * failed and where, with no structural suggestions at all. Hardening a case
 * whose last run did not work is the wrong next step.
 */

import type { Predicate } from "@/shared/eval-matching";
import { hostedCriterionId } from "@/shared/hosted-criterion-id";
import { isKnownPredicateKind } from "@/shared/predicate-kinds";
import {
  actionRows,
  lastStepIdOfTurn,
  stepTurnIndices,
  type TestStep,
  type WidgetAssertion,
} from "@/shared/steps";
import type { CasePredicates } from "@/shared/eval-matching";
import { withPredicateRole } from "@/components/evals/suite-scorer-table-model";
import type { ScorerUiRole } from "@/components/evals/suite-scorer-table-model";
import type { UserValueStage } from "@mcpjam/sdk/contract";
import {
  isSimpleCaseShape,
  readSimpleCase,
  type CaseKind,
} from "../simple-case/simple-case-model";
import {
  purposeOf,
  stageOfPredicate,
  stepScope,
  WIDGET_ASSERT_STAGE,
  type RouteState,
} from "./case-scorecard-model";
import type { TrialRunFacts } from "./trial-run-facts";

export type SuggestionBasis = "held" | "diagnosis";

export type SuggestionPlacement =
  | {
      kind: "afterStep";
      anchorStepId: string;
      actionOrdinal: number;
      turnIndex: number;
    }
  | { kind: "wholeRun" };

export type Suggestion = {
  key: string;
  kind: "predicate" | "route" | "widgetAssertion";
  basis: SuggestionBasis;
  /** What this PROTECTS, in words a newcomer can repeat. The row's headline. */
  purpose: string;
  /** The mechanism, underneath: `formatCriterion`-style. */
  label: string;
  /** What accepting it changes about future runs. Gates only. */
  consequence?: string;
  /** The numbers that justify it. */
  evidence: string;
  predicate?: Predicate;
  widgetAssertion?: WidgetAssertion;
  route?: { pathKey: string; iterationId: string; noTool: boolean };
  scope?: { kind: "turn"; promptIndex: number };
  placement: SuggestionPlacement;
  role: ScorerUiRole;
  stability: { held: number; of: number; unread: number };
  stage: UserValueStage;
};

export type SuggestDiagnosis = {
  unsuccessful: number;
  of: number;
  /** No trial carried a success signal at all — usually an ungraded quick run. */
  noSignal: boolean;
};

export type SuggestOutput = {
  suggestions: Suggestion[];
  diagnosis: SuggestDiagnosis | null;
};

export type SuggestInput = {
  trials: TrialRunFacts[];
  steps: TestStep[];
  casePredicates?: CasePredicates;
  suiteDefaults?: Predicate[];
  goal?: string;
  /** Prompt texts, so a needle that merely echoes the ask is excluded. */
  prompts?: string[];
  route: RouteState;
  routeKind?: CaseKind;
  /** Test seam: pretend this build knows only these kinds. */
  knownKinds?: ReadonlySet<string>;
};

/** How many trials a claim held in, and how many could not be read. */
export function heldInEvery(
  trials: TrialRunFacts[],
  holds: (trial: TrialRunFacts) => boolean | "unread",
): { held: number; of: number; unread: number } {
  let held = 0;
  let unread = 0;
  for (const trial of trials) {
    const verdict = trial.observed ? holds(trial) : "unread";
    if (verdict === "unread") unread += 1;
    else if (verdict) held += 1;
  }
  return { held, of: trials.length, unread };
}

const STOPWORDS = new Set([
  "the",
  "and",
  "that",
  "with",
  "this",
  "from",
  "into",
  "then",
  "them",
  "they",
  "their",
  "there",
  "when",
  "what",
  "which",
  "should",
  "would",
  "could",
  "have",
  "has",
  "was",
  "were",
  "been",
  "being",
  "about",
  "after",
  "before",
  "answer",
  "user",
  "must",
  "will",
  "each",
  "also",
  "your",
  "state",
  "states",
]);

/**
 * Needles for a `responseContains` check, taken from the GOAL, not the answer.
 *
 * Extracting ids and emails out of the answer is easy and mostly wrong: it
 * pins a transient value that happened to appear once. A phrase the author
 * wrote into the goal sentence and that then showed up verbatim in every
 * answer is a claim they already made — this only proposes checking it.
 * Anything that also appears in a prompt is dropped, since echoing the ask
 * says nothing about the answer.
 */
export function goalNeedles(
  goal: string | undefined,
  finals: string[],
  prompts: string[],
): string[] {
  if (!goal || finals.length === 0) return [];
  const promptText = prompts.join(" ").toLowerCase();
  const quoted = [...goal.matchAll(/[“"']([^“”"']{3,80})[”"']/g)].map((m) =>
    m[1]!.trim(),
  );
  const words = goal
    .split(/[^\p{L}\p{N}_@.-]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word.toLowerCase()));
  const candidates = [...quoted, ...words];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (promptText.includes(lower)) continue;
    if (/^\d{1,3}$/.test(candidate)) continue;
    if (!finals.every((final) => final.toLowerCase().includes(lower))) continue;
    out.push(candidate);
    if (out.length === 3) break;
  }
  return out;
}

/** Every criterion the case already grades, by the id the server persists. */
function existingCriterionIds(
  steps: TestStep[],
  casePredicates: CasePredicates | undefined,
  suiteDefaults: Predicate[],
): { ids: Set<string>; kinds: Set<string> } {
  const ids = new Set<string>();
  const kinds = new Set<string>();
  for (const step of steps) {
    if (step.kind !== "assert") continue;
    const assertion = step.assertion as Predicate;
    if (
      !assertion ||
      typeof (assertion as { type?: unknown }).type !== "string"
    ) {
      continue;
    }
    ids.add(hostedCriterionId(assertion, stepScope(steps, step.id)));
    kinds.add(assertion.type);
  }
  if (casePredicates && casePredicates.mode !== "inherit") {
    for (const predicate of casePredicates.list) {
      ids.add(hostedCriterionId(predicate));
      kinds.add(predicate.type);
    }
  }
  // A `replace` envelope means the suite's list does not apply to this case,
  // so those criteria are NOT already graded and must not dedupe a suggestion.
  if (casePredicates?.mode !== "replace") {
    for (const predicate of suiteDefaults) {
      ids.add(hostedCriterionId(predicate));
      kinds.add(predicate.type);
    }
  }
  return { ids, kinds };
}

const ROLE_ORDER: Record<ScorerUiRole, number> = {
  gate: 0,
  warn: 1,
  report: 2,
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function suggestScorers(input: SuggestInput): SuggestOutput {
  const trials = input.trials;
  const observed = trials.filter((trial) => trial.observed);
  const known = input.knownKinds;
  const knows = (kind: string) =>
    known ? known.has(kind) : isKnownPredicateKind(kind);

  const unsuccessful = observed.filter(
    (trial) => trial.successSignal === "none",
  );
  const diagnosis: SuggestDiagnosis | null =
    observed.length > 0 && unsuccessful.length > 0
      ? {
          unsuccessful: unsuccessful.length,
          of: observed.length,
          noSignal: unsuccessful.length === observed.length,
        }
      : null;
  /** Requirements and wording claims need a batch that demonstrably worked. */
  const canRequire = observed.length > 0 && diagnosis === null;

  const { ids: existingIds, kinds: existingKinds } = existingCriterionIds(
    input.steps,
    input.casePredicates,
    input.suiteDefaults ?? [],
  );
  const { actions } = actionRows(input.steps);
  const turnIndices = stepTurnIndices(input.steps);
  const of = trials.length;
  const out: Suggestion[] = [];

  const ordinalForTurn = (turn: number): number | undefined =>
    actions.find((action) => action.turnIndex === turn)?.ordinal;

  const push = (suggestion: Suggestion) => {
    if (suggestion.predicate) {
      const id = hostedCriterionId(
        suggestion.predicate,
        suggestion.scope as never,
      );
      if (existingIds.has(id)) return;
    }
    out.push(suggestion);
  };

  // ── R1: the route ─────────────────────────────────────────────────────────
  // Only when the case has no route yet AND the shape is one `writeSimpleCase`
  // can rewrite — `adoptRouteFromIteration` goes through it, and on a
  // multi-turn or app case that rewrite would reorder turns.
  const routeKindNow = input.route.kind;
  const routeOffered =
    canRequire &&
    (routeKindNow === "unset" || routeKindNow === "checks") &&
    isSimpleCaseShape(input.steps);
  if (routeOffered) {
    const first = observed[0]!;
    const agree = heldInEvery(
      trials,
      (trial) => trial.pathKey === first.pathKey,
    );
    if (agree.held === of && of > 0) {
      const noTool = first.toolSequence.length === 0;
      const path = first.toolSequence.join(" → ");
      out.push({
        key: `sugg:route:${first.pathKey}`,
        kind: "route",
        basis: "held",
        purpose: noTool
          ? "Require that no tool is called"
          : "Require this route on future runs",
        label: noTool ? "No tool should be called" : `Route · ${path}`,
        consequence: noTool
          ? "Future runs that call a tool will fail this case."
          : `Future runs that do not reach ${path} will fail this case.`,
        evidence: noTool
          ? `No tool was called in ${agree.held} of ${of}`
          : `Same route in ${agree.held} of ${of}: ${path}`,
        route: {
          pathKey: first.pathKey,
          iterationId: first.iterationId,
          noTool,
        },
        placement: { kind: "wholeRun" },
        role: "gate",
        stability: agree,
        stage: "selection",
      });
    }
  }

  // ── R2: a tool was called, per turn ───────────────────────────────────────
  if (canRequire && knows("toolCalledAtLeastOnce")) {
    const routeTools = new Set(
      readSimpleCase(input.steps).tools.map((tool) => tool.toolName),
    );
    const turns = new Set(
      trials.flatMap((trial) => [...(trial.toolsByTurn?.keys() ?? [])]),
    );
    for (const turn of [...turns].sort((a, b) => a - b)) {
      // The route already makes this claim for turn 0, and more strongly.
      if (routeOffered && turn === 0) continue;
      const ordinal = ordinalForTurn(turn);
      const anchor = lastStepIdOfTurn(input.steps, turn);
      if (ordinal === undefined || !anchor) continue;
      const intersection = trials.reduce<Set<string> | null>((acc, trial) => {
        const names = trial.toolsByTurn?.get(turn);
        if (!names) return acc;
        const set = new Set(names);
        if (!acc) return set;
        return new Set([...acc].filter((name) => set.has(name)));
      }, null);
      for (const toolName of intersection ?? []) {
        if (routeTools.has(toolName)) continue;
        const held = heldInEvery(trials, (trial) =>
          trial.toolsByTurn
            ? trial.toolsByTurn.get(turn)?.includes(toolName) === true
            : "unread",
        );
        if (held.held !== of || of === 0) continue;
        const predicate = withPredicateRole(
          { type: "toolCalledAtLeastOnce", toolName } as Predicate,
          "gate",
        );
        push({
          key: `sugg:${hostedCriterionId(predicate, { kind: "turn", promptIndex: turn } as never)}`,
          kind: "predicate",
          basis: "held",
          purpose: "Require this tool on future runs",
          label: `Tool was called at least once · ${toolName}`,
          consequence: `Future runs where step ${ordinal} does not call ${toolName} will fail this case.`,
          evidence: `${toolName} was called in step ${ordinal} in ${held.held} of ${of} ${plural(of, "trial", "trials")}`,
          predicate,
          scope: { kind: "turn", promptIndex: turn },
          placement: {
            kind: "afterStep",
            anchorStepId: anchor,
            actionOrdinal: ordinal,
            turnIndex: turn,
          },
          role: "gate",
          stability: held,
          stage: stageOfPredicate(predicate),
        });
      }
    }
  }

  // ── R4: no tool errored, over the whole run ───────────────────────────────
  if (
    canRequire &&
    knows("noToolErrors") &&
    !existingKinds.has("noToolErrors")
  ) {
    const held = heldInEvery(trials, (trial) =>
      trial.toolErrors === undefined
        ? "unread"
        : trial.toolErrors.length === 0 && trial.toolSequence.length > 0,
    );
    if (held.held === of && of > 0) {
      const calls = trials.reduce(
        (sum, trial) => sum + trial.toolSequence.length,
        0,
      );
      const predicate = withPredicateRole(
        { type: "noToolErrors" } as Predicate,
        "gate",
      );
      push({
        key: `sugg:${hostedCriterionId(predicate)}`,
        kind: "predicate",
        basis: "held",
        purpose: purposeOf(predicate),
        label: "No tool errors",
        consequence:
          "Future runs where a tool returns an error will fail this case.",
        evidence: `No tool errored in ${held.held} of ${of} ${plural(of, "trial", "trials")} (${calls} ${plural(calls, "call", "calls")})`,
        predicate,
        placement: { kind: "wholeRun" },
        role: "gate",
        stability: held,
        stage: stageOfPredicate(predicate),
      });
    }
  }

  // ── R6: a view rendered ───────────────────────────────────────────────────
  if (canRequire && knows("widgetRendered")) {
    const tools = new Set(
      trials.flatMap((trial) => [...(trial.renderedByTool?.keys() ?? [])]),
    );
    for (const toolName of [...tools].sort()) {
      const held = heldInEvery(trials, (trial) =>
        trial.renderedByTool === undefined
          ? "unread"
          : (trial.renderedByTool.get(toolName)?.rendered ?? 0) >= 1,
      );
      if (held.held !== of || of === 0) continue;
      const predicate = withPredicateRole(
        { type: "widgetRendered", toolName } as Predicate,
        "gate",
      );
      push({
        key: `sugg:${hostedCriterionId(predicate)}`,
        kind: "predicate",
        basis: "held",
        purpose: "Verify the view renders",
        label: `View rendered · ${toolName}`,
        consequence: `Future runs where ${toolName}'s view does not render will fail this case.`,
        evidence: `${toolName} rendered in ${held.held} of ${of} ${plural(of, "trial", "trials")}`,
        predicate,
        placement: { kind: "wholeRun" },
        role: "gate",
        stability: held,
        stage: stageOfPredicate(predicate),
      });
    }
  }

  // ── R7: a click called a tool ─────────────────────────────────────────────
  if (canRequire) {
    const interactSteps = input.steps.filter(
      (step) => step.kind === "interact",
    );
    for (const step of interactSteps) {
      const ordinal = actions.find(
        (action) => action.step.id === step.id,
      )?.ordinal;
      if (ordinal === undefined) continue;
      const named = new Set(
        trials.flatMap((trial) =>
          (trial.clickCalls ?? [])
            .filter((call) => call.authoredStepId === step.id)
            .flatMap((call) => call.calledTools),
        ),
      );
      for (const calledToolName of [...named].sort()) {
        const held = heldInEvery(trials, (trial) =>
          trial.clickCalls === undefined
            ? "unread"
            : trial.clickCalls.some(
                (call) =>
                  call.authoredStepId === step.id &&
                  call.calledTools.includes(calledToolName),
              ),
        );
        if (held.held !== of || of === 0) continue;
        const widgetToolName =
          trials
            .flatMap((trial) => trial.clickCalls ?? [])
            .find((call) => call.authoredStepId === step.id)?.widgetToolName ??
          (step as { toolName?: string }).toolName ??
          "";
        const label =
          trials
            .flatMap((trial) => trial.clickCalls ?? [])
            .find((call) => call.authoredStepId === step.id)?.label ??
          `step ${ordinal}`;
        const assertion: WidgetAssertion = {
          kind: "widgetToolCalled",
          toolName: widgetToolName,
          calledToolName,
        } as WidgetAssertion;
        out.push({
          key: `sugg:widgetToolCalled:${step.id}:${calledToolName}`,
          kind: "widgetAssertion",
          basis: "held",
          purpose: `Verify the click calls ${calledToolName}`,
          label: `View called tool · ${calledToolName}`,
          consequence: `Future runs where step ${ordinal} does not call ${calledToolName} will fail this case.`,
          evidence: `Clicking "${label}" called ${calledToolName} in ${held.held} of ${of}`,
          widgetAssertion: assertion,
          placement: {
            kind: "afterStep",
            anchorStepId: step.id,
            actionOrdinal: ordinal,
            turnIndex:
              turnIndices[input.steps.findIndex((s) => s.id === step.id)] ?? 0,
          },
          role: "gate",
          stability: held,
          stage: WIDGET_ASSERT_STAGE,
        });
      }
    }
  }

  // ── R8: the answer says what the goal said it would ───────────────────────
  if (canRequire && knows("responseContains") && of >= 2) {
    const finals = trials
      .map((trial) => trial.finalMessage)
      .filter((text): text is string => typeof text === "string");
    if (finals.length === of) {
      for (const needle of goalNeedles(
        input.goal,
        finals,
        input.prompts ?? [],
      )) {
        const held = heldInEvery(trials, (trial) =>
          trial.finalMessage === undefined
            ? "unread"
            : typeof trial.finalMessage === "string" &&
              trial.finalMessage.toLowerCase().includes(needle.toLowerCase()),
        );
        if (held.held !== of) continue;
        const predicate = withPredicateRole(
          { type: "responseContains", needle } as Predicate,
          "warn",
        );
        push({
          key: `sugg:${hostedCriterionId(predicate)}`,
          kind: "predicate",
          basis: "held",
          purpose: "Check what the answer says",
          label: `Response contains "${needle}"`,
          evidence: `Every answer contained "${needle}" — from your goal sentence`,
          predicate,
          placement: { kind: "wholeRun" },
          role: "warn",
          stability: held,
          stage: stageOfPredicate(predicate),
        });
      }
    }
  }

  // ── R10 / R11: budgets. Reports, from any observed batch. ─────────────────
  if (knows("tokenBudgetUnder") && !existingKinds.has("tokenBudgetUnder")) {
    const totals = trials.map((trial) => trial.tokensTotal);
    if (
      observed.length > 0 &&
      totals.every((n) => typeof n === "number" && n > 0)
    ) {
      const numbers = totals as number[];
      const max = Math.max(...numbers);
      const min = Math.min(...numbers);
      const tokens = Math.ceil((1.3 * max) / 100) * 100;
      const predicate = withPredicateRole(
        { type: "tokenBudgetUnder", tokens } as Predicate,
        "report",
      );
      push({
        key: `sugg:${hostedCriterionId(predicate)}`,
        kind: "predicate",
        basis: "held",
        purpose: "Track increases in token usage",
        label: `Token budget under ${tokens.toLocaleString()}`,
        evidence:
          min === max
            ? `This run used ${max.toLocaleString()} tokens. The ceiling reports a future increase; it does not mean this run was efficient.`
            : `Used ${min.toLocaleString()}–${max.toLocaleString()} tokens. The ceiling reports a future increase; it does not mean this run was efficient.`,
        predicate,
        placement: { kind: "wholeRun" },
        role: "report",
        stability: { held: of, of, unread: 0 },
        stage: stageOfPredicate(predicate),
      });
    }
  }

  if (knows("turnCountUnder") && !existingKinds.has("turnCountUnder")) {
    const counts = trials.map((trial) => trial.turnCount);
    if (
      observed.length > 0 &&
      counts.every((n) => typeof n === "number") &&
      Math.max(...(counts as number[])) >= 2
    ) {
      const numbers = counts as number[];
      const max = Math.max(...numbers);
      const min = Math.min(...numbers);
      const predicate = withPredicateRole(
        { type: "turnCountUnder", turns: max + 1 } as Predicate,
        "report",
      );
      push({
        key: `sugg:${hostedCriterionId(predicate)}`,
        kind: "predicate",
        basis: "held",
        purpose: "Track longer conversations",
        label: `Fewer than ${max + 1} user turns`,
        evidence:
          min === max
            ? `Resolved in ${max} turns; ceiling ${max + 1}`
            : `Resolved in ${min}–${max} turns; ceiling ${max + 1}`,
        predicate,
        placement: { kind: "wholeRun" },
        role: "report",
        stability: { held: of, of, unread: 0 },
        stage: stageOfPredicate(predicate),
      });
    }
  }

  out.sort((a, b) => {
    if (a.kind === "route") return -1;
    if (b.kind === "route") return 1;
    const aOrd =
      a.placement.kind === "afterStep" ? a.placement.actionOrdinal : 1e9;
    const bOrd =
      b.placement.kind === "afterStep" ? b.placement.actionOrdinal : 1e9;
    if (aOrd !== bOrd) return aOrd - bOrd;
    if (ROLE_ORDER[a.role] !== ROLE_ORDER[b.role]) {
      return ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
    }
    return a.label.localeCompare(b.label);
  });

  return { suggestions: out, diagnosis };
}
