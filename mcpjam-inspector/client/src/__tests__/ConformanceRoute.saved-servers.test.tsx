import { useState, type ComponentProps } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppRouteReactContext } from "@/lib/app-route-context";
import { createHttpServerConfig, createServer } from "@/test/factories";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { UseConformanceRunResult } from "@/hooks/use-conformance-run";
import type { ConformanceRunListItem } from "@/components/conformance/ConformanceHistory";
import type { ServerDetailModal } from "@/components/connection/ServerDetailModal";

const mocks = vi.hoisted(() => ({
  servers: vi.fn(),
  data: vi.fn(),
  historyPage: { page: [], isDone: true, continueCursor: "" },
  runAll: vi.fn(async () => {}),
  ensureServersReady: vi.fn(),
  loadDefaults: vi.fn(async () => ({ selection: {}, inputs: {} })),
  saveDefaults: vi.fn(),
}));

vi.mock("@/hooks/useViews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useViews")>()),
  useProjectServers: mocks.servers,
}));
vi.mock("@/hooks/use-conformance-server-data", () => ({
  useConformanceServerData: mocks.data,
}));
vi.mock("@/hooks/use-conformance-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-conformance-run")>()),
  useConformanceRun: (): UseConformanceRunResult => ({
    protocol: { status: "idle" },
    apps: { status: "idle" },
    tasks: { status: "idle" },
    oauth: { status: "idle" },
    versionPin: "auto",
    setVersionPin: vi.fn(),
    runVersion: 0,
    runAll: mocks.runAll,
    authorizeOAuth: vi.fn(),
    openAuthorizationWindow: vi.fn(),
    skipOAuth: vi.fn(),
    oauthUnscored: [],
    oauthNotScored: false,
    isRunning: false,
  }),
}));
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));
vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useQuery: () => mocks.historyPage,
}));
vi.mock("@/components/conformance/PersistConformanceRun", () => ({
  PersistConformanceRun: () => null,
}));
vi.mock("@/components/connection/ServerDetailModal", () => ({
  ServerDetailModal: (props: ComponentProps<typeof ServerDetailModal>) => (
    <div role="dialog" aria-label="Connection settings">
      <p>{props.server.name}</p>
      <p>Known servers: {props.existingServerNames?.join(", ")}</p>
      <button onClick={props.onClose}>Close settings</button>
    </div>
  ),
}));
// Other routes imported by App pull in the JSON editor; this route never uses it.
vi.mock("@/components/ui/json-editor/codemirror-json-editor", () => ({
  CodemirrorJsonEditor: () => null,
}));

import { ConformanceRoute } from "../App";

type Project = {
  id: string;
  servers: Record<string, ServerWithName>;
  runs: Record<string, ConformanceRunListItem>;
};

function savedRun(name: string, projectId: string): ConformanceRunListItem {
  return {
    _id: `${projectId}_${name}_run`,
    projectId,
    targetKind: "server",
    targetKey: `server:${projectId}_${name}`,
    serverId: `${projectId}_${name}`,
    source: "ui",
    verification: "mcpjam_verified",
    status: "completed",
    outcome: "passed",
    incompleteReason: null,
    score: 100,
    applicable: 3,
    passed: 3,
    failed: 0,
    couldNotRun: 0,
    requestedSuites: ["protocol"],
    protocolVersion: "2025-11-25",
    actorLabel: null,
    ciMetadata: null,
    createdAt: 1,
    completedAt: 2,
    durationMs: 1,
    sharingEnabled: false,
  };
}

function project(id = "project_a", names = ["alpha", "beta"]): Project {
  return {
    id,
    servers: Object.fromEntries(
      names.map((name) => [
        name,
        createServer({
          name,
          enabled: true,
          config: createHttpServerConfig(`https://${name}.example/mcp`),
        }),
      ]),
    ),
    runs: Object.fromEntries(names.map((name) => [name, savedRun(name, id)])),
  };
}

function ProjectRoute({
  saved,
  session = {},
}: {
  saved: Project;
  session?: Record<string, ServerWithName>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const navigate = useNavigate();
  const entries = Object.keys(saved.servers).map(
    (name) => [`${saved.id}_${name}`, name] as const,
  );
  mocks.servers.mockReturnValue({
    servers: entries.map(([id, name]) => ({ _id: id, name })),
    serversById: new Map(entries),
    serversByName: new Map(entries.map(([id, name]) => [name, id])),
    isLoading: false,
    isBootstrapping: false,
  });
  mocks.data.mockReturnValue({
    defaultsByServer: {},
    inputsByServer: {},
    lastRunByServer: saved.runs,
    loadDefaults: mocks.loadDefaults,
    saveDefaults: mocks.saveDefaults,
  });
  return (
    <AppRouteReactContext.Provider
      value={{
        appState: { servers: session },
        projectServers: saved.servers,
        convexProjectId: saved.id,
        isAuthenticated: true,
        selectedServerEntry: selected ? saved.servers[selected] : null,
        setSelectedServer: setSelected,
        ensureServersReady: mocks.ensureServersReady,
        reconnectServerWithResult: vi.fn(),
        handleUpdate: vi.fn(),
        handleDisconnect: vi.fn(),
        handleReconnect: vi.fn(),
      }}
    >
      <button onClick={() => navigate("/other")}>Leave Conformance</button>
      <button onClick={() => navigate("/conformance")}>
        Return to Conformance
      </button>
      <Routes>
        <Route path="/conformance" element={<ConformanceRoute />} />
        <Route path="/other" element={<p>Another page</p>} />
      </Routes>
    </AppRouteReactContext.Provider>
  );
}

function page(saved: Project, session?: Record<string, ServerWithName>) {
  return (
    <MemoryRouter initialEntries={["/conformance"]}>
      <ProjectRoute saved={saved} session={session} />
    </MemoryRouter>
  );
}

function cards() {
  return within(screen.getByRole("list", { name: "Servers" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.ensureServersReady.mockResolvedValue({
    readyServerNames: [],
    reauthServerNames: [],
  });
});

describe("ConformanceRoute saved project servers", () => {
  it.each([false, true])(
    "shows both saved results with one session server: %s",
    (partialSession) => {
      const saved = project();
      render(page(saved, partialSession ? { alpha: saved.servers.alpha } : {}));

      expect(cards().getAllByRole("listitem")).toHaveLength(2);
      expect(
        cards().getByRole("button", { name: "Run alpha" }),
      ).toBeInTheDocument();
      expect(
        cards().getByRole("button", { name: "Run beta" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Run your first conformance check")).toBeNull();
      expect(mocks.ensureServersReady).not.toHaveBeenCalled();
    },
  );

  it("keeps saved cards after clearing the session and remounting", () => {
    const saved = project();
    render(page(saved, saved.servers)).unmount();
    render(page(saved));
    expect(cards().getAllByRole("listitem")).toHaveLength(2);
  });

  it("keeps the cards after visiting History and leaving the page", () => {
    render(page(project()));
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(cards().getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Leave Conformance" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Return to Conformance" }),
    );
    expect(cards().getAllByRole("listitem")).toHaveLength(2);
  });

  it("uses the new project's results even when session names overlap", () => {
    const first = project();
    const second = project("project_b", ["alpha", "gamma"]);
    second.runs.alpha = { ...second.runs.alpha, score: 25 };
    const view = render(page(first, first.servers));
    view.rerender(page(second, first.servers));

    expect(cards().getAllByRole("listitem")).toHaveLength(2);
    expect(cards().queryByRole("button", { name: "Run beta" })).toBeNull();
    expect(
      cards().getByRole("button", { name: "Run gamma" }),
    ).toBeInTheDocument();
    expect(cards().getByText("25%")).toBeInTheDocument();
  });

  it("shows the first-run state only when there are no saved runs", () => {
    const saved = project();
    saved.runs = {};
    render(page(saved));

    expect(
      screen.getByText("Run your first conformance check"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Run conformance checks" })[0],
    );
    fireEvent.click(screen.getByRole("button", { name: /^Choose the server/ }));
    const picker = within(screen.getByRole("dialog"));
    expect(picker.getByText("alpha", { exact: true })).toBeInTheDocument();
    expect(picker.getByText("beta", { exact: true })).toBeInTheDocument();
  });

  it("connects a disconnected saved server before starting its run", async () => {
    const saved = project();
    mocks.ensureServersReady.mockResolvedValue({
      readyServerNames: ["alpha"],
      reauthServerNames: [],
    });
    const view = render(page(saved));
    fireEvent.click(cards().getByRole("button", { name: "Run alpha" }));
    await waitFor(() =>
      expect(mocks.ensureServersReady).toHaveBeenCalledWith(["alpha"]),
    );
    expect(mocks.runAll).not.toHaveBeenCalled();

    saved.servers.alpha = {
      ...saved.servers.alpha,
      connectionStatus: "connected",
    };
    view.rerender(page(saved, { alpha: saved.servers.alpha }));
    await waitFor(() => expect(mocks.runAll).toHaveBeenCalledOnce());
  });

  it("edits a failed saved connection and keeps its snapshot during a rename", async () => {
    const saved = project();
    const view = render(page(saved));
    fireEvent.click(cards().getByRole("button", { name: "Run alpha" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit connection" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Connection settings" });
    expect(dialog).toHaveTextContent("alpha");
    expect(dialog).toHaveTextContent("Known servers: alpha, beta");

    saved.servers = { beta: saved.servers.beta };
    view.rerender(page(saved));
    expect(
      screen.getByRole("dialog", { name: "Connection settings" }),
    ).toHaveTextContent("alpha");
    expect(mocks.runAll).not.toHaveBeenCalled();
  });
});
