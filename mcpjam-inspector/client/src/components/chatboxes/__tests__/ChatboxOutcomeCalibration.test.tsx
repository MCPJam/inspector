import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatboxOutcomeCalibration } from "../ChatboxOutcomeCalibration";
import type {
  OutcomeFeedbackCalibration,
  UsageBreakdown,
} from "@/hooks/useUsageInsights";

function row(
  overrides: Partial<OutcomeFeedbackCalibration> = {}
): OutcomeFeedbackCalibration {
  return {
    outcome: "completed",
    sessions: 0,
    rated: 0,
    negative: 0,
    negativeRate: null,
    ...overrides,
  };
}

function breakdown(overrides: Partial<UsageBreakdown> = {}): UsageBreakdown {
  return {
    themes: [],
    userBreakdown: [],
    deviceBreakdown: [],
    languageBreakdown: [],
    modelBreakdown: [],
    outcomeBreakdown: [],
    frictionBreakdown: [],
    behaviorTagBreakdown: [],
    goalFacets: [],
    labeledOutcomeCount: 0,
    outcomeFeedbackCalibration: [],
    totalSessions: 0,
    latestRun: null,
    ...overrides,
  };
}

describe("ChatboxOutcomeCalibration", () => {
  it("renders nothing when the server sent no calibration rows", () => {
    const { container } = render(
      <ChatboxOutcomeCalibration breakdown={breakdown()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("explains the absence rather than showing an empty table when nobody rated", () => {
    render(
      <ChatboxOutcomeCalibration
        breakdown={breakdown({
          outcomeFeedbackCalibration: [row({ sessions: 10 })],
        })}
      />
    );
    expect(screen.getByText(/nothing to compare/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders a percentage once the ratings are thick enough", () => {
    render(
      <ChatboxOutcomeCalibration
        breakdown={breakdown({
          outcomeFeedbackCalibration: [
            row({ sessions: 20, rated: 10, negative: 4, negativeRate: 0.4 }),
          ],
        })}
      />
    );
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("shows raw counts instead of a percentage on a thin sample", () => {
    // 1/2 is 50%, but a "50% negative" reads as a finding when it is two
    // ratings. Show the fraction so the sample size travels with the number.
    render(
      <ChatboxOutcomeCalibration
        breakdown={breakdown({
          outcomeFeedbackCalibration: [
            row({ sessions: 9, rated: 2, negative: 1, negativeRate: 0.5 }),
          ],
        })}
      />
    );
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.queryByText("50%")).not.toBeInTheDocument();
  });

  it("renders an unrated outcome as an em dash, never 0%", () => {
    render(
      <ChatboxOutcomeCalibration
        breakdown={breakdown({
          outcomeFeedbackCalibration: [
            row({ outcome: "errored", sessions: 5, rated: 0 }),
            row({ sessions: 5, rated: 5, negative: 0, negativeRate: 0 }),
          ],
        })}
      />
    );
    const erroredRow = screen.getByRole("row", { name: /errored/ });
    expect(within(erroredRow).getByText("—")).toBeInTheDocument();
  });

  it("announces the flagged row in text, not colour alone", () => {
    // The one actionable signal in the panel must reach a screen reader.
    render(
      <ChatboxOutcomeCalibration
        breakdown={breakdown({
          outcomeFeedbackCalibration: [
            row({ sessions: 20, rated: 10, negative: 5, negativeRate: 0.5 }),
          ],
        })}
      />
    );
    expect(
      screen.getByText(/unexpectedly negative for a completed outcome/i)
    ).toBeInTheDocument();
  });

  it("does not flag a high negative rate on a non-completed outcome", () => {
    // Negative feedback on an `errored` session is expected, not a signal that
    // the extraction disagrees with users.
    render(
      <ChatboxOutcomeCalibration
        breakdown={breakdown({
          outcomeFeedbackCalibration: [
            row({
              outcome: "errored",
              sessions: 20,
              rated: 10,
              negative: 9,
              negativeRate: 0.9,
            }),
          ],
        })}
      />
    );
    expect(
      screen.queryByText(/unexpectedly negative/i)
    ).not.toBeInTheDocument();
  });

  it("qualifies its rates when the scan was truncated", () => {
    // Same bounded scan as the grid, so the same qualification. Bare
    // percentages here while the grid warns would read as unconditional.
    render(
      <ChatboxOutcomeCalibration
        breakdown={breakdown({
          outcomeFeedbackCalibration: [
            row({ sessions: 20, rated: 10, negative: 1, negativeRate: 0.1 }),
          ],
          scan: {
            scanned: 5000,
            matched: 2000,
            truncated: true,
            maxSessions: 2000,
            windowEndAt: 1,
            windowStartAt: 0,
          },
        })}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /most recent 2,000 matching sessions/i
    );
  });

  it("does not qualify when the scan was complete", () => {
    render(
      <ChatboxOutcomeCalibration
        breakdown={breakdown({
          outcomeFeedbackCalibration: [
            row({ sessions: 20, rated: 10, negative: 1, negativeRate: 0.1 }),
          ],
          scan: {
            scanned: 20,
            matched: 20,
            truncated: false,
            maxSessions: 2000,
            windowEndAt: 1,
            windowStartAt: 0,
          },
        })}
      />
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
