import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ScoreSummary, StoredScoreRun } from "@/lib/apis/score-api";

const { mockFetchScoreRun } = vi.hoisted(() => ({
  mockFetchScoreRun: vi.fn(),
}));

vi.mock("@/lib/apis/score-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/apis/score-api")>();
  return {
    ...actual,
    fetchScoreRun: (...args: unknown[]) => mockFetchScoreRun(...args),
  };
});

import { ScoreResultsPage } from "../ScoreResultsPage";

function summary(overrides: Partial<ScoreSummary> = {}): ScoreSummary {
  return {
    score: 100,
    outcome: "passed",
    applicable: 1,
    passed: 1,
    failed: 0,
    couldNotRun: 0,
    notApplicable: 0,
    advisoryCount: 0,
    protocolVersion: "2025-11-25",
    ...overrides,
  };
}

/**
 * A stored run whose protocol report stamps `wire-schema-valid` as pending
 * while that check failed. The headline can still claim 100/100 — that is
 * the retroactive-failure hole this page used to hide.
 */
function pendingBearingRun(): StoredScoreRun {
  const headline = summary();
  return {
    ...headline,
    serverUrl: "https://mcp.example.com/mcp",
    createdAt: 1_700_000_000_000,
    suiteSummaries: [{ suiteId: "protocol", ...headline }],
    report: {
      protocol: {
        checks: [
          {
            id: "initialize",
            title: "Initialize handshake",
            status: "passed",
          },
          {
            id: "wire-schema-valid",
            title: "Wire schema is valid",
            status: "failed",
            error: { message: "schema mismatch" },
          },
        ],
        profile: {
          pendingCheckIds: ["wire-schema-valid"],
        },
      } as StoredScoreRun["report"]["protocol"],
    },
  };
}

/** Pre-profile stored run: no `profile` key, failed check stays a scored fail. */
function stampLessLegacyRun(): StoredScoreRun {
  const headline = summary({
    score: 91,
    outcome: "failed",
    applicable: 2,
    passed: 1,
    failed: 1,
  });
  return {
    ...headline,
    serverUrl: "https://mcp.example.com/mcp",
    createdAt: 1_700_000_000_000,
    suiteSummaries: [{ suiteId: "protocol", ...headline }],
    report: {
      protocol: {
        checks: [
          {
            id: "initialize",
            title: "Initialize handshake",
            status: "passed",
          },
          {
            id: "wire-schema-valid",
            title: "Wire schema is valid",
            status: "failed",
            error: { message: "schema mismatch" },
          },
        ],
      } as StoredScoreRun["report"]["protocol"],
    },
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/results/tok_test"]}>
      <Routes>
        <Route path="/results/:runToken" element={<ScoreResultsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ScoreResultsPage pending profile stamp", () => {
  beforeEach(() => {
    mockFetchScoreRun.mockReset();
  });

  it.each([
    [null, 0, 0, 1, "not scored. 1 check needs input"],
    [null, 0, 0, 7, "not scored. 7 checks need input"],
    [
      100,
      1,
      1,
      7,
      "100/100 — 1/1 applicable checks passed, 7 checks need input",
    ],
    [
      25,
      1,
      4,
      5,
      "25/100 — 1/4 applicable checks passed, 2 checks need input, 3 could not run",
    ],
  ])(
    "names missing inputs in saved summaries (%s, %i/%i, %i unrun)",
    async (score, passed, applicable, couldNotRun, expected) => {
      const headline = summary({
        score,
        passed,
        applicable,
        couldNotRun,
        outcome: "incomplete",
      });
      mockFetchScoreRun.mockResolvedValue({
        ...pendingBearingRun(),
        ...headline,
        suiteSummaries: [{ suiteId: "tasks", ...headline }],
        report: {},
      });
      renderPage();
      await waitFor(() => {
        // The suite always shows a summary; a scored run also has a headline.
        expect(
          screen.getAllByText(
            score === null ? expected : `${expected} [2025-11-25]`,
          ),
        ).toHaveLength(score === null ? 1 : 2);
      });
    },
  );

  it.each([
    [
      "tasksProbe",
      "Select a tool that creates a task in setup, then run again.",
    ],
    ["logProbe", "Select a tool that emits logs in setup, then run again."],
    [
      "inputRequiredProbe",
      "Select a tool that asks for input in setup, then run again.",
    ],
    [
      "toolCallProbe",
      "Select a tool to check output in setup, then run again.",
    ],
    [undefined, "Select a tool that creates a task in setup, then run again."],
  ])(
    "shows neutral setup guidance for shared missing-input rows (%s)",
    async (missingInput, expected) => {
      const raw =
        "no probe tool could be selected automatically: choose a task tool";
      mockFetchScoreRun.mockResolvedValue({
        ...pendingBearingRun(),
        report: {
          tasks: {
            checks: [
              {
                id: "tasks-result-type-discipline",
                title: "Result Type Discipline",
                status: "skipped",
                skipReason: "could-not-run",
                error: { message: raw },
                ...(missingInput ? { details: { missingInput } } : {}),
              },
            ],
          },
        },
      });
      renderPage();
      const message = await screen.findByText(expected);
      const row = message.closest("li");
      expect(row).toHaveTextContent("Not run");
      expect(message).toHaveClass("text-muted-foreground");
      expect(row?.querySelector("svg")).toHaveClass("text-muted-foreground");
      expect(screen.queryByText(raw)).not.toBeInTheDocument();
      expect(screen.queryByText("could-not-run")).not.toBeInTheDocument();
    },
  );

  it.each([
    [
      0,
      1,
      0,
      "0/100 — 0/1 applicable checks passed, 1 could not run [2025-11-25]",
    ],
    [
      100,
      1,
      1,
      "100/100 — 1/1 applicable checks passed, 1 check needs input [2025-11-25]",
    ],
  ])(
    "does not claim a missing-input row was excluded from stored score %i",
    async (score, applicable, passed, expected) => {
      const headline = summary({
        score,
        applicable,
        passed,
        couldNotRun: 1,
        outcome: "incomplete",
      });
      mockFetchScoreRun.mockResolvedValue({
        ...pendingBearingRun(),
        ...headline,
        suiteSummaries: [{ suiteId: "tasks", ...headline }],
        report: {
          tasks: {
            checks: [
              {
                id: "tasks-result-type-discipline",
                title: "Result Type Discipline",
                status: "skipped",
                skipReason: "could-not-run",
                error: {
                  message:
                    "no probe tool could be selected automatically: choose a task tool",
                },
              },
            ],
          },
        },
      });
      renderPage();
      const label = await screen.findByText("Not run");
      expect(label).toHaveAttribute(
        "title",
        "This check needs a setup change before it can run.",
      );
      expect(screen.queryByTitle(/Not scored/)).not.toBeInTheDocument();
      expect(screen.getAllByText(expected)).toHaveLength(2);
      expect(
        screen.getByText(
          "Select a tool that creates a task in setup, then run again.",
        ),
      ).toBeInTheDocument();
    },
  );

  it("keeps an actual server failure red on shared score rows", async () => {
    mockFetchScoreRun.mockResolvedValue(stampLessLegacyRun());
    renderPage();
    expect(await screen.findByText("schema mismatch")).toHaveClass(
      "text-red-400",
    );
    expect(screen.queryByText("Not run")).not.toBeInTheDocument();
  });

  it("names pending in the headline and marks the pending failed row unscored", async () => {
    mockFetchScoreRun.mockResolvedValue(pendingBearingRun());
    renderPage();

    await waitFor(() => {
      expect(
        screen.getAllByText(/1 pending \(unscored by this profile\)/).length,
      ).toBeGreaterThan(0);
    });

    const pendingRow = screen.getByText("Wire schema is valid").closest("li");
    expect(pendingRow).toBeTruthy();
    expect(pendingRow).toHaveTextContent("unscored");
    expect(
      screen.getByTitle("unscored by this run's profile").closest("li"),
    ).toBe(pendingRow);
    // The fail icon stays: pending is orthogonal to execution status.
    expect(pendingRow?.querySelector("svg")).toBeTruthy();

    const scoredRow = screen.getByText("Initialize handshake").closest("li");
    expect(scoredRow).not.toHaveTextContent("unscored");
  });

  it("renders a stamp-less legacy run unchanged — no pending clause, no unscored badge", async () => {
    mockFetchScoreRun.mockResolvedValue(stampLessLegacyRun());
    renderPage();

    await waitFor(() => {
      expect(
        screen.getAllByText(/1\/2 applicable checks passed, 1 failed/).length,
      ).toBeGreaterThan(0);
    });

    expect(
      screen.queryByText(/pending \(unscored by this profile\)/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("unscored")).not.toBeInTheDocument();
    expect(screen.getByText("Wire schema is valid")).toBeInTheDocument();
    expect(screen.getByText("schema mismatch")).toBeInTheDocument();
  });
});
