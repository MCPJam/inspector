import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import type { ConformanceRunListItem } from "../ConformanceHistory";

const { navigateMock, useArtifactQueryMock, fetchArtifactMock } = vi.hoisted(
  () => ({
    navigateMock: vi.fn(),
    useArtifactQueryMock: vi.fn(),
    fetchArtifactMock: vi.fn(),
  }),
);

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

vi.mock("@/lib/artifact-urls", () => ({
  useArtifactQuery: (...args: unknown[]) => useArtifactQueryMock(...args),
  fetchArtifact: (...args: unknown[]) => fetchArtifactMock(...args),
}));

vi.mock("@/lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-navigation")>();
  return { ...actual, useAppNavigate: () => navigateMock };
});

// The panel reads share settings from Convex; these specs only need to know
// which resource the dialog opened for.
vi.mock("@/components/sharing/ResourceSharePanel", () => ({
  ResourceSharePanel: (props: { resourceType: string; resourceId: string }) => (
    <div data-testid="stub-share-panel">
      {props.resourceType}:{props.resourceId}
    </div>
  ),
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

  it("opens the share dialog for this run from Share", () => {
    useArtifactQueryMock.mockReturnValue(run([report()]));
    render(<ConformanceRunDetailPage runId="run_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.getByTestId("stub-share-panel")).toHaveTextContent(
      "conformanceRun:run_1",
    );
  });

  it("keeps Share disabled while the run is still going", () => {
    useArtifactQueryMock.mockReturnValue(
      run([report({ status: "running", outcome: null })], {
        status: "running",
        outcome: null,
      }),
    );
    render(<ConformanceRunDetailPage runId="run_1" />);

    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
  });

  it("opens the same dialog for a run shared with the old toggle", () => {
    useArtifactQueryMock.mockReturnValue(
      run([report()], { sharingEnabled: true }),
    );
    render(<ConformanceRunDetailPage runId="run_1" />);

    expect(screen.queryByRole("button", { name: /Shareable/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.getByTestId("stub-share-panel")).toBeInTheDocument();
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

  it("runs the same server again from Run again", () => {
    navigateMock.mockReset();
    useArtifactQueryMock.mockReturnValue(run([report()]));
    render(
      <ConformanceRunDetailPage
        runId="run_1"
        serverNames={new Map([["srv_1", "Weather"]])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(navigateMock).toHaveBeenCalledWith("/conformance?run=Weather");
  });

  it("sends Run again to Conformance, with no Settings, for a server the project no longer has", () => {
    navigateMock.mockReset();
    useArtifactQueryMock.mockReturnValue(run([report()]));
    render(
      <ConformanceRunDetailPage
        runId="run_1"
        serverSettings={{ loaded: true, save: vi.fn() }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(navigateMock).toHaveBeenCalledWith("/conformance");
  });

  it("opens the server's Settings from the run, and Back returns to it", async () => {
    useArtifactQueryMock.mockReturnValue(run([report()]));
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ConformanceRunDetailPage
        runId="run_1"
        serverNames={new Map([["srv_1", "Weather"]])}
        serverSettings={{ loaded: false, save }}
      />,
    );
    // Not before the defaults load: a change would save over them.
    expect(screen.getByRole("button", { name: "Settings" })).toBeDisabled();

    rerender(
      <ConformanceRunDetailPage
        runId="run_1"
        serverNames={new Map([["srv_1", "Weather"]])}
        serverSettings={{
          defaults: { Weather: { tasks: [], oauth: false } },
          loaded: true,
          save,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getByRole("heading", { name: "Weather Conformance Settings" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Run again" })).toBeDefined();
  });

  it("waits for server lookup before Run again, including a deleted server", () => {
    navigateMock.mockReset();
    useArtifactQueryMock.mockReturnValue(run([report()]));
    const { rerender } = render(
      <ConformanceRunDetailPage runId="run_1" serversLoading />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(navigateMock).not.toHaveBeenCalled();
    rerender(
      <ConformanceRunDetailPage
        runId="run_1"
        serverNames={new Map([["srv_1", "Weather"]])}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(navigateMock).toHaveBeenLastCalledWith("/conformance?run=Weather");
    rerender(<ConformanceRunDetailPage runId="run_1" serverNames={new Map()} />);
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(navigateMock).toHaveBeenLastCalledWith("/conformance");
  });

  it.each([false, true])("waits for all Settings saves before Back (failure: %s)", async (fail) => {
    useArtifactQueryMock.mockReturnValue(run([report()]));
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => { finishFirst = resolve; }),
      )
      .mockImplementationOnce(
        () => new Promise<void>((resolve, reject) => {
          finishSecond = () => fail ? reject(new Error("Save failed")) : resolve();
        }),
      );
    render(
      <ConformanceRunDetailPage
        runId="run_1"
        serverNames={new Map([["srv_1", "Weather"]])}
        serverSettings={{ defaults: { Weather: {} }, loaded: true, save }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Run Tasks" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Run OAuth" }));
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
    await act(async () => finishFirst());
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    await act(async () => finishSecond());
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled();
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

  it("shows absent Apps without an explanation or percentage", () => {
    useArtifactQueryMock.mockReturnValue(run([
      report({ suiteKind: "apps", score: null, applicable: 0, passed: 0 }),
    ]));
    render(<ConformanceRunDetailPage runId="run_1" />);
    const header = screen.getByText("Apps").closest("button")!;
    expect(within(header).getByText("NOT APPLICABLE")).toBeInTheDocument();
    expect(within(header).queryByText("%")).toBeNull();
    expect(screen.queryByText("Nothing here applied to this server, so it was not scored.")).toBeNull();
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/^7 checks in this suite\.$/)).toBeInTheDocument();
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

  it.each(["oauth", "apps"])("keeps the skipped %s reason and not-run note", (suiteKind) => {
    useArtifactQueryMock.mockReturnValue(
      run([
        report(),
        report({
          suiteKind,
          status: "skipped",
          score: null,
          applicable: 0,
          passed: 0,
          incompleteReason: `${suiteKind} was skipped.`,
        }),
      ]),
    );
    render(<ConformanceRunDetailPage runId="run_1" />);

    const oauth = screen.getByText(`${suiteKind} was skipped.`).closest("button")!;
    fireEvent.click(oauth);
    expect(screen.getByText(/checks in this suite\. Not run\./)).toBeInTheDocument();
    expect(screen.queryByText(/None apply to this server/)).toBeNull();
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

  it("keeps an unscored check's saved failure grey, like the live row", async () => {
    fetchArtifactMock.mockResolvedValue(
      reportBody([
        { id: "ping", title: "Ping", status: "failed", error: "pong missing" },
        {
          id: "oauth_token_format",
          title: "Token format",
          status: "failed",
          error: "not a JWT",
          pending: true,
        },
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

    await screen.findByText("Token format");
    expect(screen.getByText("pong missing").className).toMatch(/text-red-600/);
    expect(screen.getByText("not a JWT").className).not.toMatch(/text-red/);
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
