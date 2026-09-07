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

describe("StepReplayView — scorecard presentation", () => {
  const advisory: TestStep = {
    id: "a3",
    kind: "assert",
    assertion: { type: "noToolErrors", role: "advisory", severity: "warn" },
  } as TestStep;
  const gating: TestStep = {
    id: "a4",
    kind: "assert",
    assertion: { type: "noToolErrors" },
  } as TestStep;

  it("keeps every existing mount byte-identical by default", () => {
    // This component is also every /evals Steps tab. The fixes below are
    // opt-in for exactly that reason.
    const legacy = render(<StepReplayView steps={steps} />).container.innerHTML;
    const explicit = render(
      <StepReplayView steps={steps} presentation="legacy" />,
    ).container.innerHTML;
    expect(explicit).toBe(legacy);
  });

  it("names a check the way the rest of the product names it", () => {
    // The wire discriminator is what this tab has always printed, and the one
    // surface still speaking it: the authoring form, the checks list and the
    // scorecard all say "Tool was called with…".
    const { container } = render(
      <StepReplayView steps={steps} presentation="scorecard" />,
    );
    expect(container.textContent).toContain("Tool was called with… clear-cart");
    expect(container.textContent).not.toContain("toolCalledWith:");
  });

  it("says where a step-authored check runs", () => {
    const { container } = render(
      <StepReplayView
        steps={[steps[0], gating]}
        presentation="scorecard"
      />,
    );
    expect(container.textContent).toContain("No tool errors so far");
  });

  it("says why a step failed", () => {
    // `parseStepStatusById` keeps only {stepId → status} and drops the
    // runner's reason, so a failed row was a red mark and nothing else.
    const { container } = render(
      <StepReplayView
        steps={[steps[0], gating]}
        presentation="scorecard"
        stepStatusById={new Map([["a4", "fail" as const]])}
        stepResults={[
          {
            stepId: "a4",
            stepIndex: 1,
            kind: "assert",
            status: "fail",
            reason: "search-products returned isError",
          },
        ]}
      />,
    );
    expect(
      screen.getByTestId("step-replay-reason").textContent,
    ).toBe("search-products returned isError");
    expect(container.textContent).toContain("search-products returned isError");
  });

  it("does not count an advisory miss as a failed check", () => {
    // An advisory miss does not fail the trial, so counting it here would
    // report a failure the verdict itself does not agree with.
    render(
      <StepReplayView
        steps={[steps[0], gating, advisory]}
        presentation="scorecard"
        verdict="passed"
        stepStatusById={
          new Map([
            ["a4", "ok" as const],
            ["a3", "fail" as const],
          ])
        }
      />,
    );
    const header = screen.getByTestId("steps-verdict-header");
    expect(header.textContent).toContain("1 of 1 check passed");
    expect(header.textContent).toContain("· 1 warn");
    expect(header.textContent).not.toContain("failed");
  });

  it("marks the advisory row itself as a warning", () => {
    const { container } = render(
      <StepReplayView
        steps={[steps[0], advisory]}
        presentation="scorecard"
        stepStatusById={new Map([["a3", "fail" as const]])}
      />,
    );
    const row = container.querySelector(
      '[data-step-id="a3"]',
    ) as HTMLElement;
    expect(within(row).getByText("Warn")).toBeTruthy();
  });

  it("uses the page's verdict word rather than deriving a second one", () => {
    // This header reads raw `iteration.result` while the trial header runs
    // `computeIterationResult`; on the same screen they can disagree.
    render(
      <StepReplayView
        steps={[steps[0], gating]}
        presentation="scorecard"
        verdict="passed"
        verdictWord="No verdict"
      />,
    );
    const header = screen.getByTestId("steps-verdict-header");
    expect(header.textContent).toContain("No verdict");
    expect(header.textContent).not.toContain("Passed");
  });

  it("still counts every check in legacy mode, advisory included", () => {
    render(
      <StepReplayView
        steps={[steps[0], gating, advisory]}
        verdict="failed"
        stepStatusById={
          new Map([
            ["a4", "ok" as const],
            ["a3", "fail" as const],
          ])
        }
      />,
    );
    expect(
      screen.getByTestId("steps-verdict-header").textContent,
    ).toContain("1 of 2 checks passed");
  });
});
