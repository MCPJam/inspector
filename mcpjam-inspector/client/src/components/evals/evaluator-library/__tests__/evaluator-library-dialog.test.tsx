import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import { EvaluatorLibraryButton } from "../evaluator-library-dialog";
import { predicateSchema } from "@mcpjam/sdk/predicates";
import {
  isInSuite,
  LIBRARY_EVALUATORS,
  taggedChecks,
} from "../library-catalog";

const flag = vi.hoisted(() => ({ on: true as boolean | undefined }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) =>
    name === "evaluator-library" ? flag.on : undefined,
}));

function open(onAdd = vi.fn(), predicates = []) {
  renderWithProviders(
    <EvaluatorLibraryButton predicates={predicates} onAdd={onAdd} />,
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
    expect(onAdd).toHaveBeenCalledWith([
      { type: "toolCallCountUnder", count: 10, evaluator: tag },
      { type: "noRepeatedIdenticalCall", role: "advisory", evaluator: tag },
    ]);
  });

  it("opens the detail with each assertion and adds from there", () => {
    const onAdd = open();
    fireEvent.click(
      screen.getByRole("button", { name: "Valid Tool Arguments" }),
    );
    expect(
      screen.getByRole("list", { name: "Assertions this evaluator adds" }),
    ).toHaveTextContent("Arguments match the tool's schema");
    fireEvent.click(screen.getByRole("button", { name: "Add to suite" }));
    expect(onAdd).toHaveBeenCalledWith([
      {
        type: "argumentsMatchToolSchema",
        evaluator: { id: "valid-tool-arguments", version: 1 },
      },
    ]);
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
    expect(onAdd).toHaveBeenCalledWith([
      {
        type: "toolErrorNamesInput",
        role: "advisory",
        evaluator: { id: "actionable-tool-errors", version: 1 },
      },
    ]);
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
      screen.getByRole("list", { name: "Assertions this evaluator adds" }),
    ).toHaveTextContent("Every tool result matches its declared output schema");
    fireEvent.click(screen.getByRole("button", { name: "Add to suite" }));
    expect(onAdd).toHaveBeenCalledWith([
      {
        type: "toolResultMatchesSchema",
        schema: "declared",
        evaluator: { id: "results-match-output-schema", version: 1 },
      },
    ]);
  });
});
