import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  EvalTraceBrowserInteractionStepView,
  EvalTraceWidgetRenderObservationView,
} from "@/shared/eval-trace";
import {
  BrowserArtifactsView,
  formatBrowserAction,
} from "../browser-artifacts-view";

const obs = (
  o: Partial<EvalTraceWidgetRenderObservationView> = {},
): EvalTraceWidgetRenderObservationView => ({
  toolCallId: "tc-show",
  toolName: "show_seats",
  promptIndex: 0,
  status: "rendered",
  screenshotUrl: "https://store.example/obs.png",
  elapsedMs: 1200,
  ts: 1,
  ...o,
});

const step = (
  s: Partial<EvalTraceBrowserInteractionStepView> = {},
): EvalTraceBrowserInteractionStepView => ({
  toolCallId: "tc-show",
  stepIndex: 0,
  promptIndex: 0,
  action: "left_click",
  coordinateX: 640,
  coordinateY: 400,
  elapsedMs: 7,
  ts: 1,
  ...s,
});

describe("BrowserArtifactsView", () => {
  it("shows an empty state when there are no artifacts", () => {
    render(<BrowserArtifactsView />);
    expect(screen.getByTestId("browser-artifacts-empty")).toBeInTheDocument();
  });

  it("renders a render-observation card with status badge, turn, and screenshot", () => {
    render(<BrowserArtifactsView observations={[obs()]} />);

    const card = screen.getByTestId("render-observation-card");
    expect(within(card).getByText("show_seats")).toBeInTheDocument();
    expect(within(card).getByText("Rendered")).toBeInTheDocument();
    // promptIndex is displayed 1-based.
    expect(within(card).getByText(/turn 1/)).toBeInTheDocument();
    const img = within(card).getByRole("img", { name: "show_seats render" });
    expect(img).toHaveAttribute("src", "https://store.example/obs.png");
  });

  it("shows a 'No screenshot' placeholder + failure label for a failed render", () => {
    render(
      <BrowserArtifactsView
        observations={[
          obs({ status: "render_error", screenshotUrl: null }),
        ]}
      />,
    );
    expect(screen.getByText("Render error")).toBeInTheDocument();
    expect(screen.getByText("No screenshot")).toBeInTheDocument();
  });

  it("shows diagnostic copy for failure statuses", () => {
    render(
      <BrowserArtifactsView
        observations={[obs({ status: "bridge_timeout", screenshotUrl: null })]}
      />,
    );
    expect(
      screen.getByText(/Bridge handshake timed out/),
    ).toBeInTheDocument();
  });

  it("prefers the first console error as the render_error description", () => {
    render(
      <BrowserArtifactsView
        observations={[
          obs({
            status: "render_error",
            screenshotUrl: null,
            consoleErrors: ["TypeError: x is undefined"],
          }),
        ]}
      />,
    );
    expect(
      screen.getByTestId("render-observation-description"),
    ).toHaveTextContent("TypeError: x is undefined");
  });

  it("surfaces console errors in a collapsible details element", () => {
    render(
      <BrowserArtifactsView
        observations={[obs({ consoleErrors: ["boom", "kaboom"] })]}
      />,
    );
    expect(screen.getByText("2 console errors")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("renders the Computer Use timeline grouped by widget, titled by tool name", () => {
    render(
      <BrowserArtifactsView
        observations={[obs()]}
        steps={[step({ stepIndex: 0 }), step({ stepIndex: 1, action: "screenshot" })]}
      />,
    );
    const group = screen.getByTestId("interaction-step-group");
    // Group titled by the matching observation's tool name.
    expect(within(group).getByText("show_seats")).toBeInTheDocument();
    expect(within(group).getByText("2 steps")).toBeInTheDocument();
    expect(within(group).getAllByTestId("interaction-step-row")).toHaveLength(2);
    expect(within(group).getByText("Left click (640, 400)")).toBeInTheDocument();
    expect(within(group).getByText("Screenshot")).toBeInTheDocument();
  });

  it("renders widget-initiated tools/call and a budget note on a step", () => {
    render(
      <BrowserArtifactsView
        steps={[
          step({
            note: "step_budget_exceeded",
            widgetToolCalls: [
              { name: "reserve", args: { seat: 12 }, ok: true, elapsedMs: 4 },
              { name: "pay", args: {}, ok: false, error: "declined", elapsedMs: 9 },
            ],
          }),
        ]}
      />,
    );
    expect(screen.getByText("Step budget exceeded")).toBeInTheDocument();
    expect(screen.getByText(/reserve/)).toBeInTheDocument();
    expect(screen.getByText(/pay — declined/)).toBeInTheDocument();
  });

  it("falls back to toolCallId when no observation names the group", () => {
    render(<BrowserArtifactsView steps={[step({ toolCallId: "tc-orphan" })]} />);
    expect(screen.getByText("tc-orphan")).toBeInTheDocument();
  });
});

describe("formatBrowserAction", () => {
  it("formats every action variant", () => {
    expect(formatBrowserAction(step({ action: "left_click" }))).toBe(
      "Left click (640, 400)",
    );
    expect(
      formatBrowserAction(
        step({ action: "type", text: "hello", coordinateX: undefined, coordinateY: undefined }),
      ),
    ).toBe('Type "hello"');
    expect(
      formatBrowserAction(step({ action: "key", text: "Enter" })),
    ).toBe("Key Enter");
    expect(
      formatBrowserAction(
        step({ action: "scroll", scrollDirection: "down", scrollAmount: 3 }),
      ),
    ).toBe("Scroll down ×3");
    expect(formatBrowserAction(step({ action: "wait", duration: 250 }))).toBe(
      "Wait 250ms",
    );
    expect(formatBrowserAction(step({ action: "screenshot" }))).toBe(
      "Screenshot",
    );
  });
});
