import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import type { BenchRun } from "@/lib/apis/bench-api";

const { mockCancelBenchRun, mockFetchBenchResult, mockFetchBenchRun } =
  vi.hoisted(() => ({
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
import {
  readBenchResultSecret,
  rememberBenchResultSecret,
} from "../bench-result-secret";

/**
 * A POLL response, in the shape `GET /runs/:runId` actually returns.
 *
 * `benchmarkRunId`, not `runId` — the latter is not a field on `BenchRun` and
 * the `satisfies` above it only ever passed because client tests are excluded
 * from `typecheck:client`.
 *
 * And deliberately NO `resultSecret`: the backend stores a digest, so the
 * plaintext exists in the start response and nowhere else. A fixture that put
 * it on a poll made the old result test green against code that read it from
 * there.
 */
function run(overrides: Partial<BenchRun> & { status: BenchRun["status"] }) {
  return { benchmarkRunId: "run_1", ...overrides } satisfies BenchRun;
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
  sessionStorage.clear();
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
    // The secret is held from the start, exactly as the page does it — NOT
    // read off a poll, which never carries one.
    rememberBenchResultSecret("run_1", "sec_1");
    mockFetchBenchRun
      .mockResolvedValueOnce(run({ status: "running" }))
      .mockResolvedValue(run({ status: "completed" }));
    mockFetchBenchResult.mockResolvedValue({
      runId: "run_1",
      scorecard: {
        status: "scored",
        scores: { core: 90, category: 70, composite: 80 },
        sections: {
          coreProtocol: {
            section: "coreProtocol",
            coverage: "eligible",
            score: 90,
          },
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

  /**
   * The capability the whole report depends on.
   *
   * `POST /runs` is the only response that carries `resultSecret`; the backend
   * keeps a digest and `GET /runs/:id` cannot hand it back. So anything that
   * reads the secret off the run row loses it on the first poll — seconds
   * after the start — and a refresh cannot recover it, because there is
   * nowhere left to recover it from.
   */
  it("keeps the result secret across polls that do not carry one", async () => {
    rememberBenchResultSecret("run_1", "sec_1");
    mockFetchBenchRun
      .mockResolvedValueOnce(run({ status: "queued" }))
      .mockResolvedValueOnce(run({ status: "running" }))
      .mockResolvedValue(run({ status: "completed" }));
    mockFetchBenchResult.mockResolvedValue({ benchmarkRunId: "run_1" });

    renderAtRun();
    await vi.advanceTimersByTimeAsync(9000);

    await waitFor(() => {
      expect(mockFetchBenchResult).toHaveBeenCalledWith("sec_1");
    });
  });

  it("does not spend the secret on a run that is still going", async () => {
    // Fetching early is not merely wasteful: the backend answers a live run
    // with `ready: false`, and recording that as the report would show a
    // finished-looking page with nothing in it.
    rememberBenchResultSecret("run_1", "sec_1");
    mockFetchBenchRun.mockResolvedValue(run({ status: "running" }));

    renderAtRun();
    await vi.advanceTimersByTimeAsync(9000);

    expect(mockFetchBenchResult).not.toHaveBeenCalled();
  });

  it("releases the secret once the report is in hand", async () => {
    rememberBenchResultSecret("run_1", "sec_1");
    mockFetchBenchRun.mockResolvedValue(run({ status: "completed" }));
    mockFetchBenchResult.mockResolvedValue({ benchmarkRunId: "run_1" });

    renderAtRun();

    await waitFor(() => {
      expect(mockFetchBenchResult).toHaveBeenCalledWith("sec_1");
    });
    // Holding a capability past the document it opens is a liability, and the
    // report is in memory by now.
    await waitFor(() => {
      expect(readBenchResultSecret("run_1")).toBeNull();
    });
  });

  it("keeps the secret when the fetch fails, so a reload can retry", async () => {
    // The one copy of the capability must not be spent by a transient error.
    rememberBenchResultSecret("run_1", "sec_1");
    mockFetchBenchRun.mockResolvedValue(run({ status: "completed" }));
    mockFetchBenchResult.mockRejectedValue(new Error("network"));

    renderAtRun();

    await waitFor(() => {
      expect(mockFetchBenchResult).toHaveBeenCalledWith("sec_1");
    });
    expect(readBenchResultSecret("run_1")).toBe("sec_1");
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
