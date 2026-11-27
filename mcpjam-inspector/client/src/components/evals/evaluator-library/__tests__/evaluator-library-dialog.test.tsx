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
import { MAX_RUBRIC_CHECK_QUESTIONS } from "@/components/shared/session-quality/judge-config";
import { blankRubricCheckQuestion } from "../../rubric-checks-model";

const flag = vi.hoisted(() => ({ on: true as boolean | undefined }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) =>
    name === "evaluator-library" ? flag.on : undefined,
}));

function open(onAdd = vi.fn(), predicates = []) {
  renderWithProviders(
    <EvaluatorLibraryButton
      suite={{ predicates }}
      support={{ canAskYesNo: true, canJudge: true }}
      onAdd={onAdd}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "From library" }));
  return onAdd;
}

describe("EvaluatorLibraryButton", () => {
  it("reports a saved authored ID collision without treating the preset as installed", () => {
    const onAdd = vi.fn();
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{
          predicates: [],
          questions: [
            {
              ...blankRubricCheckQuestion("yesno", []),
              id: "answer-grounded-in-results-grounded",
              label: "My question",
            },
          ],
        }}
        support={{ canAskYesNo: true }}
        onAdd={onAdd}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    expect(
      screen.getByRole("button", {
        name: "Add Answer Grounded in Results to suite",
      }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Answer Grounded in Results" }),
    );
    const addFromDetails = screen.getByRole("button", { name: "Add to suite" });
    expect(addFromDetails).toBeDisabled();
    expect(addFromDetails).toHaveAccessibleDescription(
      /already uses this preset/,
    );
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("disables adding decision presets at capacity from the card and details", () => {
    const onAdd = vi.fn();
    const questions = Array.from(
      { length: MAX_RUBRIC_CHECK_QUESTIONS },
      (_, i) => ({
        ...blankRubricCheckQuestion("yesno", []),
        id: `existing-${i}`,
      }),
    );
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{ predicates: [], questions }}
        support={{ canAskYesNo: true }}
        onAdd={onAdd}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    const add = screen.getByRole("button", {
      name: "Add Answer Grounded in Results to suite",
    });
    expect(add).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Add No Wasted Calls to suite" }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Answer Grounded in Results" }),
    );
    const addFromDetails = screen.getByRole("button", { name: "Add to suite" });
    expect(addFromDetails).toBeDisabled();
    expect(
      within(addFromDetails.parentElement!).getByText(
        "Remove a decision question to add this preset.",
      ),
    ).toBeVisible();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("filters within a category and retains it after inspecting a preset", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Final answer" }));
    expect(screen.getByRole("button", { name: "Final answer" })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("button", { name: "No Wasted Calls" })).not.toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search presets" });
    fireEvent.change(search, { target: { value: "  expected outcome  " } });
    fireEvent.click(screen.getByRole("button", { name: "Meets the Expected Outcome" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
    expect(search).toHaveValue("  expected outcome  ");
    expect(screen.getByRole("button", { name: "Meets the Expected Outcome" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Answers the Question" })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "nothing matches this" } });
    expect(screen.getByRole("status")).toHaveTextContent("No presets match");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("button", { name: "Answers the Question" })).toBeVisible();
  });
  it("renders nothing while the flag is off or loading", () => {
    flag.on = undefined;
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{ predicates: [] }}
        support={{}}
        onAdd={() => {}}
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

  it("skips assertions the suite already has and marks a full match", () => {
    const onAdd = vi.fn();
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{ predicates: [{ type: "noToolErrors" }] }}
        support={{}}
        onAdd={onAdd}
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
        onAdd={() => {}}
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
              id: "answer-grounded-in-results-grounded",
              kind: "yesno",
              label: "My question",
              instructions: "Grade my custom criterion.",
              pass: { answer: "yes" },
            },
          ],
        }}
        support={{ canAskYesNo: true }}
        onAdd={onAdd}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer Grounded in Results" }));
    const add = screen.getByRole("button", { name: "Add to suite" });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(/already uses this preset/);
    expect(onAdd).not.toHaveBeenCalled();
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
    expect(isInSuite(wasted, { predicates: [...wasted.checks] })).toBe(true);
    expect(isInSuite(wasted, { predicates: [{ type: "noToolErrors" }] })).toBe(false);
  });
});

describe("library dedupe by criterion", () => {
  const wasted = findLibraryEvaluator("no-wasted-calls")!;
  const schema = findLibraryEvaluator("results-match-output-schema")!;

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

  it("ignores role and origin when matching", () => {
    expect(
      isInSuite(wasted, {
        predicates: [
          { type: "toolCallCountUnder", count: 10, role: "advisory" },
          { type: "noRepeatedIdenticalCall" },
        ],
      }),
    ).toBe(true);
  });

  it("does not duplicate a hand-written copy on update", () => {
    const handWritten = { type: "toolCallCountUnder", count: 10 } as const;
    const next = withEvaluatorUpdated(
      [handWritten, ...taggedChecks(wasted).slice(1)],
      "no-wasted-calls",
    );
    expect(next.filter((p) => p.type === "toolCallCountUnder")).toEqual([
      handWritten,
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
      screen.getByRole("button", { name: "Answer Grounded in Results" }),
    );
    expect(
      screen.getByRole("list", { name: "What this evaluator adds" }),
    ).toHaveTextContent("Yes/no question, passes on Yes");
    fireEvent.click(screen.getByRole("button", { name: "Add to suite" }));
    expect(onAdd).toHaveBeenCalledWith({
      checks: [],
      questions: [
        expect.objectContaining({
          id: "answer-grounded-in-results-grounded",
          kind: "yesno",
          pass: { answer: "yes" },
          evaluator: { id: "answer-grounded-in-results", version: 1 },
        }),
      ],
      judges: [],
    });
  });
});

describe("yes/no capability", () => {
  it("hides question evaluators on a deployment that cannot ask yes/no", () => {
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{ predicates: [] }}
        support={{}}
        onAdd={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    expect(screen.getByText("No Wasted Calls")).toBeInTheDocument();
    expect(
      screen.queryByText("Answer Grounded in Results"),
    ).not.toBeInTheDocument();
  });
});

describe("judge evaluators", () => {
  it("adds a tagged judge and nothing else", () => {
    const onAdd = open();
    fireEvent.click(screen.getByRole("button", { name: "Answers the Question" }));
    expect(
      screen.getByRole("list", { name: "What this evaluator adds" }),
    ).toHaveTextContent("Judge prompt, pass or fail.");
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

  it("hides judge evaluators where the backend cannot run them", () => {
    renderWithProviders(
      <EvaluatorLibraryButton
        suite={{ predicates: [] }}
        support={{ canAskYesNo: true }}
        onAdd={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    expect(screen.queryByText("Answers the Question")).not.toBeInTheDocument();
  });

  it("only ships judges the backend's checks accept", () => {
    for (const evaluator of LIBRARY_EVALUATORS) {
      for (const judge of taggedJudges(evaluator)) {
        expect(
          judgeProblem(judge, [], [
            "user_prompt",
            "final_answer",
            "tool_calls",
            "tool_results",
            "expected_output",
          ]),
          judge.id,
        ).toBeUndefined();
      }
    }
  });
});

describe("question cap", () => {
  it("disables Add for a question evaluator when the suite is full", () => {
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
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    expect(
      screen.getByRole("button", {
        name: "Add Answer Grounded in Results to suite",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Add No Wasted Calls to suite" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Answer Grounded in Results" }),
    );
    const add = screen.getByRole("button", { name: "Add to suite" });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(
      "Remove a decision question to add this preset.",
    );
    expect(onAdd).not.toHaveBeenCalled();
  });
});
