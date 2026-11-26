import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import { EvaluatorLibraryButton } from "../evaluator-library-dialog";
import { predicateSchema } from "@mcpjam/sdk/predicates";
import {
  findLibraryEvaluator,
  isInSuite,
  LIBRARY_EVALUATORS,
  missingChecks,
  taggedChecks,
  withEvaluatorUpdated,
} from "../library-catalog";

const flag = vi.hoisted(() => ({ on: true as boolean | undefined }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) =>
    name === "evaluator-library" ? flag.on : undefined,
}));

function open(onAdd = vi.fn(), predicates = []) {
  renderWithProviders(
    <EvaluatorLibraryButton
      predicates={predicates}
      canAskYesNo
      onAdd={onAdd}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "From library" }));
  return onAdd;
}

describe("EvaluatorLibraryButton", () => {
  it("renders nothing while the flag is off or loading", () => {
    flag.on = undefined;
    renderWithProviders(
      <EvaluatorLibraryButton predicates={[]} onAdd={() => {}} />,
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
    expect(onAdd).toHaveBeenCalledWith(
      [
        { type: "toolCallCountUnder", count: 10, evaluator: tag },
        { type: "noRepeatedIdenticalCall", role: "advisory", evaluator: tag },
      ],
      [],
    );
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
    expect(onAdd).toHaveBeenCalledWith(
      [
        {
          type: "argumentsMatchToolSchema",
          evaluator: { id: "valid-tool-arguments", version: 1 },
        },
      ],
      [],
    );
    fireEvent.click(screen.getByRole("button", { name: "All evaluators" }));
    expect(screen.getByText("Evaluator library")).toBeInTheDocument();
  });

  it("skips assertions the suite already has and marks a full match", () => {
    const onAdd = vi.fn();
    renderWithProviders(
      <EvaluatorLibraryButton
        predicates={[{ type: "noToolErrors" }]}
        onAdd={onAdd}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Actionable Tool Errors to suite",
      }),
    );
    expect(onAdd).toHaveBeenCalledWith(
      [
        {
          type: "toolErrorNamesInput",
          role: "advisory",
          evaluator: { id: "actionable-tool-errors", version: 1 },
        },
      ],
      [],
    );
  });

  it("hides evaluators this deployment cannot save", () => {
    renderWithProviders(
      <EvaluatorLibraryButton
        predicates={[]}
        authorableKinds={["noToolErrors", "toolErrorNamesInput"]}
        onAdd={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    expect(screen.getByText("Actionable Tool Errors")).toBeInTheDocument();
    expect(screen.queryByText("No Wasted Calls")).not.toBeInTheDocument();
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
    expect(isInSuite(wasted, [...wasted.checks])).toBe(true);
    expect(isInSuite(wasted, [{ type: "noToolErrors" }])).toBe(false);
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
    expect(isInSuite(schema, [authored])).toBe(false);
  });

  it("ignores role and origin when matching", () => {
    expect(
      isInSuite(wasted, [
        { type: "toolCallCountUnder", count: 10, role: "advisory" },
        { type: "noRepeatedIdenticalCall" },
      ]),
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
    expect(onAdd).toHaveBeenCalledWith(
      [
        {
          type: "toolResultMatchesSchema",
          schema: "declared",
          evaluator: { id: "results-match-output-schema", version: 1 },
        },
      ],
      [],
    );
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
    expect(onAdd).toHaveBeenCalledWith(
      [],
      [
        expect.objectContaining({
          id: "answer-grounded-in-results-grounded",
          kind: "yesno",
          pass: { answer: "yes" },
          evaluator: { id: "answer-grounded-in-results", version: 1 },
        }),
      ],
    );
  });
});

describe("yes/no capability", () => {
  it("hides question evaluators on a deployment that cannot ask yes/no", () => {
    renderWithProviders(
      <EvaluatorLibraryButton predicates={[]} onAdd={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    expect(screen.getByText("No Wasted Calls")).toBeInTheDocument();
    expect(
      screen.queryByText("Answer Grounded in Results"),
    ).not.toBeInTheDocument();
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
        predicates={[]}
        questions={full}
        canAskYesNo
        onAdd={onAdd}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "From library" }));
    expect(
      screen.queryByRole("button", {
        name: "Add Answer Grounded in Results to suite",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add No Wasted Calls to suite" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Answer Grounded in Results" }),
    );
    expect(screen.getByRole("button", { name: "Add to suite" })).toBeDisabled();
    expect(
      screen.getByText(/already has 10 rubric-check questions/),
    ).toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();
  });
});
