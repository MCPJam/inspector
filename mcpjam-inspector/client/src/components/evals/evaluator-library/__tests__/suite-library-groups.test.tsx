import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { SuiteScorerTable } from "../../suite-scorer-table";
import { clusterByEvaluator } from "../evaluator-stage-rows";
import {
  LIBRARY_EVALUATORS,
  taggedChecks,
  withoutEvaluator,
} from "../library-catalog";
import {
  evaluatorIdForQuestionKey,
  librarySuiteEdits,
} from "../library-suite-edits";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) =>
    name === "evaluator-library" ? flag.on : true,
}));
vi.mock("@/components/chat-v2/chat-input/model/provider-logo", () => ({
  ProviderLogo: () => <span aria-hidden="true" />,
}));

const wasted = { id: "no-wasted-calls", version: 1 };
const tagged: Predicate[] = [
  { type: "noToolErrors" },
  { type: "toolCallCountUnder", count: 10, evaluator: wasted },
  { type: "noRepeatedIdenticalCall", role: "advisory", evaluator: wasted },
];

function renderTable(predicates: Predicate[]) {
  const onPredicatesChange = vi.fn();
  render(
    <SuiteScorerTable
      matchOptions={undefined}
      scope={{ kind: "suite", predicates, onPredicatesChange }}
      judgeConfig={undefined}
      availableModels={[]}
      passOrFailHint=""
      judgeHint=""
    />,
  );
  const next = () => {
    const arg = onPredicatesChange.mock.calls.at(-1)?.[0];
    return typeof arg === "function" ? arg(predicates) : arg;
  };
  return { next };
}

describe("library groups in the suite table", () => {
  it("groups a library evaluator's checks and removes them together", () => {
    const { next } = renderTable(tagged);
    const groups = screen.getAllByRole("region", { name: "No Wasted Calls" });
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0]).toHaveTextContent("v1");
    const remove = within(groups[0]).getByRole("button", {
      name: "Remove No Wasted Calls",
    });
    // Suite settings sits inside a form; a default button would submit it.
    expect(remove).toHaveAttribute("type", "button");
    fireEvent.click(remove);
    expect(next()).toEqual([{ type: "noToolErrors" }]);
  });

  it("puts each default check in its own card with a Default badge", () => {
    renderTable(tagged);
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("li[data-scorer-row]"),
    );
    const grouped = rows.filter((li) => li.closest("[data-evaluator-group]"));
    const defaults = rows.filter((li) => !li.closest("[data-evaluator-group]"));
    expect(grouped.length).toBe(2);
    expect(defaults.length).toBeGreaterThan(0);
    for (const li of defaults) {
      expect(within(li).getByText("Default")).toBeInTheDocument();
    }
    for (const li of grouped) {
      expect(within(li).queryByText("Default")).not.toBeInTheDocument();
    }
    // The authored check keeps its on/off box in the card's header.
    const authored = defaults.find(
      (li) => li.dataset.scorerRow === "predicate",
    );
    expect(authored && within(authored).getByRole("checkbox")).toBeChecked();
  });

  it("hides the library on a deployment that cannot save any of it", () => {
    // No capabilities means a deployment that predates the kind list, which
    // accepts only the legacy kinds. Every library evaluator needs a newer
    // kind, so there is nothing to offer.
    renderTable([]);
    expect(
      screen.queryByRole("button", { name: "From library" }),
    ).not.toBeInTheDocument();
  });

  it("shows no groups or library button with the flag off", () => {
    flag.on = false;
    renderTable(tagged);
    expect(
      screen.queryByRole("region", { name: "No Wasted Calls" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "From library" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
    flag.on = true;
  });
});

describe("library catalog edits", () => {
  it("clusters rows by evaluator in first-appearance order", () => {
    const { loose, clusters } = clusterByEvaluator(tagged, (p) => p);
    expect(loose).toEqual([{ type: "noToolErrors" }]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].rows).toHaveLength(2);
  });

  it("removes only one evaluator's checks", () => {
    expect(withoutEvaluator(tagged, "no-wasted-calls")).toEqual([
      { type: "noToolErrors" },
    ]);
  });

  it("adds, updates and removes an evaluator's questions with its checks", () => {
    let predicates: Predicate[] = [{ type: "noToolErrors" }];
    let judgeConfig: Parameters<typeof librarySuiteEdits>[1] = undefined;
    const edits = () =>
      librarySuiteEdits(
        {
          kind: "suite",
          predicates,
          onPredicatesChange: (next) => {
            predicates = typeof next === "function" ? next(predicates) : next;
          },
        },
        judgeConfig,
        (next) => {
          judgeConfig = next;
        },
      );
    const grounded = LIBRARY_EVALUATORS.find(
      (e) => e.id === "answer-grounded-in-results",
    );
    expect(grounded).toBeDefined();
    if (!grounded) return;
    edits()?.add({
      checks: [],
      questions: [
        {
          id: "answer-grounded-in-results-grounded",
          kind: "yesno",
          label: "Every claim is backed by a tool result",
          instructions: "Check each claim.",
          pass: { answer: "yes" },
          evaluator: { id: "answer-grounded-in-results", version: 1 },
        },
      ],
      judges: [],
    });
    expect(judgeConfig?.rubricChecks?.enabled).toBe(true);
    expect(judgeConfig?.rubricChecks?.questions).toHaveLength(1);
    edits()?.update("answer-grounded-in-results");
    expect(judgeConfig?.rubricChecks?.questions?.[0].instructions).toBe(
      grounded.questions?.[0].instructions,
    );
    edits()?.remove("answer-grounded-in-results");
    expect(judgeConfig?.rubricChecks?.questions).toBeUndefined();
    expect(predicates).toEqual([{ type: "noToolErrors" }]);
  });

  it("keeps a question and a judge added in one click, and removes the judge", () => {
    let judgeConfig: Parameters<typeof librarySuiteEdits>[1] = undefined;
    const edits = () =>
      librarySuiteEdits(
        { kind: "suite", predicates: [], onPredicatesChange: () => {} },
        judgeConfig,
        (next) => {
          judgeConfig = next;
        },
      );
    const judge = {
      id: "answers-the-question-answers",
      label: "Answers what the user asked",
      prompt: "Did it answer? {{final_answer}}",
      output: { kind: "passfail" as const },
      evaluator: { id: "answers-the-question", version: 1 },
    };
    const question = {
      id: "answer-grounded-in-results-grounded",
      kind: "yesno" as const,
      label: "Grounded",
      instructions: "Check.",
      pass: { answer: "yes" as const },
      evaluator: { id: "answer-grounded-in-results", version: 1 },
    };
    edits()?.add({ checks: [], questions: [question], judges: [judge] });
    expect(judgeConfig?.rubricChecks?.questions).toHaveLength(1);
    expect(judgeConfig?.customJudges?.judges).toEqual([judge]);
    edits()?.remove("answers-the-question");
    expect(judgeConfig?.customJudges?.judges).toEqual([]);
    expect(judgeConfig?.rubricChecks?.questions).toHaveLength(1);
  });

  it("keeps rubric checks off when an evaluator is removed or updated", () => {
    const question = {
      id: "answer-grounded-in-results-grounded",
      kind: "yesno" as const,
      label: "Every claim is backed by a tool result",
      instructions: "Old wording.",
      pass: { answer: "yes" as const },
      evaluator: { id: "answer-grounded-in-results", version: 1 },
    };
    let judgeConfig: Parameters<typeof librarySuiteEdits>[1] = {
      rubricChecks: { enabled: false, questions: [question] },
    };
    const edits = () =>
      librarySuiteEdits(
        { kind: "suite", predicates: [], onPredicatesChange: () => {} },
        judgeConfig,
        (next) => {
          judgeConfig = next;
        },
      );
    edits()?.update("answer-grounded-in-results");
    expect(judgeConfig?.rubricChecks?.enabled).toBe(false);
    expect(judgeConfig?.rubricChecks?.questions?.[0].instructions).not.toBe(
      "Old wording.",
    );
    edits()?.remove("answer-grounded-in-results");
    expect(judgeConfig?.rubricChecks?.enabled).toBe(false);
  });

  it("clears an evaluator's old questions when its new version has none", () => {
    let judgeConfig: Parameters<typeof librarySuiteEdits>[1] = {
      rubricChecks: {
        questions: [
          {
            id: "no-wasted-calls-old",
            kind: "yesno",
            label: "Old question",
            instructions: "Asked by an older version.",
            pass: { answer: "yes" },
            evaluator: { id: "no-wasted-calls", version: 0 },
          },
        ],
      },
    };
    librarySuiteEdits(
      { kind: "suite", predicates: [], onPredicatesChange: () => {} },
      judgeConfig,
      (next) => {
        judgeConfig = next;
      },
    )?.update("no-wasted-calls");
    expect(judgeConfig?.rubricChecks?.questions).toBeUndefined();
  });

  it("maps a rubric-check row back to its library evaluator", () => {
    expect(
      evaluatorIdForQuestionKey("q:answer-grounded-in-results-grounded"),
    ).toBe("answer-grounded-in-results");
    expect(evaluatorIdForQuestionKey("q:my-own-question")).toBeUndefined();
    expect(
      evaluatorIdForQuestionKey("q:reports-tool-errors-mine"),
    ).toBeUndefined();
    expect(evaluatorIdForQuestionKey("c:criterion")).toBeUndefined();
  });
});
