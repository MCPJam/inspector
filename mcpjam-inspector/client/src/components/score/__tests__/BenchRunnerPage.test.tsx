import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import type { BenchRun } from "@/lib/apis/bench-api";

const {
  mockCancelBenchRun,
  mockFetchBenchResult,
  mockFetchBenchRun,
} = vi.hoisted(() => ({
  mockCancelBenchRun: vi.fn(),
  mockFetchBenchResult: vi.fn(),
  mockFetchBenchRun: vi.fn(),
}));

vi.mock("@/lib/apis/bench-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/apis/bench-api")>();
  return {
    ...actual,
    cancelBenchRun: (...args: unknown[]) => mockCancelBenchRun(...args),
    fetchBenchResult: (...args: unknown[]) => mockFetchBenchResult(...args),
    fetchBenchRun: (...args: unknown[]) => mockFetchBenchRun(...args),
    preflightBench: vi.fn(),
    quoteBench: vi.fn(),
    startBenchRun: vi.fn(),
  };
});

vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));
vi.mock("@/hooks/use-app-ready", () => ({
  useAppReady: () => ({ status: "ready" }),
  useAppReadyMessage: () => null,
}));
vi.mock("@/hooks/hosted/use-hosted-oauth-gate", () => ({
  useHostedOAuthGate: () => ({
    authorizeServer: vi.fn(),
    hasBusyOAuth: false,
  }),
}));
vi.mock("@/lib/apis/web/context", () => ({
  tryResolveProjectServer: () => null,
}));
vi.mock("@/lib/apis/web/servers-api", () => ({
  validateHostedServer: vi.fn(),
}));

import { BenchRunnerPage } from "../BenchRunnerPage";

function run(overrides: Partial<BenchRun> & { status: BenchRun["status"] }) {
  return { runId: "run_1", ...overrides } satisfies BenchRun;
}

function renderAtRun() {
  return render(
    <MemoryRouter initialEntries={["/embed/bench/run_1"]}>
      <Routes>
        <Route
          path="/embed/bench/:runId"
          element={<BenchRunnerPage convexProjectId="proj_1" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockCancelBenchRun.mockReset();
  mockFetchBenchResult.mockReset();
  mockFetchBenchRun.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The whole point of this screen: no browser-side orchestration, so a page
 * loaded cold at a run's URL behaves exactly like one that started it.
 */
describe("the phase is whatever GET /runs/:runId last said", () => {
  it("shows the progress screen for a run it never started", async () => {
    mockFetchBenchRun.mockResolvedValue(
      run({
        status: "awaiting_evidence",
        progress: { cellsCompleted: 3, cellsTotal: 4 },
      }),
    );

    renderAtRun();

    await waitFor(() => {
      expect(screen.getByText("Collecting results")).toBeInTheDocument();
    });
    expect(mockFetchBenchRun).toHaveBeenCalledWith("run_1");
    expect(screen.getByText("75% of the matrix reported")).toBeInTheDocument();
  });

  it("moves to the report the poll after the run settles", async () => {
    mockFetchBenchRun
      .mockResolvedValueOnce(run({ status: "running" }))
      .mockResolvedValue(
        run({ status: "completed", resultSecret: "sec_1" }),
      );
    mockFetchBenchResult.mockResolvedValue({
      runId: "run_1",
      scorecard: {
        status: "scored",
        scores: { core: 90, category: 70, composite: 80 },
        sections: {
          coreProtocol: { section: "coreProtocol", coverage: "eligible", score: 90 },
          protocolExtensions: {
            section: "protocolExtensions",
            coverage: "not_applicable",
            score: null,
          },
          workflowReliability: {
            section: "workflowReliability",
            coverage: "eligible",
            score: 70,
          },
          overall: 80,
        },
      },
    });

    renderAtRun();

    await waitFor(() => {
      expect(screen.getByText("Running the exam")).toBeInTheDocument();
    });

    await vi.advanceTimersByTimeAsync(3000);

    await waitFor(() => {
      expect(screen.getByLabelText("Sections")).toBeInTheDocument();
    });
    expect(mockFetchBenchResult).toHaveBeenCalledWith("sec_1");
    expect(screen.queryByText("Running the exam")).not.toBeInTheDocument();
  });

  it("stops polling once the run is terminal", async () => {
    mockFetchBenchRun.mockResolvedValue(run({ status: "cancelled" }));

    renderAtRun();

    await waitFor(() => expect(mockFetchBenchRun).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    // A settled row never changes again; re-reading it spends the caller's
    // rate-limit budget on an answer that cannot move.
    expect(mockFetchBenchRun).toHaveBeenCalledTimes(1);
    expect(screen.getByText("This run was cancelled.")).toBeInTheDocument();
  });

  it("keeps polling while the run is live", async () => {
    mockFetchBenchRun.mockResolvedValue(run({ status: "queued" }));

    renderAtRun();

    await waitFor(() => expect(mockFetchBenchRun).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(mockFetchBenchRun).toHaveBeenCalledTimes(2));
  });

  it("distinguishes our failure from the connector's", async () => {
    mockFetchBenchRun.mockResolvedValue(
      run({ status: "failed", failureMessage: "Assembly lease expired." }),
    );

    renderAtRun();

    await waitFor(() => {
      expect(
        screen.getByText("We could not produce a result for this run."),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Assembly lease expired.")).toBeInTheDocument();
  });
});

describe("cancelling is a request, not an outcome", () => {
  it("keeps the progress screen until the backend says otherwise", async () => {
    mockFetchBenchRun.mockResolvedValue(
      run({ status: "running", cancelRequested: true }),
    );

    renderAtRun();

    await waitFor(() => {
      expect(screen.getByText("Cancelling")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/The run stops after the case it is on/),
    ).toBeInTheDocument();
  });
});
