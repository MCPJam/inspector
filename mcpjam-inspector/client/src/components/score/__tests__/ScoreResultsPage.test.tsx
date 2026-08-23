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
