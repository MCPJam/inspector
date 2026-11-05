import { useState } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TestStep } from "@/shared/steps";
import { CaseStepsEditor, type CaseStepsDraft } from "../case-steps-editor";
import {
  ExecutionPreviewPanel,
  useExecutionPreviewToggle,
} from "../execution-preview";

const track = vi.fn();
vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => track(...args),
}));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
}));

const steps: TestStep[] = [
  { id: "lead", kind: "assert", assertion: { type: "noToolErrors" } },
  { id: "p1", kind: "prompt", prompt: "Sketch a tiny flow" },
  {
    id: "a1",
    kind: "assert",
    assertion: { type: "finalAssistantMessageNonEmpty" },
  },
  { id: "p2", kind: "prompt", prompt: "Now label it" },
];

function Harness({
  initial,
  onChange,
}: {
  initial: CaseStepsDraft;
  onChange?: (draft: CaseStepsDraft) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <CaseStepsEditor
      draft={draft}
      onDraftChange={(patch) => {
        const next = { ...draft, ...patch };
        setDraft(next);
        onChange?.(next);
      }}
      availableTools={[]}
      suiteServers={[]}
    />
  );
}

describe("CaseStepsEditor", () => {
  beforeEach(() => track.mockClear());

  it("numbers steps, nests assertions and shows leading assertions above step 1", () => {
    render(<Harness initial={{ steps }} />);
    expect(screen.getByTestId("case-steps-leading")).toHaveTextContent(
      "Before step 1",
    );
    const cards = screen.getAllByTestId("case-steps-step");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByLabelText("Step 1")).toBeInTheDocument();
    expect(
      within(cards[0]!).getByText("Assertions at this point"),
    ).toBeInTheDocument();
    expect(
      within(cards[1]!).queryByText("Assertions at this point"),
    ).toBeNull();
    // After-run assertions and Expected outcome follow the last step.
    expect(screen.getByTestId("case-steps-after-run")).toHaveTextContent(
      "After-run assertions",
    );
    expect(screen.getByLabelText("Step 3")).toBeInTheDocument();
    expect(screen.getByLabelText("Step 4")).toBeInTheDocument();
  });

  it("shows an empty state when the case has no after-run assertions", () => {
    render(<Harness initial={{ steps }} />);
    expect(
      screen.getByTestId("case-steps-after-run-empty"),
    ).toBeInTheDocument();
  });

  it("hides the empty state once the case has an after-run assertion", () => {
    render(
      <Harness
        initial={{
          steps,
          predicates: { mode: "extend", list: [{ type: "noToolErrors" }] },
        }}
      />,
    );
    expect(screen.queryByTestId("case-steps-after-run-empty")).toBeNull();
  });

  it("collapses a step to one line with its summary", () => {
    render(<Harness initial={{ steps }} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse step 1" }));
    const card = screen.getAllByTestId("case-steps-step")[0]!;
    expect(within(card).getByText("Sketch a tiny flow")).toBeInTheDocument();
    expect(within(card).getByText("1 assertion")).toBeInTheDocument();
    expect(within(card).queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand step 1" }));
    expect(within(card).getByRole("textbox")).toHaveValue("Sketch a tiny flow");
  });

  it("writes the expected outcome to expectedOutput", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ steps }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Expected outcome"), {
      target: { value: "Two boxes and an arrow" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedOutput: "Two boxes and an arrow" }),
    );
  });

  it("edits a prompt in place without reordering the stored steps", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ steps }} onChange={onChange} />);
    fireEvent.change(screen.getByDisplayValue("Now label it"), {
      target: { value: "Label both boxes" },
    });
    const next = onChange.mock.lastCall?.[0] as CaseStepsDraft;
    expect(next.steps.map((step) => step.id)).toEqual([
      "lead",
      "p1",
      "a1",
      "p2",
    ]);
    expect(next.steps[3]).toMatchObject({ prompt: "Label both boxes" });
  });
});

function PreviewHarness() {
  const preview = useExecutionPreviewToggle("editor");
  return (
    <>
      {preview.button}
      {preview.open ? (
        <ExecutionPreviewPanel
          input={{ steps, expectedOutput: " Two boxes " }}
          onClose={preview.close}
        />
      ) : null}
    </>
  );
}

describe("execution preview", () => {
  beforeEach(() => track.mockClear());

  it("fires eval_execution_preview_opened once per open, from the editor", () => {
    render(<PreviewHarness />);
    fireEvent.click(
      screen.getByRole("button", { name: "Show execution preview" }),
    );
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("eval_execution_preview_opened", {
      location: "evaluate_nav",
      surface: "editor",
    });
    const panel = screen.getByTestId("execution-preview");
    expect(within(panel).getByText("1. User prompt")).toBeInTheDocument();
    expect(within(panel).getByText("Before step 1")).toBeInTheDocument();
    expect(within(panel).getByText("Two boxes")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Hide execution preview" }),
    );
    expect(track).toHaveBeenCalledTimes(1);
  });
});
