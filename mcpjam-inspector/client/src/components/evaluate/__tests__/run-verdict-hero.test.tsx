import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { RunVerdictHero } from "../run-verdict-hero";
import type { HeroStatDeltas } from "../run-verdict-hero-deltas";
import type { RunVerdictHeroView } from "../run-verdict-hero-model";

function view(overrides: Partial<RunVerdictHeroView> = {}): RunVerdictHeroView {
  return {
    verdict: { word: "Failed", tone: "failed", undecidedLine: null },
    focus: null,
    sentence: {
      kind: "brokeAt",
      text: "Create and export a diagram to Excalidraw broke at Selection.",
      expected: [],
      observed: [],
    },
    stats: {
      cases: { kind: "cases", passed: 2, total: 3, inconclusive: 0 },
      iterations: { passed: 2, total: 3 },
      latencyP50Ms: 100,
      latencyP95Ms: 200,
      tokens: 1000,
      toolCalls: 4,
    },
    pairings: [],
    deltas: null,
    pending: false,
    ...overrides,
  };
}

describe("RunVerdictHero", () => {
  it("labels each insight as AI generated, not the body or heading icon", () => {
    render(<RunVerdictHero view={view()} />);

    const sentence = screen.getByTestId("run-verdict-sentence");
    const remedy = screen.getByTestId("run-verdict-remedy");
    expect(within(sentence).queryByText("AI generated")).toBeNull();
    expect(within(remedy).queryByText("AI generated")).toBeNull();
    expect(screen.getAllByText("AI generated")).toHaveLength(2);
    expect(screen.getAllByTestId("run-verdict-ai-insight")).toHaveLength(2);

    const whatBroke = screen.getByRole("heading", { name: "What broke" });
    const howToFix = screen.getByRole("heading", { name: "Next step" });
    expect(whatBroke).not.toHaveTextContent("AI generated");
    expect(howToFix).not.toHaveTextContent("AI generated");
    expect(sentence).toHaveTextContent(
      "Create and export a diagram to Excalidraw broke at Selection.",
    );
    expect(sentence.querySelector("svg")).toBeNull();
    expect(remedy.querySelector("svg")).toBeNull();

    const insights = screen.getByTestId("run-verdict-insights");
    expect(insights).toHaveClass("divide-border/40", "border-t", "border-border/60");
    expect(insights).not.toHaveClass("gap-4");
    expect(sentence.parentElement).not.toHaveClass("rounded-lg", "border-border");
    expect(remedy.parentElement).not.toHaveClass("rounded-lg", "border-border");
  });

  it("does not mark the loading skeletons as generated", () => {
    render(
      <RunVerdictHero
        view={view({
          pending: true,
          sentence: { kind: "unavailable", text: "" },
          verdict: { word: "Running", tone: "neutral", undecidedLine: null },
        })}
      />,
    );

    const loading = screen.getByTestId("run-summary-loading");
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveClass("divide-border/40", "border-t", "border-border/60");
    expect(loading.querySelector(".rounded-lg")).toBeNull();
    expect(screen.queryByTestId("run-verdict-ai-insight")).toBeNull();
  });

  it("shows no metric deltas when there is no previous run", () => {
    render(<RunVerdictHero view={view()} />);
    expect(screen.queryByTestId("run-verdict-stat-delta")).toBeNull();
  });

  it("lists each pairing's pass count above the insight cards, not as a Passed tile", () => {
    render(
      <RunVerdictHero
        view={view({
          pairings: [
            {
              key: "cursor-sonnet",
              client: "Cursor",
              model: "sonnet",
              passed: 21,
              failed: 3,
              pending: 0,
              cancelled: 0,
              total: 24,
              delta: { label: "+12", direction: "up", tone: "progress" },
            },
          ],
        })}
      />,
    );

    const pairings = screen.getByTestId("run-verdict-pairings");
    const whatBroke = screen.getByRole("heading", { name: "What broke" });
    expect(pairings.compareDocumentPosition(whatBroke)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(pairings).getByText("Cursor")).toBeVisible();
    expect(within(pairings).getByText("· sonnet")).toBeVisible();
    expect(within(pairings).queryByText("21 of 24")).toBeNull();
    expect(within(pairings).queryByText("=")).toBeNull();
    expect(within(pairings).getByText("21 passed")).toBeVisible();
    expect(within(pairings).getByText("3 failed")).toBeVisible();
    expect(within(pairings).getByTestId("result-count-bar")).toBeVisible();
    const name = within(pairings).getByText("Cursor");
    const key = within(pairings).getByTestId("result-count-key");
    const bar = within(pairings).getByTestId("result-count-bar");
    expect(name.compareDocumentPosition(key)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(key.compareDocumentPosition(bar)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(pairings).getByTestId("run-verdict-pairing")).toHaveClass(
      "py-4",
    );
    expect(within(pairings).getByTestId("run-verdict-stat-delta")).toHaveTextContent(
      "+12",
    );
    expect(within(pairings).getByTestId("run-verdict-stat-delta")).toHaveClass(
      "text-success",
    );
    expect(within(screen.getByTestId("run-verdict-stats")).queryByText("Passed")).toBeNull();
  });

  it("paints a pairing pass increase as progress and a latency increase as regression", () => {
    const deltas: HeroStatDeltas = {
      passed: { label: "+3", direction: "up", tone: "progress" },
      latency: { label: "+8s", direction: "up", tone: "regression" },
      tokens: { label: "−12k", direction: "down", tone: "progress" },
      toolCalls: { label: "+4", direction: "up", tone: "regression" },
    };
    render(
      <RunVerdictHero
        view={view({
          deltas,
          pairings: [
            {
              key: "cursor-sonnet",
              client: "Cursor",
              model: "sonnet",
              passed: 21,
              failed: 3,
              pending: 0,
              cancelled: 0,
              total: 24,
              delta: deltas.passed,
            },
          ],
        })}
      />,
    );

    const pairingDelta = within(
      screen.getByTestId("run-verdict-pairings"),
    ).getByTestId("run-verdict-stat-delta");
    expect(pairingDelta).toHaveTextContent("+3");
    expect(pairingDelta).toHaveClass("text-success");
    expect(pairingDelta).toHaveAccessibleName("+3 vs previous run");

    const strip = screen.getByTestId("run-verdict-stats");
    const marks = within(strip).getAllByTestId("run-verdict-stat-delta");
    expect(marks).toHaveLength(3);
    expect(marks[0]).toHaveTextContent("+8s");
    expect(marks[0]).toHaveClass("text-destructive");
    expect(marks[1]).toHaveTextContent("−12k");
    expect(marks[1]).toHaveClass("text-success");
    expect(marks[2]).toHaveTextContent("+4");
    expect(marks[2]).toHaveClass("text-destructive");
    expect(within(strip).queryByText("Passed")).toBeNull();
  });

  it("paints a pairing pass drop as regression and a latency drop as progress", () => {
    const deltas: HeroStatDeltas = {
      passed: { label: "−2", direction: "down", tone: "regression" },
      latency: { label: "−8s", direction: "down", tone: "progress" },
      tokens: { label: "+12k", direction: "up", tone: "regression" },
      toolCalls: { label: "−3", direction: "down", tone: "progress" },
    };
    render(
      <RunVerdictHero
        view={view({
          deltas,
          pairings: [
            {
              key: "cursor-sonnet",
              client: "Cursor",
              model: "sonnet",
              passed: 16,
              failed: 8,
              pending: 0,
              cancelled: 0,
              total: 24,
              delta: deltas.passed,
            },
          ],
        })}
      />,
    );

    expect(
      within(screen.getByTestId("run-verdict-pairings")).getByTestId(
        "run-verdict-stat-delta",
      ),
    ).toHaveClass("text-destructive");
    const marks = within(screen.getByTestId("run-verdict-stats")).getAllByTestId(
      "run-verdict-stat-delta",
    );
    expect(marks[0]).toHaveTextContent("−8s");
    expect(marks[0]).toHaveClass("text-success");
    expect(marks[1]).toHaveClass("text-destructive");
    expect(marks[2]).toHaveClass("text-success");
  });

  it("does not show a lonely equals on an unchanged pairing", () => {
    render(
      <RunVerdictHero
        view={view({
          pairings: [
            {
              key: "cursor-sonnet",
              client: "Cursor",
              model: "sonnet",
              passed: 21,
              failed: 3,
              pending: 0,
              cancelled: 0,
              total: 24,
              delta: { label: "=", direction: "same", tone: "same" },
            },
          ],
        })}
      />,
    );

    const pairings = screen.getByTestId("run-verdict-pairings");
    expect(within(pairings).queryByTestId("run-verdict-stat-delta")).toBeNull();
    expect(within(pairings).queryByText("=")).toBeNull();
    expect(within(pairings).getByText("21 passed")).toBeVisible();
  });
});
