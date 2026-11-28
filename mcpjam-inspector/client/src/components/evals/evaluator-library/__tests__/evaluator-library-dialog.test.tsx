import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, within } from "@/test";
import { EvaluatorLibraryButton } from "../evaluator-library-dialog";
import { predicateSchema } from "@mcpjam/sdk/predicates";
import {
  findLibraryEvaluator,
  isInSuite,
  LIBRARY_EVALUATORS,
  missingChecks,
  taggedChecks,
  taggedJudges,
  withEvaluatorUpdated,
} from "../library-catalog";
import { judgeProblem } from "../custom-judges-model";
import { libraryModelRows } from "../library-suite-edits";
import type { EvalJudgeConfig } from "../../types";

const flag = vi.hoisted(() => ({ on: true as boolean | undefined }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) =>
    name === "evaluator-library" ? flag.on : undefined,
}));

// Method cards stay closed here, so only presets decide what shows.
const libraryProps = {
  pause: {},
  authoring: {
    methods: {
      assertions: "Not here.",
      decision: "Not here.",
      judge: "Not here.",
    },
    render: () => null,
  },
};

function open(onAdd = vi.fn(), predicates = []) {
  renderWithProviders(
    <EvaluatorLibraryButton
      suite={{ predicates }}
      support={{ canAskYesNo: true, canJudge: true }}
      onAdd={onAdd}
      judgeLimit={5}
      {...libraryProps}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "From library" }));
  return onAdd;
}

describe("EvaluatorLibraryButton", () => {
  it("renders nothing while the flag is off or loading", () => {
    flag.on = undefined;
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{ predicates: [] }}
        support={{}}
        onAdd={() => undefined}
        judgeLimit={5}
        {...libraryProps}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "From library" }),
    ).not.toBeInTheDocument();
    flag.on = true;
  });

  it("adds an evaluator's assertions from its card", () => {
    const onAdd = open();
    fireEvent.click(
      screen.getByRole("button", { name: "Add No Wasted Calls to suite" }),
    );
    const tag = { id: "no-wasted-calls", version: 1 };
    expect(onAdd).toHaveBeenCalledWith({
      checks: [
        { type: "toolCallCountUnder", count: 10, evaluator: tag },
        { type: "noRepeatedIdenticalCall", role: "advisory", evaluator: tag },
      ],
      questions: [],
      judges: [],
    });
  });

  it("opens the detail with each assertion and adds from there", () => {
    const onAdd = open();
    fireEvent.click(
      screen.getByRole("button", { name: "Valid Tool Arguments" }),
    );
    expect(
      screen.getByRole("list", { name: "What this evaluator adds" }),
    ).toHaveTextContent("Arguments match the tool's schema");
    fireEvent.click(screen.getByRole("button", { name: "Add to suite" }));
    expect(onAdd).toHaveBeenCalledWith({
      checks: [
        {
          type: "argumentsMatchToolSchema",
          evaluator: { id: "valid-tool-arguments", version: 1 },
        },
      ],
      questions: [],
      judges: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
    expect(screen.getByText("Evaluator library")).toBeInTheDocument();
  });

  it("offers to include existing untagged assertions in the evaluator", () => {
    const onAdd = vi.fn();
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{ predicates: [{ type: "noToolErrors" }] }}
        support={{}}
        onAdd={onAdd}
        judgeLimit={5}
        {...libraryProps}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Actionable Tool Errors to suite",
      }),
    );
    expect(onAdd).toHaveBeenCalledWith({
      checks: [
        {
          type: "noToolErrors",
          evaluator: { id: "actionable-tool-errors", version: 1 },
        },
        {
          type: "toolErrorNamesInput",
          role: "advisory",
          evaluator: { id: "actionable-tool-errors", version: 1 },
        },
      ],
      questions: [],
      judges: [],
    });
  });

  it("hides evaluators this deployment cannot save", () => {
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{ predicates: [] }}
        support={{ authorableKinds: ["noToolErrors", "toolErrorNamesInput"] }}
        onAdd={() => undefined}
        judgeLimit={5}
        {...libraryProps}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    expect(screen.getByText("Actionable Tool Errors")).toBeInTheDocument();
    expect(screen.queryByText("No Wasted Calls")).not.toBeInTheDocument();
  });

  it("explains a preset question ID conflict without marking it installed", () => {
    const onAdd = vi.fn();
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{
          predicates: [],
          questions: [
            {
              id: "reports-tool-errors-reports-failures",
              kind: "yesno",
              label: "My question",
              instructions: "Grade my custom criterion.",
              pass: { answer: "yes" },
            },
          ],
        }}
        support={{ canAskYesNo: true }}
        onAdd={onAdd}
        judgeLimit={5}
        {...libraryProps}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    expect(
      screen.getByRole("button", { name: "Add Reports Tool Errors to suite" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Reports Tool Errors" }),
    );
    const add = screen.getByRole("button", { name: "Add to suite" });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(
      'A question already uses the ID "reports-tool-errors-reports-failures". Rename or remove it to add this evaluator.',
    );
    expect(onAdd).not.toHaveBeenCalled();
  });
  it("filters within a category and keeps it after inspecting a preset", () => {
    open();
    const categories = within(
      screen.getByRole("group", { name: "Evaluator categories" }),
    );
    fireEvent.click(categories.getByRole("button", { name: "Final answer" }));
    expect(
      categories.getByRole("button", { name: "Final answer" }),
    ).toHaveAttribute("aria-pressed", "true");
    // One h2 (the dialog title), the view's h3, then preset h4s.
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 3, name: "Final answer" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 4, name: "Answers the Question" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "No Wasted Calls" }),
    ).not.toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search presets" });
    fireEvent.change(search, { target: { value: "  expected outcome  " } });
    fireEvent.click(
      screen.getByRole("button", { name: "Meets the Expected Outcome" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
    expect(search).toHaveValue("  expected outcome  ");
    expect(
      screen.getByRole("button", { name: "Meets the Expected Outcome" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Answers the Question" }),
    ).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "nothing matches this" } });
    expect(screen.getByRole("status")).toHaveTextContent("No presets match");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(
      screen.getByRole("button", { name: "Answers the Question" }),
    ).toBeVisible();
    // The focused button is gone, so focus goes where the next query is typed.
    expect(search).toHaveFocus();
  });

  it("shows a new search from the top and keeps the place after details", () => {
    open();
    const pane = screen.getByRole("region", {
      name: "Calling tools",
    }).parentElement;
    if (!pane) throw new Error("The results pane is missing.");
    Object.defineProperty(pane, "scrollTop", { value: 300, writable: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Valid Tool Arguments" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
    expect(pane.scrollTop).toBe(300);
    const search = screen.getByRole("searchbox", { name: "Search presets" });
    fireEvent.change(search, { target: { value: "tool" } });
    expect(pane.scrollTop).toBe(0);
  });

  it("steps back from preset details on Escape before closing", () => {
    open();
    const categories = within(
      screen.getByRole("group", { name: "Evaluator categories" }),
    );
    fireEvent.click(categories.getByRole("button", { name: "Final answer" }));
    const search = screen.getByRole("searchbox", { name: "Search presets" });
    fireEvent.change(search, { target: { value: "expected outcome" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Meets the Expected Outcome" }),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Evaluator library" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Back to library" }),
    ).not.toBeInTheDocument();
    expect(search).toHaveValue("expected outcome");
    expect(
      categories.getByRole("button", { name: "Final answer" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Meets the Expected Outcome" }),
    ).toBeVisible();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("library catalog", () => {
  it("only holds checks the save validator accepts, tag included", () => {
    for (const evaluator of LIBRARY_EVALUATORS) {
      for (const check of taggedChecks(evaluator)) {
        const parsed = predicateSchema.safeParse(check);
        expect(parsed.success, `${evaluator.id}: ${check.type}`).toBe(true);
      }
    }
  });

  it("has unique ids and knows when a suite already has an evaluator", () => {
    const ids = LIBRARY_EVALUATORS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const wasted = LIBRARY_EVALUATORS.find((e) => e.id === "no-wasted-calls");
    expect(wasted).toBeDefined();
    if (!wasted) return;
    expect(isInSuite(wasted, { predicates: taggedChecks(wasted) })).toBe(true);
    expect(isInSuite(wasted, { predicates: [...wasted.checks] })).toBe(false);
    expect(isInSuite(wasted, { predicates: [{ type: "noToolErrors" }] })).toBe(
      false,
    );
  });
});

describe("library dedupe by criterion", () => {
  const wasted = findLibraryEvaluator("no-wasted-calls");
  const schema = findLibraryEvaluator("results-match-output-schema");
  if (!wasted || !schema) throw new Error("Expected library evaluators");

  it("adds a check whose arguments differ from the suite's", () => {
    const scoped = [
      { type: "toolCallCountUnder", count: 3, toolName: "search" },
    ] as const;
    expect(missingChecks(wasted, [...scoped]).map((c) => c.type)).toEqual([
      "toolCallCountUnder",
      "noRepeatedIdenticalCall",
    ]);
  });

  it("is not in the suite because of an authored schema for one tool", () => {
    const authored = {
      type: "toolResultMatchesSchema",
      toolName: "get_order",
      schema: { type: "object" },
    } as const;
    expect(isInSuite(schema, { predicates: [authored] })).toBe(false);
  });

  it("matches tagged checks regardless of role", () => {
    const evaluator = { id: wasted.id, version: wasted.version };
    expect(
      isInSuite(wasted, {
        predicates: [
          { type: "toolCallCountUnder", count: 10, role: "advisory", evaluator },
          { type: "noRepeatedIdenticalCall", evaluator },
        ],
      }),
    ).toBe(true);
  });

  it("tags a hand-written copy on update instead of duplicating it", () => {
    const handWritten = {
      type: "toolCallCountUnder",
      count: 10,
      role: "required",
    } as const;
    const next = withEvaluatorUpdated(
      [handWritten, ...taggedChecks(wasted).slice(1)],
      "no-wasted-calls",
    );
    // Tagged so the evaluator's card still counts it; its role is kept.
    expect(next.filter((p) => p.type === "toolCallCountUnder")).toEqual([
      { ...handWritten, evaluator: { id: wasted.id, version: wasted.version } },
    ]);
    expect(next.filter((p) => p.type === "noRepeatedIdenticalCall")).toHaveLength(1);
  });
});

describe("Results Match Output Schema", () => {
  it("reads each tool's declared schema and labels it that way", () => {
    const entry = LIBRARY_EVALUATORS.find(
      (e) => e.id === "results-match-output-schema",
    );
    expect(entry?.checks).toEqual([
      { type: "toolResultMatchesSchema", schema: "declared" },
    ]);
    const onAdd = open();
    fireEvent.click(
      screen.getByRole("button", { name: "Results Match Output Schema" }),
    );
    expect(
      screen.getByRole("list", { name: "What this evaluator adds" }),
    ).toHaveTextContent("Every tool result matches its declared output schema");
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Catch changes to structured results that could break clients that rely on the declared output schema.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to suite" }));
    expect(onAdd).toHaveBeenCalledWith({
      checks: [
        {
          type: "toolResultMatchesSchema",
          schema: "declared",
          evaluator: { id: "results-match-output-schema", version: 1 },
        },
      ],
      questions: [],
      judges: [],
    });
  });
});

describe("question-only evaluators", () => {
  it("adds a tagged yes/no question and no assertions", () => {
    const onAdd = open();
    fireEvent.click(
      screen.getByRole("button", { name: "Reports Tool Errors" }),
    );
    expect(
      screen.getByRole("list", { name: "What this evaluator adds" }),
    ).toHaveTextContent("Yes/no question. Passes on Yes.");
    expect(
      screen.getByText(/Answer yes only if the tool trajectory/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to suite" }));
    expect(onAdd).toHaveBeenCalledWith({
      checks: [],
      questions: [
        expect.objectContaining({
          id: "reports-tool-errors-reports-failures",
          kind: "yesno",
          pass: { answer: "yes" },
          evaluator: { id: "reports-tool-errors", version: 1 },
        }),
      ],
      judges: [],
    });
  });

  it("asks nothing the grader cannot see, so an unseen error cannot pass", () => {
    const entry = findLibraryEvaluator("reports-tool-errors");
    expect(entry?.questions).toHaveLength(1);
    const [question] = entry?.questions ?? [];
    expect(question?.passOn).toBe("yes");
    expect(question?.instructions).toMatch(/every tool call/);
    expect(question?.instructions).toMatch(/Answer no in every other case/);
    expect(findLibraryEvaluator("answer-grounded-in-results")).toBeUndefined();
  });

  it("keeps every question inside the grader's instruction clip", () => {
    // The backend clips a question's instructions at 600 characters.
    for (const evaluator of LIBRARY_EVALUATORS) {
      for (const q of evaluator.questions ?? []) {
        expect(q.instructions.length, q.slug).toBeLessThanOrEqual(600);
      }
    }
  });
});

describe("yes/no capability", () => {
  it("hides question evaluators on a deployment that cannot ask yes/no", () => {
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{ predicates: [] }}
        support={{}}
        onAdd={() => undefined}
        judgeLimit={5}
        {...libraryProps}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    expect(screen.getByText("No Wasted Calls")).toBeInTheDocument();
    expect(screen.queryByText("Reports Tool Errors")).not.toBeInTheDocument();
  });
});

describe("judge evaluators", () => {
  it("adds a tagged judge and says each judge is charged separately", () => {
    const onAdd = open();
    expect(
      screen
        .getByRole("heading", { name: "Answers the Question" })
        .closest("article"),
    ).toHaveTextContent(
      "Each judge adds a charged model call per graded iteration.",
    );
    expect(
      screen.getByRole("heading", { name: "No Wasted Calls" }).closest("article"),
    ).not.toHaveTextContent("charged model call");
    fireEvent.click(screen.getByRole("button", { name: "Answers the Question" }));
    const adds = screen.getByRole("list", { name: "What this evaluator adds" });
    expect(adds).toHaveTextContent("Returns pass or fail.");
    expect(adds).toHaveTextContent(
      "Each judge adds a charged model call per graded iteration.",
    );
    expect(adds).not.toHaveTextContent("Runs with the goal-completion judge");
    expect(adds).toHaveTextContent("Judge only the content of the final answer");
    expect(screen.getByRole("table")).toHaveTextContent("The user's request");
    expect(screen.getByRole("table")).toHaveTextContent("{{final_answer}}");
    fireEvent.click(screen.getByRole("button", { name: "Add to suite" }));
    expect(onAdd).toHaveBeenCalledWith({
      checks: [],
      questions: [],
      judges: [
        expect.objectContaining({
          id: "answers-the-question-answers",
          output: { kind: "passfail" },
          evaluator: { id: "answers-the-question", version: 1 },
        }),
      ],
    });
  });

  it("keeps a customized judge in the suite instead of offering it again", () => {
    let judgeConfig: EvalJudgeConfig | undefined;
    const library = (config: EvalJudgeConfig | undefined) => (
      <EvaluatorLibraryButton
        suite={{ predicates: [], judges: config?.customJudges?.judges ?? [] }}
        support={{ canJudge: true }}
        onAdd={(addition) => {
          judgeConfig = { customJudges: { judges: addition.judges } };
          return undefined;
        }}
        judgeLimit={5}
        {...libraryProps}
      />
    );
    const { rerender } = renderWithProviders(library(judgeConfig));
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Add Answers the Question to suite" }),
    );
    libraryModelRows(judgeConfig, (next) => {
      judgeConfig = next;
    })[0].onCustomize?.();
    expect(judgeConfig?.customJudges?.judges?.[0].evaluator).toBeUndefined();
    rerender(library(judgeConfig));
    expect(
      screen.queryByRole("button", {
        name: "Add Answers the Question to suite",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getByRole("heading", { name: "Answers the Question" })
        .closest("article"),
    ).toHaveTextContent("In suite");
    fireEvent.click(
      screen.getByRole("button", { name: "Answers the Question" }),
    );
    expect(screen.getByText("In this suite")).toHaveAttribute("role", "status");
    expect(
      screen.queryByRole("button", { name: "Add to suite" }),
    ).not.toBeInTheDocument();
  });

  it("shows the configured passing score and keeps the preset read-only", () => {
    open();
    fireEvent.click(
      screen.getByRole("button", { name: "Clear, Concise Answer" }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Scores from 0 to 1. Passes at 0.7 or higher.",
    );
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("hides judge evaluators where the backend cannot run them", () => {
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{ predicates: [] }}
        support={{ canAskYesNo: true }}
        onAdd={() => undefined}
        judgeLimit={5}
        {...libraryProps}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    expect(screen.queryByText("Answers the Question")).not.toBeInTheDocument();
  });

  it("refuses a judge past the backend's judge limit and says why", () => {
    const onAdd = vi.fn();
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{
          predicates: [],
          judges: [
            {
              id: "mine",
              label: "Mine",
              prompt: "{{final_answer}}",
              output: { kind: "passfail" },
            },
          ],
        }}
        support={{ canJudge: true }}
        onAdd={onAdd}
        judgeLimit={1}
        {...libraryProps}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    fireEvent.click(screen.getByRole("button", { name: "Answers the Question" }));
    const addFromDetails = screen.getByRole("button", { name: "Add to suite" });
    expect(addFromDetails).toBeDisabled();
    expect(addFromDetails).toHaveAccessibleDescription(
      "Suites can have up to 1 judge, and adding this evaluator would make 2. Remove a judge first.",
    );
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("only ships judges the backend's checks accept", () => {
    for (const evaluator of LIBRARY_EVALUATORS) {
      for (const judge of taggedJudges(evaluator)) {
        expect(
          judgeProblem(
            judge,
            [],
            [
              "user_prompt",
              "final_answer",
              "tool_calls",
              "tool_results",
              "expected_output",
            ],
            4000,
          ),
          judge.id,
        ).toBeUndefined();
      }
    }
  });
});

describe("question cap", () => {
  it("offers no Add for a question evaluator when the suite is full", () => {
    const full = Array.from({ length: 10 }, (_, i) => ({
      id: `mine-${i}`,
      kind: "yesno" as const,
      label: `Mine ${i}`,
      instructions: "Mine.",
      pass: { answer: "yes" as const },
    }));
    const onAdd = vi.fn();
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{ predicates: [], questions: full }}
        support={{ canAskYesNo: true }}
        onAdd={onAdd}
        judgeLimit={5}
        {...libraryProps}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    expect(
      screen.getByRole("button", { name: "Add Reports Tool Errors to suite" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Add No Wasted Calls to suite" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Reports Tool Errors" }),
    );
    const addFromDetails = screen.getByRole("button", { name: "Add to suite" });
    expect(addFromDetails).toBeDisabled();
    expect(addFromDetails).toHaveAccessibleDescription(
      "Suites can ask up to 10 rubric-check questions, and adding this evaluator would make 11. Remove a question first.",
    );
    expect(onAdd).not.toHaveBeenCalled();
  });
});
