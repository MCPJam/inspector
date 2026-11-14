/**
 * Edits the steps editor makes to its draft, as pure functions.
 *
 * Every step edit goes through the flat list (`insertStepAfter`,
 * `moveAssertionTo`, the case-spine mutators); the route rule writes
 * `toolsChoice`, `kind` and `matchOptions` the way `case-spine.tsx` does.
 */
import { isTurnScopablePredicateKind } from "@mcpjam/sdk/predicates";
import type { CaseSaveForm } from "@/components/evals/case-save-payload";
import type { EvalAddChoice } from "@/components/evals/eval-add-catalog";
import {
  blankStepOfKind,
  defaultWidgetAssertion,
} from "@/components/evals/step-fields";
import { resolveMatchOptions, type Predicate } from "@/shared/eval-matching";
import { blankPredicate } from "@/shared/predicate-kinds";
import {
  actionRows,
  insertStepAfter,
  newStepId,
  type AssertStep,
  type TestStep,
} from "@/shared/steps";
import {
  matchOptionsForKind,
  readSimpleCase,
  writeSimpleCase,
  type CaseKind,
  type SimpleCaseTool,
  type ToolsChoice,
} from "../simple-case/simple-case-model";

export type CaseStepsDraft = CaseSaveForm & {
  expectedOutput: string;
  /** Seeds isNegativeTest on save. */
  toolsChoice: ToolsChoice;
  /** Tool asserts parked while "No tools" is on. */
  stashedTools: SimpleCaseTool[];
};

export type DraftEdit = (draft: CaseStepsDraft) => CaseStepsDraft;

/** What an edit opens afterwards, as an editor row key. */
export type EditResult = { edit: DraftEdit; openKey: string | null };

export const chooseNoTool: DraftEdit = (draft) => {
  const view = readSimpleCase(draft.steps);
  return {
    ...draft,
    toolsChoice: "noTool",
    stashedTools:
      draft.toolsChoice === "noTool" ? draft.stashedTools : view.tools,
    steps: writeSimpleCase(draft.steps, {
      prompt: view.prompt,
      tools: view.tools,
      noTool: true,
    }),
  };
};

/** Back to tools; brings the parked tool asserts back when the case has none. */
export const chooseTools: DraftEdit = (draft) => {
  const view = readSimpleCase(draft.steps);
  if (view.tools.length > 0 || draft.stashedTools.length === 0) {
    return { ...draft, toolsChoice: "tools" };
  }
  return {
    ...draft,
    toolsChoice: "tools",
    steps: writeSimpleCase(draft.steps, {
      prompt: view.prompt,
      tools: draft.stashedTools,
      noTool: false,
    }),
  };
};

export function setCaseKind(
  draft: CaseStepsDraft,
  kind: CaseKind,
  suiteDefaultMatchOptions: CaseSaveForm["matchOptions"],
): CaseStepsDraft {
  const resolved = resolveMatchOptions(
    suiteDefaultMatchOptions,
    draft.matchOptions,
  );
  return { ...draft, kind, matchOptions: matchOptionsForKind(kind, resolved) };
}

export function updateStep(
  draft: CaseStepsDraft,
  next: TestStep,
): CaseStepsDraft {
  return {
    ...draft,
    steps: draft.steps.map((step) => (step.id === next.id ? next : step)),
  };
}

/** Where a newly added case predicate lands in the list. */
export function nextCasePredicateIndex(draft: CaseStepsDraft): number {
  const current = draft.predicates;
  return current && current.mode !== "inherit" ? current.list.length : 0;
}

/** A new case predicate; inherit switches to extend so suite defaults stay. */
export function addCasePredicate(
  draft: CaseStepsDraft,
  predicate: Predicate,
): CaseStepsDraft {
  const current = draft.predicates;
  const mode = !current || current.mode === "inherit" ? "extend" : current.mode;
  const list = current && current.mode !== "inherit" ? current.list : [];
  return { ...draft, predicates: { mode, list: [...list, predicate] } };
}

export function setCasePredicates(
  draft: CaseStepsDraft,
  update: (list: Predicate[]) => Predicate[],
): CaseStepsDraft {
  const current = draft.predicates;
  return {
    ...draft,
    predicates: {
      mode: current?.mode ?? "extend",
      list: update(current?.list ?? []),
    },
  };
}

export function setEnvelopeMode(
  draft: CaseStepsDraft,
  mode: "extend" | "replace",
): CaseStepsDraft {
  return {
    ...draft,
    predicates: { mode, list: draft.predicates?.list ?? [] },
  };
}

/** Insert an assertion after a step's last assertion and open it. */
export function insertAssertion(
  anchorId: string | null,
  assertion: AssertStep["assertion"],
): EditResult {
  const step: AssertStep = {
    id: newStepId("assert"),
    kind: "assert",
    assertion,
  };
  return {
    edit: (draft) => ({
      ...draft,
      steps: insertStepAfter(draft.steps, anchorId, step),
    }),
    openKey: `check:${step.id}`,
  };
}

/** A per-step add: widget assertions and turn-scopable predicates. */
export function addAssertionAt(
  anchorId: string | null,
  choice: EvalAddChoice,
  viewTool: string,
): EditResult | null {
  if (choice.kind === "widget-check") {
    return insertAssertion(
      anchorId,
      defaultWidgetAssertion(choice.widgetKind, viewTool),
    );
  }
  if (choice.kind !== "check") return null;
  const added = insertAssertion(anchorId, blankPredicate(choice.predicateKind));
  if (choice.predicateKind !== "toolCalledWith") return added;
  return {
    ...added,
    edit: (draft) =>
      added.edit(draft.toolsChoice === "noTool" ? chooseTools(draft) : draft),
  };
}

/** After-run adds: route rules and whole-run predicates. */
export function addAfterRun(
  choice: EvalAddChoice,
  suiteDefaultMatchOptions: CaseSaveForm["matchOptions"],
  nextCaseIndex: number,
): EditResult | null {
  if (choice.kind === "route-check") {
    if (choice.routeKind === "noTools") {
      return { edit: chooseNoTool, openKey: "route" };
    }
    return {
      edit: (draft) => {
        let next = draft.toolsChoice === "noTool" ? chooseTools(draft) : draft;
        next = setCaseKind(next, "regression", suiteDefaultMatchOptions);
        if (readSimpleCase(next.steps).tools.length > 0) return next;
        const first = actionRows(next.steps).actions[0];
        return insertAssertion(
          first?.step.id ?? null,
          blankPredicate("toolCalledWith"),
        ).edit({ ...next, toolsChoice: "tools" });
      },
      openKey: "route",
    };
  }
  if (choice.kind !== "check") return null;
  return {
    edit: (draft) =>
      addCasePredicate(draft, blankPredicate(choice.predicateKind)),
    openKey: `case:${nextCaseIndex}`,
  };
}

/** The add rail: steps append, per-step kinds go after the last step, the rest to After-run. */
export function addAnything(
  choice: EvalAddChoice,
  context: {
    lastActionId: string | null;
    suiteServers: string[];
    viewTool: string;
    suiteDefaultMatchOptions: CaseSaveForm["matchOptions"];
    nextCaseIndex: number;
  },
): EditResult | null {
  if (choice.kind === "step") {
    const step = blankStepOfKind(choice.stepKind, context.suiteServers);
    return {
      edit: (draft) => ({
        ...draft,
        steps: insertStepAfter(draft.steps, context.lastActionId, step),
      }),
      openKey: step.kind === "prompt" ? null : `action:${step.id}`,
    };
  }
  if (
    choice.kind === "route-check" ||
    (choice.kind === "check" &&
      !isTurnScopablePredicateKind(choice.predicateKind))
  ) {
    return addAfterRun(
      choice,
      context.suiteDefaultMatchOptions,
      context.nextCaseIndex,
    );
  }
  return addAssertionAt(context.lastActionId, choice, context.viewTool);
}
