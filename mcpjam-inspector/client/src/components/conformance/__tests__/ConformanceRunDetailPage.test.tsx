import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import type { ConformanceRunListItem } from "../ConformanceHistory";

const {
  navigateMock,
  useArtifactQueryMock,
  fetchArtifactMock,
  setSharingMock,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  useArtifactQueryMock: vi.fn(),
  setSharingMock: vi.fn(),
  fetchArtifactMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useMutation: () => vi.fn(),
  useAction: () => setSharingMock,
}));

vi.mock("@/lib/artifact-urls", () => ({
  useArtifactQuery: (...args: unknown[]) => useArtifactQueryMock(...args),
  fetchArtifact: (...args: unknown[]) => fetchArtifactMock(...args),
}));

vi.mock("@/lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-navigation")>();
  return { ...actual, useAppNavigate: () => navigateMock };
});

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
}));

import { ConformanceRunDetailPage } from "../ConformanceHistory";
import { SUITE_COPY } from "../conformance-ui";

type SavedReport = {
  suiteKind: string;
  status: string;
  outcome: string | null;
  incompleteReason: string | null;
  score: number | null;
  applicable: number;
  passed: number;
  failed: number;
  couldNotRun: number;
  reportUrl?: string | null;
};

function report(overrides: Partial<SavedReport> = {}): SavedReport {
  return {
    suiteKind: "protocol",
    status: "completed",
    outcome: "passed",
    incompleteReason: null,
    score: 100,
    applicable: 1,
    passed: 1,
    failed: 0,
    couldNotRun: 0,
    reportUrl: "https://artifacts.test/protocol.json",
    ...overrides,
  };
}

function run(
  reports: SavedReport[],
  overrides: Partial<ConformanceRunListItem> = {},
) {
  return {
    _id: "run_1",
    projectId: "proj_1",
    targetKind: "server",
    targetKey: "server:srv_1",
    serverId: "srv_1",
    source: "ui",
    verification: "client_reported",
    status: "completed",
    outcome: "passed",
    incompleteReason: null,
    score: 100,
    applicable: 1,
    passed: 1,
    failed: 0,
    couldNotRun: 0,
    requestedSuites: reports.map((entry) => entry.suiteKind),
    protocolVersion: "2025-11-25",
    actorLabel: "Inspector UI",
    ciMetadata: null,
    createdAt: Date.now() - 60_000,
    completedAt: Date.now() - 60_000,
    durationMs: 0,
    sharingEnabled: false,
    reports,
    previous: null,
    shareVersion: 0,
    ...overrides,
  };
}

function reportBody(cases: unknown[]) {
  return { ok: true, json: async () => ({ groups: [{ cases }] }) };
}

/** A suite's header row, found by its description. */
function suiteHeader(suite: keyof typeof SUITE_COPY) {
  return screen.getByText(SUITE_COPY[suite].description).closest("button")!;
}

describe("ConformanceRunDetailPage", () => {
  beforeEach(() => {
    useArtifactQueryMock.mockReset();
    fetchArtifactMock.mockReset();
    setSharingMock.mockReset();
  });

  it("says it is loading until the run arrives", () => {
    useArtifactQueryMock.mockReturnValue(undefined);
    render(<ConformanceRunDetailPage runId="run_1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading run…");
  });

  it("explains a run that is missing or not visible", () => {
    useArtifactQueryMock.mockReturnValue(null);
    render(<ConformanceRunDetailPage runId="run_1" />);
    expect(screen.getByText("Run not found")).toBeInTheDocument();
  });

  it("labels an app run as UI, with no Client-reported tag and no Private button", () => {
    useArtifactQueryMock.mockReturnValue(run([report()]));
    render(<ConformanceRunDetailPage runId="run_1" />);

    expect(screen.getByText(/· UI$/)).toBeInTheDocument();
    expect(screen.queryByText(/Inspector ·|· Inspector/)).toBeNull();
    expect(screen.queryByText(/Client-reported/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Private/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Run again" })).toBeDefined();
  });

  it("offers Share on a private run, which turns sharing on", async () => {
    setSharingMock.mockResolvedValue({ enabled: false });
    useArtifactQueryMock.mockReturnValue(run([report()]));
    render(<ConformanceRunDetailPage runId="run_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() =>
      expect(setSharingMock).toHaveBeenCalledWith({
        runId: "run_1",
        enabled: true,
      }),
    );
  });

  it("keeps a way to stop sharing a run that is already shared", () => {
    useArtifactQueryMock.mockReturnValue(
      run([report()], { sharingEnabled: true }),
    );
    render(<ConformanceRunDetailPage runId="run_1" />);
    expect(
      screen.getByRole("button", { name: /Shareable/ }),
    ).toBeInTheDocument();
  });

  it("names the server from the project's saved servers", () => {
    useArtifactQueryMock.mockReturnValue(run([report()]));
    render(
      <ConformanceRunDetailPage
        runId="run_1"
        serverNames={new Map([["srv_1", "Weather"]])}
      />,
    );
    expect(screen.getAllByText("Weather").length).toBeGreaterThanOrEqual(1);
  });

  it("marks a suite a finished run never heard back from as NO RESULT", () => {
    useArtifactQueryMock.mockReturnValue(
      run(
        [
          report(),
          report({
            suiteKind: "oauth",
            status: "running",
            outcome: null,
            score: null,
            applicable: 0,
            passed: 0,
          }),
        ],
        {
          status: "timed_out",
          outcome: "incomplete",
          score: null,
          incompleteReason:
            "Run lease expired before every requested suite settled",
        },
      ),
    );
    render(<ConformanceRunDetailPage runId="run_1" />);

    const oauth = screen
      .getByText("This suite did not report a result for this run.")
      .closest("button")!;
    expect(within(oauth).getByText("NO RESULT")).toBeInTheDocument();
    // Not a spinner: the run is over, so the suite will never finish.
    expect(within(oauth).queryByText("RUNNING")).toBeNull();
    expect(
      screen.getByText("Incomplete. No check finished, so there is no score."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Run lease expired before every requested suite settled",
      ),
    ).toBeInTheDocument();
  });

  it("shows a suite with nothing applicable as NOT APPLICABLE, without a score", () => {
    useArtifactQueryMock.mockReturnValue(
      run([
        report(),
        report({
          suiteKind: "oauth",
          score: null,
          applicable: 0,
          passed: 0,
          incompleteReason: "This server does not require authorization.",
        }),
      ]),
    );
    render(<ConformanceRunDetailPage runId="run_1" />);

    const oauth = screen
      .getByText("This server does not require authorization.")
      .closest("button")!;
    expect(within(oauth).getByText("NOT APPLICABLE")).toBeInTheDocument();
    // Shut by default, but it opens to the suite's checks so the reader can
    // see what it covers. There is no report to fetch for it.
    expect(oauth).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(oauth);
    expect(oauth).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText(/checks in this suite\. None apply to this server\./),
    ).toBeInTheDocument();
    expect(fetchArtifactMock).not.toHaveBeenCalled();
  });

  it("opens a failed suite and loads its checks from the report", async () => {
    fetchArtifactMock.mockResolvedValue(
      reportBody([
        { id: "ping", title: "Ping", status: "failed", error: "pong missing" },
      ]),
    );
    useArtifactQueryMock.mockReturnValue(
      run([
        report({
          outcome: "failed",
          score: 0,
          passed: 0,
          failed: 1,
          status: "failed",
        }),
      ]),
    );
    render(<ConformanceRunDetailPage runId="run_1" />);

    expect(suiteHeader("protocol")).toHaveAttribute("aria-expanded", "true");
    await screen.findByText("Ping");
    expect(screen.getByText("pong missing")).toBeInTheDocument();
    expect(fetchArtifactMock).toHaveBeenCalledWith(
      "https://artifacts.test/protocol.json",
    );
  });

  it("fetches a passing suite's report only when it is opened", async () => {
    fetchArtifactMock.mockResolvedValue(
      reportBody([{ id: "ping", title: "Ping", status: "passed" }]),
    );
    useArtifactQueryMock.mockReturnValue(run([report()]));
    render(<ConformanceRunDetailPage runId="run_1" />);

    expect(fetchArtifactMock).not.toHaveBeenCalled();

    fireEvent.click(suiteHeader("protocol"));

    await screen.findByText("Ping");
    expect(fetchArtifactMock).toHaveBeenCalledTimes(1);
  });

  it("says what to do when a report cannot be loaded", async () => {
    fetchArtifactMock.mockResolvedValue({ ok: false, status: 403 });
    useArtifactQueryMock.mockReturnValue(
      run([report({ outcome: "failed", status: "failed", score: 0 })]),
    );
    render(<ConformanceRunDetailPage runId="run_1" />);

    await waitFor(() =>
      expect(
        screen.getByText(
          "The detailed report for this suite is not available. Run the checks again to generate a new one.",
        ),
      ).toBeInTheDocument(),
    );
  });
});
