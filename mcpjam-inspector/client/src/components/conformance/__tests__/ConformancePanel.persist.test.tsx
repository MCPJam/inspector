import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerWithName } from "@/hooks/use-app-state";

const mockRunProtocol = vi.fn();
const mockRunApps = vi.fn();
const mockRunTasks = vi.fn();
const mockStartOAuth = vi.fn();

const { startRun, finalizeRun, cancelRun, navigate } = vi.hoisted(() => ({
  startRun: vi.fn().mockResolvedValue({ runId: "run_1" }),
  finalizeRun: vi.fn().mockResolvedValue({ runId: "run_1" }),
  cancelRun: vi.fn().mockResolvedValue({ cancelled: true }),
  navigate: vi.fn(),
}));

vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  useAppNavigate: () => navigate,
}));

vi.mock("@/lib/apis/mcp-conformance-api", () => ({
  runProtocolConformance: (...args: unknown[]) => mockRunProtocol(...args),
  runAppsConformance: (...args: unknown[]) => mockRunApps(...args),
  runTasksConformance: (...args: unknown[]) => mockRunTasks(...args),
  startOAuthConformance: (...args: unknown[]) => mockStartOAuth(...args),
  submitOAuthConformanceCode: vi.fn(),
  completeOAuthConformance: vi.fn(),
}));

vi.mock("@/components/oauth/utils", () => ({
  deriveOAuthProfileFromServer: () => ({
    serverUrl: "https://test.com",
    clientId: "",
    clientSecret: "",
    scopes: "",
    customHeaders: [],
    protocolVersion: "2025-11-25",
    registrationStrategy: "cimd",
  }),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: string) => {
    if (name === "conformanceRuns:startRun") return startRun;
    if (name === "conformanceRuns:finalizeRun") return finalizeRun;
    if (name === "conformanceRuns:cancelRun") return cancelRun;
    return vi.fn().mockResolvedValue(undefined);
  },
  useAction: () => vi.fn().mockResolvedValue(undefined),
}));

vi.mock(
  "@/components/conformance/directory-readiness/DirectoryReadinessSection",
  () => ({
    DirectoryReadinessSection: () => null,
  }),
);

import { ConformanceTab } from "../ConformancePanel";
import { RUN_LABEL } from "../ConformancePageChrome";

function createHttpServer(): ServerWithName {
  return {
    name: "http-server",
    lastConnectionTime: new Date(),
    connectionStatus: "connected",
    enabled: true,
    retryCount: 0,
    config: {
      url: "https://example.com/mcp",
      timeout: 30000,
    },
  };
}

function hang() {
  return new Promise(() => {});
}

describe("ConformanceTab persist", () => {
  beforeEach(() => {
    startRun.mockClear();
    finalizeRun.mockClear();
    cancelRun.mockClear();
    navigate.mockClear();
    mockRunProtocol.mockImplementation(hang);
    mockRunApps.mockImplementation(hang);
    mockRunTasks.mockImplementation(hang);
    mockStartOAuth.mockImplementation(hang);
  });

  it("does not create a Convex run on mount or remount", async () => {
    const persist = { projectId: "proj_1", serverId: "srv_1" };
    const { unmount } = render(
      <ConformanceTab server={createHttpServer()} persist={persist} />,
    );

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: RUN_LABEL })[0],
      ).toBeInTheDocument(),
    );
    expect(startRun).not.toHaveBeenCalled();

    unmount();
    render(<ConformanceTab server={createHttpServer()} persist={persist} />);

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: RUN_LABEL })[0],
      ).toBeInTheDocument(),
    );
    expect(startRun).not.toHaveBeenCalled();
  });

  it("creates one Convex run when the operator starts checks", async () => {
    const user = userEvent.setup();
    render(
      <ConformanceTab
        server={createHttpServer()}
        persist={{ projectId: "proj_1", serverId: "srv_1" }}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);

    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
  });

  it("cancels a run the page leaves before it finalizes", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <ConformanceTab
        server={createHttpServer()}
        persist={{ projectId: "proj_1", serverId: "srv_1" }}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));

    unmount();

    expect(cancelRun).toHaveBeenCalledWith({ runId: "run_1" });
    expect(finalizeRun).not.toHaveBeenCalled();
  });

  it("links a finished run to its saved page and does not cancel it on leave", async () => {
    const user = userEvent.setup();
    const base = {
      passed: true,
      outcome: "passed",
      serverUrl: "https://example.com/mcp",
      target: "https://example.com/mcp",
      summary: "ok",
      durationMs: 1,
      checks: [],
      categorySummary: {},
    };
    mockRunProtocol.mockResolvedValue({ success: true, result: base });
    mockRunApps.mockResolvedValue({
      success: true,
      result: {
        ...base,
        discovery: {
          toolCount: 0,
          uiToolCount: 0,
          listedResourceCount: 0,
          listedUiResourceCount: 0,
          checkedUiResourceCount: 0,
        },
      },
    });
    mockRunTasks.mockResolvedValue({
      success: true,
      result: {
        ...base,
        discovery: {
          protocolVersion: "2025-11-25",
          wire: "legacy",
          toolCount: 0,
          taskCapableToolCount: 0,
        },
      },
    });
    mockStartOAuth.mockResolvedValue({
      phase: "complete",
      result: {
        passed: true,
        outcome: "passed",
        protocolVersion: "2025-11-25",
        registrationStrategy: "cimd",
        serverUrl: "https://example.com/mcp",
        summary: "ok",
        durationMs: 1,
        steps: [],
      },
    });
    const { unmount } = render(
      <ConformanceTab
        server={createHttpServer()}
        persist={{ projectId: "proj_1", serverId: "srv_1" }}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);

    const link = await screen.findByRole("button", { name: "View saved run" });
    expect(finalizeRun).toHaveBeenCalledWith({ runId: "run_1" });
    await user.click(link);
    expect(navigate).toHaveBeenCalledWith(
      expect.stringContaining("/conformance/runs/run_1"),
    );

    unmount();
    expect(cancelRun).not.toHaveBeenCalled();
  });
});
