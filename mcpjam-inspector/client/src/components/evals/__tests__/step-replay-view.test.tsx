import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TestStep } from "@/shared/steps";
import type {
  EvalTraceBrowserInteractionStepView,
  EvalTraceWidgetRenderObservationView,
} from "@/shared/eval-trace";
import { StepReplayView } from "../step-replay-view";

// The "Show me a redbull" case shape: prompt → widgetRendered assert →
// interact click → tool-called assert.
const steps: TestStep[] = [
  { id: "p1", kind: "prompt", prompt: "Show me a redbull" },
  {
    id: "a1",
    kind: "assert",
    assertion: { type: "widgetRendered", toolName: "search-products" },
  },
  {
    id: "i1",
    kind: "interact",
    toolName: "search-products",
    action: {
      kind: "click",
      target: { role: { role: "button", name: "Add to cart" } },
    },
  },
  {
    id: "a2",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "clear-cart",
      args: { args: {} },
    },
  },
];

const obs = (
  o: Partial<EvalTraceWidgetRenderObservationView>
): EvalTraceWidgetRenderObservationView => ({
  toolCallId: "tc1",
  toolName: "search-products",
  promptIndex: 0,
  status: "rendered",
  elapsedMs: 10,
  ts: 1,
  ...o,
});

const interaction = (
  o: Partial<EvalTraceBrowserInteractionStepView>
): EvalTraceBrowserInteractionStepView => ({
  toolCallId: "tc1",
  stepIndex: 0,
  promptIndex: 0,
  action: "left_click",
  elapsedMs: 5,
  ts: 2,
  ...o,
});

describe("StepReplayView", () => {
  it("renders one row per authored step, in order", () => {
    render(<StepReplayView steps={steps} />);
    const rows = screen.getAllByTestId("step-replay-row");
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.getAttribute("data-step-id"))).toEqual([
      "p1",
      "a1",
      "i1",
      "a2",
    ]);
  });

  it("buckets artifacts under the step that produced them (by authoredStepId)", () => {
    render(
      <StepReplayView
        steps={steps}
        renderObservations={[obs({ authoredStepId: "p1" })]}
        interactionSteps={[
          interaction({ authoredStepId: "i1", locatorLabel: "Add to cart" }),
        ]}
      />
    );
    const byId = (id: string) =>
      screen
        .getAllByTestId("step-replay-row")
        .find((r) => r.getAttribute("data-step-id") === id)!;
    // The render observation lands on the prompt step that triggered it...
    expect(
      within(byId("p1")).getByTestId("render-observation-card")
    ).toBeInTheDocument();
    // ...and the click interaction artifact (raw `left_click` action + locator)
    // lands on its interact step.
    expect(within(byId("i1")).getByText(/left_click/)).toBeInTheDocument();
    // A step with no artifacts shows none.
    expect(
      within(byId("a2")).queryByTestId("render-observation-card")
    ).toBeNull();
  });

  it("groups a prompt turn's artifacts by the tool call that produced them", () => {
    // The model made TWO calls in one turn; both renders bucket onto the prompt
    // step (no authored step of their own). They should split into one group per
    // toolCallId, each labeled by its tool — view tied to its call, not the prompt.
    render(
      <StepReplayView
        steps={steps}
        renderObservations={[
          obs({ authoredStepId: "p1", toolCallId: "tc1", toolName: "search-products", ts: 1 }),
          obs({ authoredStepId: "p1", toolCallId: "tc2", toolName: "view-cart", ts: 3 }),
        ]}
      />
    );
    const p1 = screen
      .getAllByTestId("step-replay-row")
      .find((r) => r.getAttribute("data-step-id") === "p1")!;
    const groups = within(p1).getAllByTestId("step-tool-call-group");
    expect(groups).toHaveLength(2);
    // Ordered by first artifact time: search-products (ts 1) before view-cart (ts 3).
    expect(groups.map((g) => g.getAttribute("data-tool-call-id"))).toEqual([
      "tc1",
      "tc2",
    ]);
    // Each group owns its tool's view (toolName appears in both the group header
    // and the render card, hence getAllByText).
    expect(within(groups[0]).getAllByText("search-products").length).toBeGreaterThan(0);
    expect(within(groups[1]).getAllByText("view-cart").length).toBeGreaterThan(0);
    expect(
      within(groups[0]).getByTestId("render-observation-card")
    ).toBeInTheDocument();
    // Each group has exactly its own one view, not the other's.
    expect(within(groups[0]).getAllByTestId("render-observation-card")).toHaveLength(1);
  });

  it("derives an assert verdict from its DOM-assertion artifact when no live status", () => {
    render(
      <StepReplayView
        steps={steps}
        interactionSteps={[
          interaction({
            authoredStepId: "a2",
            action: "screenshot",
            assertion: {
              type: "toolCalledWith",
              passed: false,
              reason: "clear-cart never called",
            },
          }),
        ]}
      />
    );
    const a2 = screen
      .getAllByTestId("step-replay-row")
      .find((r) => r.getAttribute("data-step-id") === "a2")!;
    expect(within(a2).getByText(/clear-cart never called/)).toBeInTheDocument();
  });

  it("does not embed the replay video (it lives on the App tab)", () => {
    render(
      <StepReplayView
        steps={steps}
        interactionSteps={[
          interaction({ authoredStepId: "i1", videoOffsetMs: 2500 }),
        ]}
      />
    );
    expect(screen.queryByTestId("step-replay-video")).toBeNull();
  });

  it("ignores artifacts lacking authoredStepId (legacy runs render structure-only)", () => {
    render(
      <StepReplayView
        steps={steps}
        renderObservations={[obs({})]}
        interactionSteps={[interaction({})]}
      />
    );
    expect(screen.queryByTestId("render-observation-card")).toBeNull();
  });

  describe("verdict header", () => {
    it("is absent when no verdict is provided", () => {
      render(<StepReplayView steps={steps} />);
      expect(screen.queryByTestId("steps-verdict-header")).toBeNull();
    });

    it("shows Passed with a full check tally", () => {
      render(
        <StepReplayView
          steps={steps}
          verdict="passed"
          stepStatusById={
            new Map([
              ["a1", "ok"],
              ["a2", "ok"],
            ])
          }
        />
      );
      const header = screen.getByTestId("steps-verdict-header");
      expect(within(header).getByText("Passed")).toBeInTheDocument();
      // Two assert steps (a1, a2) are the "checks".
      expect(within(header).getByText(/2 of 2 checks passed/)).toBeInTheDocument();
    });

    it("shows Failed and the failed-check count", () => {
      render(
        <StepReplayView
          steps={steps}
          verdict="failed"
          stepStatusById={
            new Map([
              ["a1", "ok"],
              ["a2", "fail"],
            ])
          }
        />
      );
      const header = screen.getByTestId("steps-verdict-header");
      expect(within(header).getByText("Failed")).toBeInTheDocument();
      expect(within(header).getByText(/1 of 2 checks passed/)).toBeInTheDocument();
      expect(within(header).getByText(/1 failed/)).toBeInTheDocument();
    });
  });
});
