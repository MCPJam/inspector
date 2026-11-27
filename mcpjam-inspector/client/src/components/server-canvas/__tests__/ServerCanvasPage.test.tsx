import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { FormEvent } from "react";
import { RouterProvider, createMemoryRouter, useLocation } from "react-router";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  createConnectedServer,
  createHttpServerConfig,
  createServer,
} from "@/test/factories";
import {
  captureServerDetailModalOAuthResume,
  readOpenServerDetailModalState,
  readServerDetailModalOAuthResume,
  writeOpenServerDetailModalState,
} from "@/lib/server-detail-modal-resume";
import { ServerCanvasPage } from "../ServerCanvasPage";
import { formatEvidenceTime } from "../feature-states";
import { CAPTURED_AT, storedEvidence } from "./fixtures";

const mockSoftQuery = vi.hoisted(() => vi.fn());
const mockAuthFetch = vi.hoisted(() => vi.fn());
const controllerSpy = vi.hoisted(() => ({
  toggle: vi.fn(),
  connect: vi.fn(),
  submit: vi.fn(),
  options: null as null | Record<string, unknown>,
}));

vi.mock("@/hooks/use-soft-query", () => ({
  useSoftQuery: (name: string, args: unknown) => mockSoftQuery(name, args),
}));
vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

const TABS = [
  { id: "configuration", label: "Config" },
  { id: "overview", label: "Overview" },
  { id: "tools-metadata", label: "Tools" },
  { id: "authorization", label: "Auth" },
  { id: "compatibility", label: "Clients" },
  { id: "history", label: "History" },
];

// The controller and the tab bodies have their own tests; here they only
// show which tab is up and what the page handed them.
vi.mock("@/components/connection/hooks/use-server-detail-controller", () => ({
  useServerDetailController: (options: {
    server: ServerWithName;
    activeTab?: string;
    onTabChange?: (tab: string) => void;
  }) => {
    controllerSpy.options = options;
    return {
      server: options.server,
      version: "1.8.0",
      tabs: {
        active: options.activeTab ?? "configuration",
        select: (tab: string) => options.onTabChange?.(tab),
        visible: TABS,
      },
      connection: {
        isConnected: options.server.connectionStatus === "connected",
        isReconnecting: false,
        toggleDisabled: false,
        connect: controllerSpy.connect,
        toggle: controllerSpy.toggle,
      },
      form: {
        saveBlocked: false,
        save: vi.fn(),
        submit: (event: FormEvent) => {
          event.preventDefault();
          controllerSpy.submit();
        },
      },
      settings: { showBody: false },
    };
  },
}));
vi.mock("@/components/connection/ServerDetailTabBodies", () => ({
  ServerDetailIdentity: ({ controller }: { controller: { server: ServerWithName } }) => (
    <span>{controller.server.name}</span>
  ),
  ServerDetailConnectionControls: () => <span>connection controls</span>,
  ServerConfigTabBody: () => <div>config body</div>,
  ServerConfigSaveButton: () => <button type="submit">Save & Connect</button>,
  ServerSettingsTabBody: () => <div>settings body</div>,
  ServerOverviewTabBody: ({
    evaluatedCapabilities,
  }: {
    evaluatedCapabilities?: readonly string[];
  }) => (
    <div>
      overview body: {evaluatedCapabilities?.join(", ") ?? "initializationInfo"}
    </div>
  ),
  ServerAuthTabBody: () => <div>auth body</div>,
  ServerToolsTabBody: () => <div>tools body</div>,
  ServerClientsTabBody: () => <div>clients body</div>,
  ServerHistoryTabBody: () => <div>history body</div>,
}));

function Elsewhere() {
  const location = useLocation();
  return <div data-testid="elsewhere">{`${location.pathname}${location.search}`}</div>;
}

const connected = createConnectedServer({
  name: "atlas",
  config: createHttpServerConfig("https://atlas.example.com/mcp"),
});

function renderPage(url: string, server: ServerWithName = connected) {
  const onBack = vi.fn();
  const router = createMemoryRouter(
    [
      {
        path: "/servers/:serverId",
        element: (
          <ServerCanvasPage
            server={server}
            projectId="proj_1"
            hostedServerId="srv_1"
            onSubmit={vi.fn()}
            onDisconnect={vi.fn()}
            onReconnect={vi.fn()}
            existingServerNames={[server.name]}
            onBack={onBack}
          />
        ),
      },
      { path: "*", element: <Elsewhere /> },
    ],
    { initialEntries: [url] },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, onBack, ...view };
}

function evidence(stored = storedEvidence(), run: unknown = null) {
  return {
    data: { ...stored, latestConformanceRun: run },
    error: undefined,
  };
}

describe("ServerCanvasPage", () => {
  beforeEach(() => {
    localStorage.clear();
    mockSoftQuery.mockReset();
    mockSoftQuery.mockReturnValue(evidence());
    mockAuthFetch.mockReset();
    controllerSpy.toggle.mockReset();
    controllerSpy.connect.mockReset();
    controllerSpy.submit.mockReset();
  });

  it("opens on Config beside the feature map, reading saved evidence only", () => {
    renderPage("/servers/srv_1");
    expect(mockSoftQuery).toHaveBeenCalledWith(
      "serverFeatureEvidence:getForServer",
      { projectId: "proj_1", serverId: "srv_1" },
    );
    expect(mockAuthFetch).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("atlas");
    expect(screen.getByRole("tab", { name: "Config", selected: true })).toBeInTheDocument();
    expect(screen.getByText("config body")).toBeVisible();
    expect(screen.getByRole("region", { name: "MCP feature map" })).toBeInTheDocument();
    expect(
      screen.getByText(`Captured ${formatEvidenceTime(CAPTURED_AT)}.`),
    ).toBeInTheDocument();
    expect(controllerSpy.options).toMatchObject({
      isOpen: true,
      projectId: "proj_1",
      hostedServerId: "srv_1",
      analyticsLocation: "server_canvas",
    });
  });

  it("saves Config through the controller's form", () => {
    renderPage("/servers/srv_1");
    fireEvent.click(screen.getByRole("button", { name: "Save & Connect" }));
    expect(controllerSpy.submit).toHaveBeenCalled();
  });

  it("opens the tab ?serverTab= names and writes tab changes to the URL", () => {
    const { router } = renderPage("/servers/srv_1?serverTab=overview");
    expect(screen.getByRole("tab", { name: "Overview", selected: true })).toBeInTheDocument();
    // Overview's chips come from the evaluator.
    expect(screen.getByText("overview body: Tools, Resources")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(router.state.location.search).toBe("?serverTab=history");
    expect(screen.getByText("history body")).toBeInTheDocument();
  });

  it("shows ?feature= above the active tab, and again after a reload", () => {
    const url = "/servers/srv_1?serverTab=history&feature=tools.list";
    const first = renderPage(url);
    const detail = screen.getByTestId("feature-detail");
    expect(within(detail).getByRole("heading", { name: "tools/list" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "History", selected: true })).toBeInTheDocument();
    expect(screen.getByText("history body")).toBeInTheDocument();
    first.unmount();

    renderPage(url);
    expect(
      within(screen.getByTestId("feature-detail")).getByRole("heading", {
        name: "tools/list",
      }),
    ).toBeInTheDocument();
  });

  it("selects a whole family from its id and ignores an unknown id", () => {
    const family = renderPage("/servers/srv_1?feature=mcp-apps");
    expect(
      within(screen.getByTestId("feature-detail")).getByRole("heading", {
        name: "MCP Apps",
      }),
    ).toBeInTheDocument();
    family.unmount();

    renderPage("/servers/srv_1?feature=not.a.feature");
    expect(screen.queryByTestId("feature-detail")).toBeNull();
    expect(screen.getByText("config body")).toBeInTheDocument();
  });

  it("moves the selection with Back and Forward and closes the detail", async () => {
    const { router } = renderPage("/servers/srv_1");
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    fireEvent.click(screen.getByRole("button", { name: /^Prompts/ }));
    expect(router.state.location.search).toBe("?feature=prompts");
    fireEvent.click(
      within(screen.getByTestId("server-feature-list")).getByRole("button", {
        name: /^prompts capability,/,
      }),
    );
    expect(router.state.location.search).toBe("?feature=prompts.capability");

    await act(() => router.navigate(-1));
    expect(
      within(screen.getByTestId("feature-detail")).getByRole("heading", {
        name: "Prompts",
      }),
    ).toBeInTheDocument();
    await act(() => router.navigate(1));
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(router.state.location.search).toBe("");
    expect(screen.queryByTestId("feature-detail")).toBeNull();
  });

  it("starts the existing conformance run for this server on Run checks", () => {
    const { router } = renderPage("/servers/srv_1");
    fireEvent.click(screen.getByRole("button", { name: "Run checks" }));
    expect(router.state.location.pathname).toBe("/conformance");
    expect(router.state.location.search).toBe("?run=atlas");
  });

  it("links a failed check to its run", () => {
    mockSoftQuery.mockReturnValue(
      evidence(storedEvidence(), {
        runId: "run_9",
        createdAt: CAPTURED_AT + 1,
        completedAt: CAPTURED_AT + 2,
        status: "completed",
        protocolVersion: "2025-11-25",
        suites: [
          { suiteKind: "protocol", cases: [{ id: "server-initialize", status: "failed" }] },
        ],
      }),
    );
    const { router } = renderPage("/servers/srv_1?feature=server-info.name-version");
    const detail = screen.getByTestId("feature-detail");
    expect(within(detail).getByText("Check failed")).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: /Open run/ }));
    expect(router.state.location.pathname).toMatch(/\/conformance\/runs\/run_9$/);
  });

  it("calls the refresh route for this project server", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: "accepted" }),
    });
    renderPage("/servers/srv_1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/servers\/canvas\/refresh$/),
      expect.objectContaining({
        body: JSON.stringify({ projectId: "proj_1", serverId: "srv_1" }),
      }),
    );
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
  });

  it("refreshes from a feature whose background checks have not run", async () => {
    mockSoftQuery.mockReturnValue(
      evidence({ ...storedEvidence(), probeResults: [] }),
    );
    mockAuthFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: "accepted" }),
    });
    renderPage("/servers/srv_1?feature=auth-ext.client-credentials.token-auth-methods");
    const detail = screen.getByTestId("feature-detail");
    expect(
      within(detail).getByText(
        "Background checks have not run for this connection. Refresh to run them.",
      ),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(detail).getByRole("button", { name: "Refresh" }));
    });
    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/servers\/canvas\/refresh$/),
      expect.anything(),
    );
  });

  it("prompts a never-connected server to connect", () => {
    mockSoftQuery.mockReturnValue({
      data: { inspection: null, probeResults: [], observations: [], latestConformanceRun: null },
      error: undefined,
    });
    renderPage("/servers/srv_1?feature=tools.capability", createServer({ name: "atlas" }));
    expect(screen.getByText("Not captured yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This server has not been connected yet. Connect it to check its features.",
      ),
    ).toBeInTheDocument();
    const detail = screen.getByTestId("feature-detail");
    expect(within(detail).getByText("Not checked yet")).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "Connect" }));
    expect(controllerSpy.toggle).toHaveBeenCalledWith(true);
  });

  it("shows the last saved evidence while disconnected, and a failed attempt beside it", () => {
    mockSoftQuery.mockReturnValue(
      evidence(
        storedEvidence({
          latestAttempt: { status: "failed", at: CAPTURED_AT + 60_000, error: "capture_failed" },
        }),
      ),
    );
    renderPage(
      "/servers/srv_1",
      createServer({ name: "atlas", connectionStatus: "disconnected" }),
    );
    expect(
      screen.getByText(
        `Disconnected. Showing what was saved on ${formatEvidenceTime(CAPTURED_AT)}.`,
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("capture-banner")).getByRole("status"),
    ).toHaveTextContent(
      `The capture on ${formatEvidenceTime(CAPTURED_AT + 60_000)} failed. Connect to try again.`,
    );
  });

  it("says a first capture failed when only the probe run recorded it", () => {
    const at = CAPTURED_AT + 60_000;
    mockSoftQuery.mockReturnValue({
      data: {
        inspection: null,
        probeResults: [
          {
            contextHash: "ctx_aaaaaaaaaaaaaaaa",
            captureContext: { transport: "streamable-http", protocolVersion: "2025-11-25" },
            probes: [],
            failures: [],
            lastAttemptAt: at,
            lastAttemptStatus: "failed",
            lastAttemptError: "capture_failed",
            updatedAt: at,
          },
        ],
        observations: [],
        latestConformanceRun: null,
      },
      error: undefined,
    });
    renderPage("/servers/srv_1");
    const banner = screen.getByTestId("capture-banner");
    expect(
      within(banner).getByText("Nothing was saved for this server."),
    ).toBeInTheDocument();
    expect(within(banner).getByRole("status")).toHaveTextContent(
      `The capture on ${formatEvidenceTime(at)} failed. Refresh to try again.`,
    );
    expect(within(banner).getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("offers a context picker when evidence exists for several contexts", () => {
    mockSoftQuery.mockReturnValue(evidence(storedEvidence({ secondContext: true })));
    renderPage("/servers/srv_1");
    expect(
      screen.getByRole("combobox", { name: "Showing evidence for" }),
    ).toHaveTextContent("2025-11-25 · Streamable HTTP");
  });

  it("keeps the tabs working when saved evidence cannot be read", () => {
    mockSoftQuery.mockReturnValue({ data: undefined, error: new Error("nope") });
    renderPage("/servers/srv_1?serverTab=auth");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Saved feature evidence could not be loaded. Reload the page to try again.",
    );
    expect(screen.getByText("auth body")).toBeInTheDocument();
  });

  it.each([
    ["while saved evidence loads", { data: undefined, error: undefined }],
    ["after a failed read", { data: undefined, error: new Error("nope") }],
    [
      "before the first capture",
      {
        data: {
          inspection: null,
          probeResults: [],
          observations: [],
          latestConformanceRun: null,
        },
        error: undefined,
      },
    ],
  ])("leaves Overview its own capability list %s", (_when, result) => {
    mockSoftQuery.mockReturnValue(result);
    renderPage("/servers/srv_1?serverTab=overview");
    expect(
      screen.getByText("overview body: initializationInfo"),
    ).toBeInTheDocument();
  });

  it("marks the details open for an OAuth redirect and consumes the resume marker", () => {
    writeOpenServerDetailModalState("atlas");
    captureServerDetailModalOAuthResume("atlas");
    expect(readServerDetailModalOAuthResume()).not.toBeNull();
    const { unmount, onBack } = renderPage("/servers/srv_1");
    expect(readOpenServerDetailModalState()).toEqual({ serverName: "atlas" });
    expect(readServerDetailModalOAuthResume()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to servers" }));
    expect(onBack).toHaveBeenCalled();
    unmount();
    expect(readOpenServerDetailModalState()).toBeNull();
  });
});
