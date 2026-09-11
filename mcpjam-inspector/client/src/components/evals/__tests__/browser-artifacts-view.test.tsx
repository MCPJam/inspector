import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EvalTraceWidgetRenderObservationView } from "@/shared/eval-trace";
import { BrowserArtifactsView } from "../browser-artifacts-view";

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

describe("BrowserArtifactsView", () => {
  it("shows an empty state when there are no artifacts", () => {
    render(<BrowserArtifactsView />);
    expect(screen.getByTestId("browser-artifacts-empty")).toBeInTheDocument();
  });

  it("renders a Replay player when a videoUrl is present", () => {
    render(
      <BrowserArtifactsView videoUrl="https://store.example/replay.webm" />,
    );
    expect(screen.queryByTestId("browser-artifacts-empty")).toBeNull();
    const video = screen.getByTestId("browser-replay-video");
    expect(video).toHaveAttribute("src", "https://store.example/replay.webm");
  });

  it("shows no Replay player when videoUrl is absent", () => {
    render(<BrowserArtifactsView observations={[obs()]} />);
    expect(screen.queryByTestId("browser-replay-video")).toBeNull();
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

  it("renders a card per widget when multiple widgets rendered", () => {
    render(
      <BrowserArtifactsView
        observations={[
          obs({ toolCallId: "tc-1", toolName: "search-products", ts: 1 }),
          obs({ toolCallId: "tc-2", toolName: "view-cart", ts: 2 }),
        ]}
      />,
    );
    const cards = screen.getAllByTestId("render-observation-card");
    expect(cards).toHaveLength(2);
    expect(screen.getByText("search-products")).toBeInTheDocument();
    expect(screen.getByText("view-cart")).toBeInTheDocument();
  });
});

/**
 * R-4. The metadata has to reach the player, not just the props.
 *
 * `BrowserArtifactsView` rebuilds the filmstrip's props by hand, which is a
 * place a field can be added at one end and silently dropped at the other —
 * and a truncated recording that does not say so is the one failure this
 * whole field exists to prevent.
 */
describe("BrowserArtifactsView — the recording's own numbers reach the player", () => {
  it("forwards videoMeta, badge and all", () => {
    render(
      <BrowserArtifactsView
        videoUrl="https://store.example/replay.mp4"
        videoMeta={{
          source: "hosted",
          fps: 15,
          durationMs: 9_000,
          truncated: true,
        }}
      />,
    );

    expect(screen.getByTestId("browser-replay-truncated-badge")).toBeTruthy();
    expect(screen.getByTestId("browser-replay-video-meta").textContent).toContain(
      "15 fps",
    );
  });

  it("renders a player with no metadata line when there is nothing to say", () => {
    render(<BrowserArtifactsView videoUrl="https://store.example/replay.webm" />);
    expect(screen.getByTestId("browser-replay-video")).toBeTruthy();
    expect(screen.queryByTestId("browser-replay-video-meta")).toBeNull();
  });
});
