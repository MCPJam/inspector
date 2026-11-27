import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { SuiteScorerTable } from "../../suite-scorer-table";
import { clusterByEvaluator } from "../evaluator-stage-rows";
import type { RubricCheckQuestion } from "@/components/shared/session-quality/judge-config";
import type { EvalJudgeConfig } from "../../types";
import {
  findLibraryEvaluator,
  LIBRARY_EVALUATORS,
  taggedChecks,
  taggedJudges,
  taggedQuestions,
  withLibraryChecks,
  withEvaluatorUpdated,
  withoutEvaluator,
  type LibraryEvaluator,
} from "../library-catalog";
import { librarySuiteEdits } from "../library-suite-edits";

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
      onJudgeConfigChange={vi.fn()}
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
    const groups = screen.getAllByRole("region", { name: /^No Wasted Calls in / });
    expect(groups).toHaveLength(2);
    expect(
      groups[0].querySelector("[aria-hidden] > svg.lucide-route"),
    ).toBeInTheDocument();
    const buttons = groups.map((group) => {
      expect(group).toHaveTextContent("v1");
      return within(group).getByRole("button", {
        name: "Remove No Wasted Calls from all stages",
      });
    });
    // Suite settings sits inside a form; a default button would submit it.
    expect(buttons[0]).toHaveAttribute("type", "button");
    fireEvent.click(buttons[0]);
    expect(next()).toEqual([{ type: "noToolErrors" }]);
  });

  it("puts each check that did not come from the library in its own card", () => {
    const { next } = renderTable(tagged);
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("li[data-scorer-row]"),
    );
    const grouped = rows.filter((li) => li.closest("[data-evaluator-group]"));
    const loose = rows.filter((li) => !li.closest("[data-evaluator-group]"));
    expect(grouped.length).toBe(2);
    expect(loose.length).toBeGreaterThan(0);
    for (const li of loose) {
      expect(li.parentElement).toHaveClass("rounded-lg", "border");
      expect(li.parentElement?.children).toHaveLength(1);
    }
    for (const li of grouped) {
      expect(li.parentElement).not.toHaveClass("border");
    }
    // No badge marks a card as default; only the library group says Library.
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
    // Each card keeps its on/off box in its header, and the box still
    // switches the check: on for a standard check, off for an authored one.
    const offBox = loose
      .filter((li) => li.dataset.scorerRow === "preset")
      .map((li) => within(li).getByRole("checkbox"))
      .find((checkbox) => !checkbox.hasAttribute("disabled"));
    if (!offBox) throw new Error("Expected a standard check that can be turned on");
    expect(offBox).not.toBeChecked();
    fireEvent.click(offBox);
    expect(next()).toHaveLength(tagged.length + 1);
    const authored = loose.find((li) => li.dataset.scorerRow === "predicate");
    if (!authored) throw new Error("Expected the authored check's card");
    const box = within(authored).getAllByRole("checkbox")[0];
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(next()).toEqual(
      tagged.filter((predicate) => predicate.type !== "noToolErrors"),
    );
  });

  it("tags an existing required check when adding the evaluator", () => {
    const evaluator = LIBRARY_EVALUATORS.find((e) => e.id === "actionable-tool-errors");
    if (!evaluator) throw new Error("Expected Actionable Tool Errors");
    expect(withLibraryChecks(
      [{ type: "noToolErrors", role: "required" }],
      taggedChecks(evaluator),
    )).toEqual([
      { type: "noToolErrors", role: "required", evaluator: { id: evaluator.id, version: 1 } },
      { type: "toolErrorNamesInput", role: "advisory", evaluator: { id: evaluator.id, version: 1 } },
    ]);
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
      screen.queryByRole("region", { name: /^No Wasted Calls in / }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "From library" }),
    ).not.toBeInTheDocument();
    for (const li of document.querySelectorAll("li[data-scorer-row]")) {
      expect(li.parentElement).not.toHaveClass("border");
    }
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

  it("keeps different versions of the same evaluator in separate groups", () => {
    const first: Predicate = { type: "noToolErrors", evaluator: wasted };
    const second: Predicate = {
      ...first,
      evaluator: { ...wasted, version: wasted.version + 1 },
    };
    const { clusters } = clusterByEvaluator([first, second], (row) => row);
    expect(clusters.map(({ version, rows }) => ({ version, rows }))).toEqual([
      { version: wasted.version, rows: [first] },
      { version: wasted.version + 1, rows: [second] },
    ]);
  });

  it("removes and replaces only one evaluator's checks", () => {
    expect(withoutEvaluator(tagged, "no-wasted-calls")).toEqual([
      { type: "noToolErrors" },
    ]);
    const edited: Predicate[] = [
      { type: "noToolErrors" },
      { type: "toolCallCountUnder", count: 4, evaluator: wasted },
    ];
    const entry = LIBRARY_EVALUATORS.find((e) => e.id === "no-wasted-calls");
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(withEvaluatorUpdated(edited, "no-wasted-calls")).toEqual([
      { type: "noToolErrors" },
      ...taggedChecks(entry),
    ]);
    expect(withEvaluatorUpdated(edited, "unknown")).toEqual(edited);
  });
});

const reports = findLibraryEvaluator("reports-tool-errors");
if (!reports) throw new Error("Expected Reports Tool Errors");
const [reportsQuestion] = taggedQuestions(reports);

function own(id: string): RubricCheckQuestion {
  return {
    id,
    kind: "yesno",
    label: `Mine ${id}`,
    instructions: "Mine.",
    pass: { answer: "yes" },
  };
}

/** What adding this evaluator to an empty suite would write. */
function questionsOf(entry: LibraryEvaluator) {
  return { checks: [], questions: taggedQuestions(entry), judges: [] };
}

/** Library edits over a draft that applies each change, as the page does. */
function draft(
  judgeConfig: EvalJudgeConfig | undefined,
  predicates: Predicate[] = [],
  judgeLimit = 5,
) {
  const state = { judgeConfig, predicates, judgeWrites: 0 };
  const edits = () => {
    const next = librarySuiteEdits(
      {
        kind: "suite",
        predicates: state.predicates,
        onPredicatesChange: (change) => {
          state.predicates =
            typeof change === "function" ? change(state.predicates) : change;
        },
      },
      state.judgeConfig,
      (change) => {
        state.judgeConfig = change;
        state.judgeWrites += 1;
      },
      judgeLimit,
    );
    if (!next) throw new Error("Expected suite edits");
    return next;
  };
  return { state, edits };
}

/**
 * What the backend stores for a settings save (`mergeOmittedJudgeSlots`): a
 * reserved judge slot the write leaves out keeps its stored value. Undefined
 * is sent as null, which clears the whole config.
 */
function savedJudgeConfig(
  stored: EvalJudgeConfig,
  written: EvalJudgeConfig | undefined,
): EvalJudgeConfig | undefined {
  if (written === undefined) return undefined;
  const saved = { ...written };
  for (const slot of ["groundedness", "rubricChecks"] as const) {
    if (!(slot in written) && stored[slot] !== undefined) {
      Object.assign(saved, { [slot]: stored[slot] });
    }
  }
  return saved;
}

describe("library question edits", () => {
  it("adds and removes an evaluator's question, leaving the config as it was", () => {
    const { state, edits } = draft(undefined, [{ type: "noToolErrors" }]);
    expect(edits().add(questionsOf(reports))).toBeUndefined();
    expect(state.judgeConfig).toEqual({
      rubricChecks: { questions: [reportsQuestion] },
    });
    edits().remove("reports-tool-errors");
    expect(state.judgeConfig).toBeUndefined();
    expect(state.predicates).toEqual([{ type: "noToolErrors" }]);
  });

  it("keeps the rest of the judge config, and an empty slot, when the last question goes", () => {
    const goal = { goalCompletion: { enabled: true } };
    const { state, edits } = draft(goal);
    edits().add(questionsOf(reports));
    edits().remove("reports-tool-errors");
    expect(state.judgeConfig).toEqual({ ...goal, rubricChecks: {} });
  });

  it("removes the last stored question in a way the backend will not restore", () => {
    const stored = {
      goalCompletion: { enabled: true },
      rubricChecks: { questions: [reportsQuestion] },
    };
    const { state, edits } = draft(stored);
    edits().remove("reports-tool-errors");
    expect(state.judgeConfig).toEqual({
      goalCompletion: { enabled: true },
      rubricChecks: {},
    });
    expect(savedJudgeConfig(stored, state.judgeConfig)).toEqual({
      goalCompletion: { enabled: true },
      rubricChecks: {},
    });
    // Leaving the slot out, as before, brings the questions back.
    expect(
      savedJudgeConfig(stored, { goalCompletion: { enabled: true } }),
    ).toEqual(stored);
  });

  it("keeps rubric checks off when adding to a suite that turned them off", () => {
    const { state, edits } = draft({ rubricChecks: { enabled: false } });
    edits().add(questionsOf(reports));
    expect(state.judgeConfig?.rubricChecks).toEqual({
      enabled: false,
      questions: [reportsQuestion],
    });
    edits().remove("reports-tool-errors");
    expect(state.judgeConfig).toEqual({ rubricChecks: { enabled: false } });
  });

  it("keeps rubric checks off when an evaluator is updated or removed", () => {
    const old = {
      ...reportsQuestion,
      instructions: "Old wording.",
      evaluator: { id: reports.id, version: 0 },
    };
    const { state, edits } = draft({
      rubricChecks: { enabled: false, questions: [old] },
    });
    expect(edits().update("reports-tool-errors")).toBeUndefined();
    expect(state.judgeConfig?.rubricChecks).toEqual({
      enabled: false,
      questions: [reportsQuestion],
    });
    edits().remove("reports-tool-errors");
    expect(state.judgeConfig).toEqual({ rubricChecks: { enabled: false } });
  });

  it("updates a question in place, so a version-only update keeps the order", () => {
    const old = {
      ...reportsQuestion,
      evaluator: { id: reports.id, version: 0 },
    };
    const { state, edits } = draft({
      rubricChecks: { questions: [own("first"), old, own("last")] },
    });
    edits().update("reports-tool-errors");
    expect(state.judgeConfig?.rubricChecks?.questions).toEqual([
      own("first"),
      reportsQuestion,
      own("last"),
    ]);
  });

  it("clears an evaluator's old questions when its new version has none", () => {
    const { state, edits } = draft({
      rubricChecks: {
        questions: [
          {
            ...own("no-wasted-calls-old"),
            evaluator: { id: "no-wasted-calls", version: 0 },
          },
        ],
      },
    });
    edits().update("no-wasted-calls");
    expect(state.judgeConfig).toBeUndefined();
  });

  it("clears the stored slot when an update empties it beside other config", () => {
    const stored = {
      goalCompletion: { threshold: 0.8 },
      rubricChecks: {
        questions: [
          {
            ...own("no-wasted-calls-old"),
            evaluator: { id: "no-wasted-calls", version: 0 },
          },
        ],
      },
    };
    const { state, edits } = draft(stored);
    edits().update("no-wasted-calls");
    expect(savedJudgeConfig(stored, state.judgeConfig)).toEqual({
      goalCompletion: { threshold: 0.8 },
      rubricChecks: {},
    });
  });

  it("writes no judge config when a check-only evaluator is updated", () => {
    const { state, edits } = draft(undefined, tagged);
    edits().update("no-wasted-calls");
    expect(state.judgeWrites).toBe(0);
  });

  it("refuses an add past the cap instead of dropping questions", () => {
    const full = Array.from({ length: 10 }, (_, i) => own(`mine-${i}`));
    const { state, edits } = draft({ rubricChecks: { questions: full } });
    expect(edits().add(questionsOf(reports))).toBe(
      "Suites can ask up to 10 rubric-check questions, and adding this evaluator would make 11. Remove a question first.",
    );
    expect(state.judgeWrites).toBe(0);
    expect(state.judgeConfig?.rubricChecks?.questions).toEqual(full);
  });

  it("refuses an update whose question ID the author already uses, and says so up front", () => {
    const old = {
      ...reportsQuestion,
      id: "reports-tool-errors-older",
      evaluator: { id: reports.id, version: 0 },
    };
    const mine = own(reportsQuestion.id);
    const { state, edits } = draft({
      rubricChecks: { questions: [old, mine] },
    });
    const reason =
      'A question already uses the ID "reports-tool-errors-reports-failures". Rename or remove it to update this evaluator.';
    expect(edits().updateRefusal("reports-tool-errors")).toBe(reason);
    expect(edits().update("reports-tool-errors")).toBe(reason);
    expect(state.judgeWrites).toBe(0);
    expect(edits().updateRefusal("no-wasted-calls")).toBeUndefined();
  });

  it("shows the refusal in place of Update in the suite table", () => {
    const old = {
      ...reportsQuestion,
      id: "reports-tool-errors-older",
      evaluator: { id: reports.id, version: 0 },
    };
    render(
      <SuiteScorerTable
        matchOptions={undefined}
        scope={{ kind: "suite", predicates: [], onPredicatesChange: vi.fn() }}
        judgeConfig={{
          rubricChecks: { questions: [old, own(reportsQuestion.id)] },
        }}
        onJudgeConfigChange={vi.fn()}
        availableModels={[]}
        passOrFailHint=""
        judgeHint=""
      />,
    );
    const group = screen.getByRole("region", {
      name: /^Reports Tool Errors in .*, version 0$/,
    });
    expect(
      within(group).queryByRole("button", {
        name: /^Update Reports Tool Errors/,
      }),
    ).not.toBeInTheDocument();
    expect(group).toHaveTextContent(
      'v1 available. A question already uses the ID "reports-tool-errors-reports-failures".',
    );
  });
});

describe("assertions written from scratch", () => {
  it("adds a required assertion beside an advisory one with the same criterion", () => {
    const advisory: Predicate = {
      type: "finalAssistantMessageNonEmpty",
      role: "advisory",
    };
    const { state, edits } = draft(undefined, [advisory]);
    expect(
      edits().add({
        checks: [{ type: "finalAssistantMessageNonEmpty" }],
        questions: [],
        judges: [],
      }),
    ).toBeUndefined();
    expect(state.predicates).toEqual([
      advisory,
      { type: "finalAssistantMessageNonEmpty" },
    ]);
  });
});

describe("library judge edits", () => {
  const answers = findLibraryEvaluator("answers-the-question");
  if (!answers) throw new Error("Expected Answers the Question");
  const [answersJudge] = taggedJudges(answers);
  const mine = {
    id: "mine",
    label: "Mine",
    prompt: "Judge {{final_answer}}",
    output: { kind: "passfail" as const },
  };

  it("keeps a question and a judge added in one click, and removes the judge", () => {
    const { state, edits } = draft(undefined);
    expect(
      edits().add({
        checks: [],
        questions: taggedQuestions(reports),
        judges: [answersJudge],
      }),
    ).toBeUndefined();
    expect(state.judgeWrites).toBe(1);
    expect(state.judgeConfig?.rubricChecks?.questions).toEqual([reportsQuestion]);
    expect(state.judgeConfig?.customJudges?.judges).toEqual([answersJudge]);
    edits().remove("answers-the-question");
    expect(state.judgeConfig?.customJudges?.judges).toEqual([]);
    expect(state.judgeConfig?.rubricChecks?.questions).toEqual([reportsQuestion]);
  });

  it("keeps a paused judge group paused when a library judge is added", () => {
    const { state, edits } = draft({
      customJudges: { enabled: false, judges: [mine] },
    });
    edits().add({ checks: [], questions: [], judges: [answersJudge] });
    expect(state.judgeConfig?.customJudges).toEqual({
      enabled: false,
      judges: [mine, answersJudge],
    });
  });

  it("refuses a judge past the backend's limit instead of dropping it", () => {
    const { state, edits } = draft(
      { customJudges: { judges: [mine] } },
      [],
      1,
    );
    expect(
      edits().add({ checks: [], questions: [], judges: [answersJudge] }),
    ).toBe(
      "Suites can have up to 1 judge, and adding this evaluator would make 2. Remove a judge first.",
    );
    expect(state.judgeWrites).toBe(0);
  });
});
