import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { RunVerdictHero } from "../run-verdict-hero";
import type { HeroPairingPass } from "../run-verdict-hero-deltas";
import type { RunVerdictHeroView } from "../run-verdict-hero-model";

/** A pairing row with every measurement recorded and no movement to report. */
function pairing(overrides: Partial<HeroPairingPass> = {}): HeroPairingPass {
  return {
    key: "cursor-sonnet",
    client: "Cursor",
    model: "sonnet",
    passed: 21,
    failed: 3,
    pending: 0,
    cancelled: 0,
    total: 24,
    delta: null,
    passRate: 87.5,
    passRateDelta: null,
    stats: {
      latencyP50Ms: 21_000,
      latencyP95Ms: 64_000,
      tokens: 980_000,
      toolCalls: 68,
    },
    statDeltas: {
      latencyP50: null,
      latencyP95: null,
      tokens: null,
      toolCalls: null,
    },
    ...overrides,
  };
}

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
  it.each(["loading", "Running", "Pending", "Queued", "pending iterations"])(
    "hides comparisons while %s and restores them when finished",
    (state) => {
      const delta = { label: "+12", direction: "up", tone: "progress" } as const;
      const row = pairing({
        delta,
        passRateDelta: delta,
        statDeltas: {
          latencyP50: delta,
          latencyP95: delta,
          tokens: delta,
          toolCalls: delta,
        },
      });
      const { rerender } = render(
        <RunVerdictHero
          view={view({
            pending: state === "loading",
            verdict: {
              word: ["Running", "Pending", "Queued"].includes(state) ? state : "Failed",
              tone: "neutral",
              undecidedLine: null,
            },
            pairings: [{ ...row, pending: state === "pending iterations" ? 1 : 0 }],
          })}
        />,
      );
      expect(screen.queryByTestId("run-verdict-stat-delta")).toBeNull();
      expect(screen.getByTestId("run-verdict-pairings")).toHaveTextContent("980k");
      rerender(<RunVerdictHero view={view({ pairings: [row] })} />);
      expect(screen.getAllByTestId("run-verdict-stat-delta")).toHaveLength(6);
    },
  );

  it("keeps deterministic summaries free of AI attribution", () => {
    render(<RunVerdictHero view={view()} />);

    const sentence = screen.getByTestId("run-verdict-sentence");
    const remedy = screen.getByTestId("run-verdict-remedy");
    expect(within(sentence).queryByText("AI generated")).toBeNull();
    expect(within(remedy).queryByText("AI generated")).toBeNull();
    expect(screen.queryByText("AI generated")).toBeNull();
    expect(screen.queryByTestId("run-verdict-ai-insight")).toBeNull();

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
    expect(insights).toHaveClass(
      "divide-border/40",
      "border-t",
      "border-border/60",
    );
    expect(insights).not.toHaveClass("gap-4");
    expect(sentence.parentElement).not.toHaveClass(
      "rounded-lg",
      "border-border",
    );
    expect(remedy.parentElement).not.toHaveClass("rounded-lg", "border-border");
  });

  it("keeps pairing measurements when findings replace the explanation", () => {
    render(
      <RunVerdictHero
        view={view({ pairings: [pairing()] })}
        explanation={null}
      />,
    );
    expect(screen.getByTestId("run-verdict-pairing")).toHaveTextContent(
      "Cursor",
    );
    expect(screen.queryByTestId("run-verdict-insights")).toBeNull();
    expect(screen.queryByTestId("run-summary-loading")).toBeNull();
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
    expect(loading).toHaveClass(
      "divide-border/40",
      "border-t",
      "border-border/60",
    );
    expect(loading.querySelector(".rounded-lg")).toBeNull();
    expect(screen.queryByTestId("run-verdict-ai-insight")).toBeNull();
  });

  it("shows no metric deltas when there is no previous run", () => {
    render(<RunVerdictHero view={view()} />);
    expect(screen.queryByTestId("run-verdict-stat-delta")).toBeNull();
  });

  it("reports each pairing's own rate, counts, and measurements in its row", () => {
    render(
      <RunVerdictHero
        view={view({
          pairings: [
            pairing({
              passRateDelta: {
                label: "+12%",
                direction: "up",
                tone: "progress",
              },
            }),
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
    expect(within(pairings).getByText("sonnet")).toBeVisible();

    // The rate leads the row, and the measurements sit beside it rather than
    // in a page-level strip that would average two clients into neither.
    expect(
      within(pairings).getByTestId("run-verdict-pairing-rate"),
    ).toHaveTextContent("88%");
    const row = within(pairings).getByTestId("run-verdict-pairing");
    for (const label of ["Passed", "Failed", "P50", "P95", "Tokens", "Calls"]) {
      expect(within(row).getByText(label)).toBeVisible();
    }
    expect(within(row).getByText("21")).toBeVisible();
    expect(within(row).getByText("3")).toBeVisible();
    expect(within(row).getByText("21s")).toBeVisible();
    expect(within(row).getByText("64s")).toBeVisible();
    expect(within(row).getByText("980k")).toBeVisible();
    expect(within(row).getByText("68")).toBeVisible();
    expect(within(row).getByText("88%")).toHaveClass("text-[34px]");
    expect(within(row).getByText("21")).toHaveClass("text-[26px]");
    expect(within(row).getByText("21s")).toHaveClass("text-lg");
    expect(within(row).getByText("Cursor")).toHaveClass("text-base");
    expect(within(row).getByText("sonnet")).toHaveClass("text-sm");
    expect(screen.queryByTestId("run-verdict-stats")).toBeNull();

    const delta = within(pairings).getByTestId("run-verdict-stat-delta");
    expect(delta).toHaveTextContent("+12%");
    expect(delta).toHaveClass("text-success");
    expect(delta).toHaveAccessibleName("+12% vs previous run");
  });

  it("paints a rate rise as progress and a latency rise as regression", () => {
    render(
      <RunVerdictHero
        view={view({
          pairings: [
            pairing({
              passRateDelta: {
                label: "+4%",
                direction: "up",
                tone: "progress",
              },
              statDeltas: {
                latencyP50: {
                  label: "+3s",
                  direction: "up",
                  tone: "regression",
                },
                latencyP95: {
                  label: "+8s",
                  direction: "up",
                  tone: "regression",
                },
                tokens: {
                  label: "−12k",
                  direction: "down",
                  tone: "progress",
                },
                toolCalls: {
                  label: "+4",
                  direction: "up",
                  tone: "regression",
                },
              },
            }),
          ],
        })}
      />,
    );

    const marks = within(
      screen.getByTestId("run-verdict-pairings"),
    ).getAllByTestId("run-verdict-stat-delta");
    expect(marks).toHaveLength(5);
    expect(marks[0]).toHaveTextContent("+4%");
    expect(marks[0]).toHaveClass("text-success");
    expect(marks[1]).toHaveTextContent("+3s");
    expect(marks[1]).toHaveClass("text-destructive");
    expect(marks[2]).toHaveTextContent("+8s");
    expect(marks[2]).toHaveClass("text-destructive");
    expect(marks[3]).toHaveTextContent("−12k");
    expect(marks[3]).toHaveClass("text-success");
    expect(marks[4]).toHaveTextContent("+4");
    expect(marks[4]).toHaveClass("text-destructive");
  });

  it("does not show a lonely equals on an unchanged pairing", () => {
    render(
      <RunVerdictHero
        view={view({
          pairings: [
            pairing({
              passRateDelta: { label: "=", direction: "same", tone: "same" },
              statDeltas: {
                latencyP50: { label: "=", direction: "same", tone: "same" },
                latencyP95: { label: "=", direction: "same", tone: "same" },
                tokens: { label: "=", direction: "same", tone: "same" },
                toolCalls: { label: "=", direction: "same", tone: "same" },
              },
            }),
          ],
        })}
      />,
    );

    const pairings = screen.getByTestId("run-verdict-pairings");
    expect(within(pairings).queryByTestId("run-verdict-stat-delta")).toBeNull();
    expect(within(pairings).queryByText("=")).toBeNull();
    expect(
      within(pairings).getByTestId("run-verdict-pairing-rate"),
    ).toHaveTextContent("88%");
  });

  it("shows pending and cancelled only when the run has them", () => {
    const { rerender } = render(
      <RunVerdictHero view={view({ pairings: [pairing()] })} />,
    );
    const row = () => screen.getByTestId("run-verdict-pairing");
    expect(within(row()).queryByText("Pending")).toBeNull();
    expect(within(row()).queryByText("Cancelled")).toBeNull();

    rerender(
      <RunVerdictHero
        view={view({
          pairings: [pairing({ pending: 2, cancelled: 1, total: 27 })],
        })}
      />,
    );
    expect(within(row()).getByText("Pending")).toBeVisible();
    expect(within(row()).getByText("Cancelled")).toBeVisible();
  });

  it("dashes a measurement the run never recorded rather than calling it zero", () => {
    render(
      <RunVerdictHero
        view={view({
          pairings: [
            pairing({
              stats: {
                latencyP50Ms: null,
                latencyP95Ms: null,
                tokens: null,
                toolCalls: null,
              },
            }),
          ],
        })}
      />,
    );

    const row = screen.getByTestId("run-verdict-pairing");
    expect(within(row).queryByText("0")).toBeNull();
    expect(within(row).getByLabelText("Tokens not recorded")).toHaveTextContent(
      "—",
    );
    expect(within(row).getByLabelText("Calls not recorded")).toHaveTextContent(
      "—",
    );
  });

  it("leaves the rate out when nothing has decided yet", () => {
    render(
      <RunVerdictHero
        view={view({
          pairings: [
            pairing({ passed: 0, failed: 0, pending: 24, passRate: null }),
          ],
        })}
      />,
    );

    expect(screen.getByTestId("run-verdict-pairing-rate")).toHaveTextContent(
      "—",
    );
  });
});
